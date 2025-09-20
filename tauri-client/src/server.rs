use crate::audio::AudioManager;
#[cfg(target_os = "linux")]
use crate::mpris::MprisManager;
use crate::state::{AppState, PlaybackStatus, Track};
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Deserialize;
// Removed serde_json::Value - SSE provides complete data
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ServerClient {
    client: reqwest::Client,
}

impl ServerClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("MIU Player Tauri")
                .http1_only() // Force HTTP/1.1 for better SSE compatibility
                .build()
                .expect("Failed to create reqwest client"),
        }
    }

    // Removed get_status - SSE provides complete data

    pub fn spawn_background(
        self: Arc<Self>,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
    ) {
        tauri::async_runtime::spawn(async move {
            self.run_event_loop(state, audio, app_handle).await;
        });
    }

    async fn run_event_loop(
        self: Arc<Self>,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
    ) {
        let mut reconnect_attempts = 0;
        const MAX_RECONNECT_DELAY: u64 = 30; // Maximum delay of 30 seconds
        const INITIAL_RECONNECT_DELAY: u64 = 1; // Start with 1 second

        loop {
            let maybe_backend_url = {
                let guard = state.lock().await;
                guard.backend_url()
            };

            if let Some(backend_url) = maybe_backend_url {
                println!("SSE: Connection attempt {} to {}", reconnect_attempts + 1, backend_url);

                let result = self
                    .clone()
                    .establish_sse(
                        backend_url.clone(),
                        state.clone(),
                        audio.clone(),
                        app_handle.clone(),
                    )
                    .await;

                match result {
                    Ok(_) => {
                        println!("SSE: Connection closed normally, will reconnect");
                        reconnect_attempts = 0; // Reset on successful connection
                    },
                    Err(err) => {
                        reconnect_attempts += 1;
                        println!("SSE: Connection error (attempt {}): {}", reconnect_attempts, err);
                    }
                }

                // Exponential backoff with maximum delay
                let delay = std::cmp::min(
                    INITIAL_RECONNECT_DELAY * 2_u64.pow(reconnect_attempts.min(5)), // Cap at 2^5 = 32
                    MAX_RECONNECT_DELAY
                );

                println!("SSE: Reconnecting in {}s...", delay);
                tokio::time::sleep(Duration::from_secs(delay)).await;
            } else {
                // No backend URL configured, check again shortly
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    async fn establish_sse(
        self: Arc<Self>,
        backend_url: String,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
    ) -> Result<()> {
        let sse_url = format!("{}/api/music/state/live", backend_url);
        println!("SSE: Connecting to {}", sse_url);

        let response = self
            .client
            .get(&sse_url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("Connection", "keep-alive")
            .send()
            .await
            .map_err(|e| anyhow!("Failed to start SSE connection: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow!("SSE connection failed with status {}: {}",
                response.status().as_u16(),
                response.status().canonical_reason().unwrap_or("Unknown error")));
        }

        println!("SSE: Connection established successfully (status {})", response.status());

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        println!("SSE: Starting to read event stream...");
        let mut event_count = 0;

        while let Some(chunk) = stream.next().await {
            let data = chunk.map_err(|e| {
                println!("SSE: Chunk error: {}", e);
                anyhow!("SSE chunk error: {}", e)
            })?;

            let text = String::from_utf8_lossy(&data);
            buffer.push_str(&text.replace('\r', ""));

            while let Some(idx) = buffer.find("\n\n") {
                let event_block = buffer[..idx].to_string();
                buffer.drain(..idx + 2);
                event_count += 1;

                // Reduced verbosity - only log significant events
                if event_count % 10 == 1 || event_block.contains("currentTrack") {
                    println!("SSE: Processing event #{}", event_count);
                }

                let received_time = current_time_millis();
                if let Err(e) = self.clone()
                    .process_sse_block(
                        &event_block,
                        state.clone(),
                        audio.clone(),
                        app_handle.clone(),
                        &backend_url,
                        received_time,
                    )
                    .await {
                    println!("SSE: Error processing event: {}", e);
                }
            }
        }

        println!("SSE: Stream ended after {} events", event_count);
        Err(anyhow!("SSE connection closed"))
    }

    async fn process_sse_block(
        self: Arc<Self>,
        block: &str,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
        backend_url: &str,
        received_time_ms: f64,
    ) -> Result<()> {
        let mut event_type: Option<String> = None;
        let mut data_lines: Vec<String> = Vec::new();

        for line in block.lines() {
            if line.starts_with(':') || line.trim().is_empty() {
                continue;
            }

            if let Some(rest) = line.strip_prefix("event:") {
                event_type = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }

        let Some(event) = event_type else {
            println!("SSE: Received block without event type: {}", block);
            return Ok(());
        };

        let payload = data_lines.join("\n");

        // Log important events only
        match event.as_str() {
            "state" if payload.contains("currentTrack") => println!("SSE: Received state event with track data"),
            "sync_play" => println!("SSE: Received sync_play event"),
            "heartbeat" => {}, // Suppress heartbeat spam
            other if other != "state" => println!("SSE: Received '{}' event", other),
            _ => {}, // Suppress regular state events without track changes
        }

        self.handle_event(
            event,
            &payload,
            state,
            audio,
            app_handle,
            backend_url,
            received_time_ms,
        )
        .await
    }

    async fn handle_event(
        self: Arc<Self>,
        event: String,
        payload: &str,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
        backend_url: &str,
        received_time_ms: f64,
    ) -> Result<()> {
        match event.as_str() {
            "state" => {
                let data: StateEventPayload = serde_json::from_str(payload)
                    .map_err(|e| anyhow!("Failed to parse state event: {}", e))?;

                self.apply_state_event(data, state, audio, app_handle).await
            }
            "sync_play" => {
                let data: SyncPlayEventPayload = serde_json::from_str(payload)
                    .map_err(|e| anyhow!("Failed to parse sync_play event: {}", e))?;
                self.clone()
                    .handle_sync_play_event(
                        data,
                        state,
                        audio,
                        app_handle,
                        backend_url.to_string(),
                        received_time_ms,
                    )
                    .await
            }
            "heartbeat" => Ok(()),
            _other => Ok(()),
        }
    }

    async fn apply_state_event(
        &self,
        data: StateEventPayload,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
    ) -> Result<()> {
        let mut guard = state.lock().await;

        if let Some(status) = data.status {
            guard.update_server_status(status.clone());
            // Only sync player status if we're already playing, not on initial connection
            if !guard.user_paused && guard.player_status == PlaybackStatus::Playing {
                guard.update_player_status(PlaybackStatus::from_str(status));
            }
        }

        // Track change detection and handling
        let track_changed = if let Some(track) = data.current_track {
            let previous_track_id = guard.current_track.as_ref().map(|t| t.youtube_id.clone());
            let new_track_id = track.youtube_id.clone();
            let changed = guard.update_current_track(Some(track));

            if changed {
                println!("🎵 Track changed: {} → {}",
                    previous_track_id.as_deref().unwrap_or("None"),
                    new_track_id);
            }
            changed
        } else if guard.current_track.is_some() {
            println!("SSE: Track cleared (no current track)");
            guard.update_current_track(None);
            guard.clear_sync();
            true
        } else {
            false
        };

        // Store queue before moving for later use
        let queue_for_transition = data.queue.clone();
        guard.update_queue(data.queue);

        if let Some(position) = data.position {
            let duration = guard.current_track.as_ref().map(|t| t.duration);
            guard.update_sync(position, duration);

            // Update audio buffer with SSE position information
            let audio_clone = audio.clone();
            let position_for_audio = position;
            tokio::spawn(async move {
                let audio_manager = audio_clone.lock().await;
                if let Err(e) = audio_manager.update_from_sse(position_for_audio, None).await {
                    println!("SSE: Failed to update audio buffer with position: {}", e);
                }
            });
        }

        let snapshot = guard.snapshot();
        drop(guard);

        let _ = app_handle.emit("player_state_updated", snapshot);

        // If track changed, immediately start playback like the frontend does
        if track_changed {
            // Prepare buffer for track transition if we have queue information
            if let Some(next_track) = queue_for_transition.first() {
                let audio_clone = audio.clone();
                let backend_url_for_prep = state.lock().await.backend_url().unwrap_or_default();
                let next_track_id = next_track.youtube_id.clone();
                tokio::spawn(async move {
                    let audio_manager = audio_clone.lock().await;
                    let next_stream_url = format!("{}/api/music/stream?v={}", backend_url_for_prep, next_track_id);
                    if let Err(e) = audio_manager.prepare_track_transition(&next_stream_url, 0.0).await {
                        println!("SSE: Failed to prepare track transition: {}", e);
                    }
                });
            }
            // Get the backend URL and check if we should start playing
            let should_start_playback = {
                let guard = state.lock().await;
                // Only resume automatically if we were actively playing and the user
                // hasn't manually paused the client.
                guard.current_track.is_some()
                    && guard.player_status == PlaybackStatus::Playing
                    && !guard.user_paused
            };

            if should_start_playback {
                // Start playback immediately like the frontend does
                let self_clone = self.clone();
                let state_clone = state.clone();
                let app_handle_clone = app_handle.clone();

                tokio::spawn(async move {
                    match Arc::new(self_clone)
                        .sync_play_now(
                            state_clone.clone(),
                            audio.clone(),
                            app_handle_clone,
                            "".to_string(), // We'll get backend_url from state
                        )
                        .await
                    {
                        Ok(()) => {}
                        Err(_e) => {}
                    }
                });
            } else {
            }
        }

        Ok(())
    }

    async fn handle_sync_play_event(
        self: Arc<Self>,
        data: SyncPlayEventPayload,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
        backend_url: String,
        received_time_ms: f64,
    ) -> Result<()> {
        let track_id = match data.track_id {
            Some(id) if !id.is_empty() => id,
            _ => return Ok(()),
        };

        let position = data.position.unwrap_or(0.0);
        let server_time = data.server_time.unwrap_or(received_time_ms);
        let play_at = data.play_at.unwrap_or(received_time_ms);

        // Ensure we have fresh metadata for the announced track before we resume playback.
        // SSE state events provide complete metadata - no fallback needed
        let metadata_ready = {
            let guard = state.lock().await;
            guard
                .current_track
                .as_ref()
                .map(|track| track.youtube_id == track_id)
                .unwrap_or(false)
        };

        if !metadata_ready {
            let mut guard = state.lock().await;
            let placeholder_track = Track {
                youtube_id: track_id.clone(),
                title: "Loading track".to_string(),
                duration: 0.0,
                thumbnail: None,
                requested_by: None,
                channel_title: None,
                requested_at: None,
                is_autoplay: None,
            };

            guard.update_current_track(Some(placeholder_track));
            guard.clear_sync();
            let snapshot = guard.snapshot();
            drop(guard);
            let _ = app_handle.emit("player_state_updated", snapshot);
        }

        {
            let mut guard = state.lock().await;
            let duration = guard.current_track.as_ref().map(|t| t.duration);
            guard.update_sync(position, duration);
        }

        if {
            let guard = state.lock().await;
            guard.user_paused
        } {
            return Ok(());
        }

        // Track change validation - SSE state events are authoritative for metadata
        let needs_restart = {
            let guard = state.lock().await;
            match &guard.current_track {
                Some(current) if current.youtube_id == track_id => {
                    // Same track - check if we need to restart playback
                    guard.player_status != PlaybackStatus::Playing
                }
                Some(_current) => {
                    // Different track - always restart
                    true
                }
                None => {
                    // No current track - this shouldn't happen with sync_play
                    true
                }
            }
        };

        if !needs_restart {
            return Ok(());
        }

        let current_time = current_time_millis();
        let estimated_latency = 50.0; // milliseconds
        let server_buffer = play_at - server_time;
        let elapsed_since_received = current_time - received_time_ms;
        let mut time_until_play = server_buffer - elapsed_since_received - estimated_latency;

        // Update audio buffer with sync timing information for optimized buffering
        let audio_clone = audio.clone();
        let sync_position = position;
        let latency_estimate = estimated_latency;
        tokio::spawn(async move {
            let audio_manager = audio_clone.lock().await;
            if let Err(e) = audio_manager.update_from_sse(sync_position, Some(latency_estimate)).await {
                println!("SSE: Failed to update audio buffer for sync_play: {}", e);
            }
        });

        if !time_until_play.is_finite() {
            time_until_play = 0.0;
        }

        if time_until_play <= 0.0 {
            self.clone()
                .sync_play_now(state, audio, app_handle, backend_url.clone())
                .await
        } else {
            let backend_for_spawn = backend_url.clone();
            tokio::spawn({
                let client = self.clone();
                let state_clone = state.clone();
                let audio_clone = audio.clone();
                let app_handle_clone = app_handle.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(time_until_play as u64)).await;
                    if let Err(_err) = client
                        .sync_play_now(
                            state_clone,
                            audio_clone,
                            app_handle_clone,
                            backend_for_spawn,
                        )
                        .await
                    {}
                }
            });
            Ok(())
        }
    }

    async fn sync_play_now(
        self: Arc<Self>,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
        _backend_url: String,
    ) -> Result<()> {
        // Always stop current playback first to ensure clean restart
        {
            let audio_manager = audio.lock().await;
            audio_manager.stop().await.ok(); // Ignore errors from stopping
        }

        let (stream_url, playback_position, duration_opt, _track_info) = {
            let mut guard = state.lock().await;

            // Verify we have track metadata (should be from SSE state event)
            let current_track = guard.current_track.as_ref().ok_or_else(|| {
                anyhow!("No current track for sync_play - SSE state event missing?")
            })?;

            // Extract track info before mutable operations to avoid borrowing conflicts
            let track_info = format!("{} - {}", current_track.youtube_id, current_track.title);

            let stream_url = guard
                .stream_url()
                .ok_or_else(|| anyhow!("Server stream URL not configured"))?;
            let position = guard.computed_position();
            let duration = guard.duration();

            guard.update_player_status(PlaybackStatus::Playing);
            guard.set_user_paused(false);

            let duration_opt = if duration.is_finite() && duration > 0.0 {
                Some(duration)
            } else {
                None
            };
            (stream_url, position, duration_opt, track_info)
        };

        // Generate fresh stream URL with timestamp to bypass caching
        let ts_suffix = current_time_millis() as u128;
        let full_stream_url = format!("{}?ts={}", stream_url, ts_suffix);

        {
            let mut guard = state.lock().await;
            guard.prepare_sync_preview(playback_position, duration_opt);
            let snapshot = guard.snapshot();
            drop(guard);
            let _ = app_handle.emit("player_state_updated", snapshot);
        }

        let play_result = {
            let mut audio_manager = audio.lock().await;

            // Removed track end callback - track advancement is handled entirely by SSE events
            // The backend manages track timing and automatically broadcasts state changes
            println!("Audio: Track end handling delegated to SSE events from backend");

            let play_result = audio_manager
                .play_from(&full_stream_url, playback_position, duration_opt)
                .await;

            // Update buffer with current playback position for better sync after play starts
            if play_result.is_ok() {
                let audio_clone = audio.clone();
                let position_for_buffer = playback_position;
                tokio::spawn(async move {
                    let audio_manager = audio_clone.lock().await;
                    if let Err(e) = audio_manager.update_from_sse(position_for_buffer, None).await {
                        println!("Audio: Failed to update buffer on playback start: {}", e);
                    }
                });
            }

            play_result
        };

        if let Err(play_err) = play_result {
            let mut guard = state.lock().await;
            guard.update_player_status(PlaybackStatus::Stopped);
            guard.clear_sync();
            let snapshot = guard.snapshot();
            drop(guard);
            let _ = app_handle.emit("player_state_updated", snapshot);

            return Err(play_err);
        }

        {
            let mut guard = state.lock().await;
            guard.update_player_status(PlaybackStatus::Playing);
            guard.set_user_paused(false);
            guard.update_sync(playback_position, duration_opt);
            let snapshot = guard.snapshot();
            #[cfg(target_os = "linux")]
            let backend_url = guard.backend_url();
            drop(guard);
            let _ = app_handle.emit("player_state_updated", snapshot.clone());

            // Update MPRIS with final playing state
            #[cfg(target_os = "linux")]
            if let Some(mpris) = app_handle.try_state::<MprisManager>() {
                if let Err(e) = mpris.update_playback_status(PlaybackStatus::Playing).await {
                    println!("Failed to update MPRIS playing status: {}", e);
                }
                if let Some(track) = snapshot.current_track.as_ref() {
                    let track_data = Track {
                        youtube_id: track.youtube_id.clone(),
                        title: track.title.clone(),
                        duration: track.duration,
                        thumbnail: track.thumbnail.clone(),
                        requested_by: track.requested_by.clone(),
                        channel_title: track.channel_title.clone(),
                        requested_at: track.requested_at.clone(),
                        is_autoplay: Some(track.is_autoplay),
                    };
                    if let Err(e) = mpris
                        .update_metadata(&track_data, backend_url.as_deref())
                        .await
                    {
                        println!("Failed to update MPRIS metadata: {}", e);
                    }
                }
                if let Err(e) = mpris.update_position(playback_position).await {
                    println!("Failed to update MPRIS position: {}", e);
                }
            }
        }

        Ok(())
    }

    pub async fn resume_playback(
        self: Arc<Self>,
        state: Arc<Mutex<AppState>>,
        audio: Arc<Mutex<AudioManager>>,
        app_handle: AppHandle,
    ) -> Result<()> {
        let backend_url = {
            let guard = state.lock().await;
            guard
                .backend_url()
                .ok_or_else(|| anyhow!("Server URL not configured"))?
        };

        self.clone()
            .sync_play_now(state, audio, app_handle, backend_url)
            .await
    }

    // Removed fetch_and_apply_status - SSE provides complete initial state and real-time updates

    // Removed ensure_track_metadata - SSE state events provide complete metadata
}

#[derive(Debug, Deserialize)]
struct StateEventPayload {
    status: Option<String>,
    #[serde(rename = "currentTrack")]
    current_track: Option<Track>,
    #[serde(default)]
    queue: Vec<Track>,
    position: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct SyncPlayEventPayload {
    #[serde(rename = "trackId")]
    track_id: Option<String>,
    position: Option<f64>,
    #[serde(rename = "serverTime")]
    server_time: Option<f64>,
    #[serde(rename = "playAt")]
    play_at: Option<f64>,
}

// Removed MinimalStatus struct - SSE provides complete data

fn current_time_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// Removed tests for MinimalStatus - SSE provides complete data

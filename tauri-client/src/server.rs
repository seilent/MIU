use crate::audio::AudioManager;
use crate::state::{AppState, PlaybackStatus, Track};
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
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
                .build()
                .expect("Failed to create reqwest client"),
        }
    }

    pub async fn get_status(&self, backend_url: &str) -> Result<Value> {
        let url = format!("{}/api/music/minimal-status", backend_url);
        println!("Requesting minimal status from {}", url);
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| anyhow!("Failed to fetch status: {}", e))?;

        if !response.status().is_success() {
            println!("Status request failed with HTTP {}", response.status());
            return Err(anyhow!("Status request failed with {}", response.status()));
        }

        let data = response
            .json::<Value>()
            .await
            .map_err(|e| anyhow!("Failed to parse status JSON: {}", e))?;
        println!("Received minimal status payload: {}", data);

        Ok(data)
    }

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
        loop {
            let maybe_backend_url = {
                let guard = state.lock().await;
                guard.backend_url()
            };

            if let Some(backend_url) = maybe_backend_url {
                let result = self
                    .clone()
                    .establish_sse(
                        backend_url.clone(),
                        state.clone(),
                        audio.clone(),
                        app_handle.clone(),
                    )
                    .await;

                if let Err(err) = result {
                    eprintln!("SSE connection error: {}", err);
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            } else {
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

        println!("Opening SSE connection to {}", sse_url);
        let response = self
            .client
            .get(&sse_url)
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| anyhow!("Failed to start SSE connection: {}", e))?;

        println!("SSE response status: {}", response.status());
        if !response.status().is_success() {
            return Err(anyhow!("SSE connection failed with {}", response.status()));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let data = chunk.map_err(|e| anyhow!("SSE chunk error: {}", e))?;
            let text = String::from_utf8_lossy(&data);
            buffer.push_str(&text.replace('\r', ""));

            while let Some(idx) = buffer.find("\n\n") {
                let event_block = buffer[..idx].to_string();
                buffer.drain(..idx + 2);
                let received_time = current_time_millis();
                self.clone()
                    .process_sse_block(
                        &event_block,
                        state.clone(),
                        audio.clone(),
                        app_handle.clone(),
                        &backend_url,
                        received_time,
                    )
                    .await?;
            }
        }

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
            return Ok(());
        };

        let payload = data_lines.join("\n");
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
                println!("SSE event: state");
                let data: StateEventPayload = serde_json::from_str(payload)
                    .map_err(|e| anyhow!("Failed to parse state event: {}", e))?;
                self.apply_state_event(data, state, app_handle).await
            }
            "sync_play" => {
                println!("SSE event: sync_play -> payload {}", payload);
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
            other => {
                eprintln!("Unhandled SSE event: {}", other);
                Ok(())
            }
        }
    }

    async fn apply_state_event(
        &self,
        data: StateEventPayload,
        state: Arc<Mutex<AppState>>,
        app_handle: AppHandle,
    ) -> Result<()> {
        let mut guard = state.lock().await;

        if let Some(status) = data.status {
            guard.update_server_status(status.clone());
            if !guard.user_paused {
                guard.update_player_status(PlaybackStatus::from_str(status));
            }
        }

        if let Some(track) = data.current_track {
            guard.update_current_track(Some(track));
        } else if guard.current_track.is_some() {
            guard.update_current_track(None);
            guard.clear_sync();
        }

        guard.update_queue(data.queue);

        if let Some(position) = data.position {
            let duration = guard.current_track.as_ref().map(|t| t.duration);
            guard.update_sync(position, duration);
        }

        let snapshot = guard.snapshot();
        drop(guard);

        let _ = app_handle.emit("player_state_updated", snapshot);
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

        // Ensure we have the correct track cached
        if {
            let guard = state.lock().await;
            guard
                .current_track
                .as_ref()
                .map(|track| track.youtube_id != track_id)
                .unwrap_or(true)
        } {
            self.fetch_and_apply_status(&backend_url, state.clone(), app_handle.clone())
                .await
                .ok();
        }

        let current_time = current_time_millis();
        let estimated_latency = 50.0; // milliseconds
        let server_buffer = play_at - server_time;
        let elapsed_since_received = current_time - received_time_ms;
        let mut time_until_play = server_buffer - elapsed_since_received - estimated_latency;

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
                    if let Err(err) = client
                        .sync_play_now(
                            state_clone,
                            audio_clone,
                            app_handle_clone,
                            backend_for_spawn,
                        )
                        .await
                    {
                        eprintln!("Synchronized playback failed: {}", err);
                    }
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
        backend_url: String,
    ) -> Result<()> {
        // Make sure current track metadata is present
        self.ensure_track_metadata(&backend_url, state.clone(), app_handle.clone())
            .await
            .ok();

        let (stream_url, playback_position, duration) = {
            let mut guard = state.lock().await;
            let stream_url = guard
                .stream_url()
                .ok_or_else(|| anyhow!("Server stream URL not configured"))?;
            let position = guard.computed_position();
            let duration = guard.duration();
            guard.update_player_status(PlaybackStatus::Playing);
            guard.set_user_paused(false);
            (stream_url, position, duration)
        };

        let ts_suffix = current_time_millis() as u128;
        let full_stream_url = format!("{}?ts={}", stream_url, ts_suffix);
        println!(
            "Starting playback from {} at position {:.2}s (duration {:.2}s)",
            full_stream_url, playback_position, duration
        );

        {
            let mut audio_manager = audio.lock().await;
            audio_manager
                .play_from(&full_stream_url, playback_position)
                .await?;
        }

        {
            let mut guard = state.lock().await;
            guard.update_player_status(PlaybackStatus::Playing);
            guard.set_user_paused(false);
            guard.update_sync(playback_position, Some(duration));
        }

        let snapshot = {
            let guard = state.lock().await;
            guard.snapshot()
        };

        let _ = app_handle.emit("player_state_updated", snapshot);
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

    pub async fn fetch_and_apply_status(
        &self,
        backend_url: &str,
        state: Arc<Mutex<AppState>>,
        app_handle: AppHandle,
    ) -> Result<()> {
        let payload = self.get_status(backend_url).await?;
        let status: MinimalStatus = serde_json::from_value(payload)?;
        println!(
            "Fetched status from {}: status={}, track_present={}",
            backend_url,
            status.status,
            status.track.is_some()
        );

        let mut guard = state.lock().await;
        guard.update_server_status(&status.status);
        if !guard.user_paused {
            guard.update_player_status(PlaybackStatus::from_str(&status.status));
        }

        if let Some(track) = status.track {
            guard.update_current_track(Some(track));
        } else {
            guard.update_current_track(None);
            guard.clear_sync();
        }

        if let Some(position) = status.position {
            let duration = guard.current_track.as_ref().map(|t| t.duration);
            guard.update_sync(position, duration);
        }

        guard.update_queue(Vec::new());

        let snapshot = guard.snapshot();
        drop(guard);

        println!(
            "Emitted player snapshot: status={:?}, track_present={}, position={:.2}, volume={:.2}",
            snapshot.player_status,
            snapshot.current_track.is_some(),
            snapshot.position,
            snapshot.volume
        );
        let _ = app_handle.emit("player_state_updated", snapshot.clone());
        Ok(())
    }

    async fn ensure_track_metadata(
        &self,
        backend_url: &str,
        state: Arc<Mutex<AppState>>,
        app_handle: AppHandle,
    ) -> Result<()> {
        let needs_refresh = {
            let guard = state.lock().await;
            guard.current_track.is_none()
        };

        if needs_refresh {
            self.fetch_and_apply_status(backend_url, state, app_handle)
                .await?
        }

        Ok(())
    }
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

#[derive(Debug, Deserialize)]
struct MinimalStatus {
    status: String,
    track: Option<Track>,
    position: Option<f64>,
}

fn current_time_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_status_parses_sample_payload() {
        let json = r#"{
            "status": "playing",
            "track": {
                "youtubeId": "G2NdmbXG6w4",
                "title": "Fragment",
                "thumbnail": "undefined/api/albumart/G2NdmbXG6w4",
                "duration": 323,
                "requestedBy": {
                    "id": "398152425212739584",
                    "username": "MIU",
                    "avatar": "fba71bb1a77141401de7366bf6174ff8"
                }
            },
            "position": 213.68,
            "timestamp": 1758133265949,
            "activeClients": 0
        }"#;

        let status: MinimalStatus = serde_json::from_str(json).expect("should parse");
        assert_eq!(status.status, "playing");
        let track = status.track.expect("track present");
        assert_eq!(track.youtube_id, "G2NdmbXG6w4");
        assert!(track.thumbnail.is_some());
        assert_eq!(track.duration, 323.0);
        let requester = track.requested_by.expect("requested by present");
        assert_eq!(requester.username, "MIU");
        assert_eq!(status.position.unwrap(), 213.68);
    }
}

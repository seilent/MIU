#[cfg(target_os = "linux")]
use crate::state::{AppState, PlaybackStatus as AppPlaybackStatus};
#[cfg(target_os = "linux")]
use mpris_server::zbus::fdo;
#[cfg(target_os = "linux")]
use mpris_server::{
    LoopStatus, Metadata, PlaybackStatus, PlayerInterface, Property, RootInterface, Server, Signal,
    Time, TrackId, Volume,
};
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "linux")]
use tokio::sync::Mutex;

#[cfg(target_os = "linux")]
pub struct MprisManager {
    server: Server<MprisPlayer>,
}

#[cfg(target_os = "linux")]
pub struct MprisPlayer {
    state: Arc<Mutex<AppState>>,
    app_handle: AppHandle,
}

#[cfg(target_os = "linux")]
impl MprisManager {
    pub async fn new(state: Arc<Mutex<AppState>>, app_handle: AppHandle) -> Result<Self, String> {
        let mpris_player = MprisPlayer {
            state: state.clone(),
            app_handle,
        };

        let server = Server::new("org.mpris.MediaPlayer2.MIU", mpris_player)
            .await
            .map_err(|e| format!("Failed to create MPRIS server: {}", e))?;
        // Server runs automatically in the background

        Ok(Self { server })
    }

    pub async fn update_metadata(
        &self,
        track: &crate::state::Track,
        backend_url: Option<&str>,
    ) -> Result<(), String> {
        let mut metadata = Metadata::builder();

        metadata = metadata.title(&track.title);

        if let Some(ref requested_by) = track.requested_by {
            metadata = metadata.artist(vec![requested_by.username.as_str()]);
        }

        if let Some(ref channel_title) = track.channel_title {
            metadata = metadata.album(channel_title);
        }

        metadata = metadata.length(Time::from_secs(track.duration as i64));

        if !track.youtube_id.is_empty() {
            if let Some(backend_url) = backend_url {
                // Use backend API with square parameter for reliable album art, matching frontend approach
                metadata = metadata.art_url(format!(
                    "{}/api/albumart/{}?square=1",
                    backend_url, track.youtube_id
                ));
            } else {
                // Fallback to YouTube thumbnail if no backend URL
                metadata = metadata.art_url(format!(
                    "https://img.youtube.com/vi/{}/maxresdefault.jpg",
                    track.youtube_id
                ));
            }
        }

        let metadata = metadata.build();

        self.server
            .properties_changed([Property::Metadata(metadata)])
            .await
            .map_err(|e| format!("Failed to update MPRIS metadata: {}", e))
    }

    pub async fn update_playback_status(
        &self,
        app_status: AppPlaybackStatus,
    ) -> Result<(), String> {
        let status = match app_status {
            AppPlaybackStatus::Playing => PlaybackStatus::Playing,
            AppPlaybackStatus::Paused => PlaybackStatus::Paused,
            AppPlaybackStatus::Stopped => PlaybackStatus::Stopped,
        };

        self.server
            .properties_changed([Property::PlaybackStatus(status)])
            .await
            .map_err(|e| format!("Failed to update MPRIS playback status: {}", e))
    }

    pub async fn update_position(&self, position: f64) -> Result<(), String> {
        let position_time = Time::from_micros((position * 1_000_000.0) as i64);
        self.server
            .emit(Signal::Seeked {
                position: position_time,
            })
            .await
            .map_err(|e| format!("Failed to update MPRIS position: {}", e))
    }

    pub async fn update_volume(&self, volume: f32) -> Result<(), String> {
        self.server
            .properties_changed([Property::Volume(volume as Volume)])
            .await
            .map_err(|e| format!("Failed to update MPRIS volume: {}", e))
    }
}

#[cfg(target_os = "linux")]
impl RootInterface for MprisPlayer {
    async fn identity(&self) -> fdo::Result<String> {
        Ok("MIU Player".to_string())
    }

    async fn desktop_entry(&self) -> fdo::Result<String> {
        Ok("miu-player".to_string())
    }

    async fn supported_uri_schemes(&self) -> fdo::Result<Vec<String>> {
        Ok(vec!["https".to_string(), "http".to_string()])
    }

    async fn supported_mime_types(&self) -> fdo::Result<Vec<String>> {
        Ok(vec!["audio/mpeg".to_string(), "audio/mp4".to_string()])
    }

    async fn can_quit(&self) -> fdo::Result<bool> {
        Ok(true)
    }

    async fn can_raise(&self) -> fdo::Result<bool> {
        Ok(true)
    }

    async fn can_set_fullscreen(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn has_track_list(&self) -> fdo::Result<bool> {
        Ok(true)
    }

    async fn quit(&self) -> fdo::Result<()> {
        println!("MPRIS: Quit requested");
        // TODO: Implement quit functionality
        Ok(())
    }

    async fn raise(&self) -> fdo::Result<()> {
        println!("MPRIS: Raise requested");
        // TODO: Implement window raising
        Ok(())
    }

    async fn fullscreen(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn set_fullscreen(&self, _fullscreen: bool) -> mpris_server::zbus::Result<()> {
        println!("MPRIS: Set fullscreen requested (not supported)");
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl PlayerInterface for MprisPlayer {
    async fn can_go_next(&self) -> fdo::Result<bool> {
        let state = self.state.lock().await;
        Ok(!state.queue.is_empty())
    }

    async fn can_go_previous(&self) -> fdo::Result<bool> {
        Ok(false) // We don't support previous for now
    }

    async fn can_play(&self) -> fdo::Result<bool> {
        let state = self.state.lock().await;
        Ok(state.current_track.is_some())
    }

    async fn can_pause(&self) -> fdo::Result<bool> {
        let state = self.state.lock().await;
        Ok(state.current_track.is_some())
    }

    async fn can_seek(&self) -> fdo::Result<bool> {
        Ok(true)
    }

    async fn can_control(&self) -> fdo::Result<bool> {
        Ok(true)
    }

    async fn playback_status(&self) -> fdo::Result<PlaybackStatus> {
        let state = self.state.lock().await;
        Ok(match state.player_status {
            AppPlaybackStatus::Playing => PlaybackStatus::Playing,
            AppPlaybackStatus::Paused => PlaybackStatus::Paused,
            AppPlaybackStatus::Stopped => PlaybackStatus::Stopped,
        })
    }

    async fn loop_status(&self) -> fdo::Result<LoopStatus> {
        Ok(LoopStatus::None)
    }

    async fn shuffle(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn volume(&self) -> fdo::Result<Volume> {
        let state = self.state.lock().await;
        Ok(state.volume as Volume)
    }

    async fn position(&self) -> fdo::Result<Time> {
        let state = self.state.lock().await;
        Ok(Time::from_micros(
            (state.computed_position() * 1_000_000.0) as i64,
        ))
    }

    async fn minimum_rate(&self) -> fdo::Result<f64> {
        Ok(1.0)
    }

    async fn maximum_rate(&self) -> fdo::Result<f64> {
        Ok(1.0)
    }

    async fn rate(&self) -> fdo::Result<f64> {
        Ok(1.0)
    }

    async fn metadata(&self) -> fdo::Result<Metadata> {
        let state = self.state.lock().await;
        if let Some(ref track) = state.current_track {
            let mut metadata = Metadata::builder();

            metadata = metadata.title(&track.title);

            if let Some(ref requested_by) = track.requested_by {
                metadata = metadata.artist(vec![requested_by.username.as_str()]);
            }

            if let Some(ref channel_title) = track.channel_title {
                metadata = metadata.album(channel_title);
            }

            metadata = metadata.length(Time::from_secs(track.duration as i64));

            if !track.youtube_id.is_empty() {
                if let Some(backend_url) = state.backend_url() {
                    // Use backend API with square parameter for reliable album art, matching frontend approach
                    metadata = metadata.art_url(format!(
                        "{}/api/albumart/{}?square=1",
                        backend_url, track.youtube_id
                    ));
                } else {
                    // Fallback to YouTube thumbnail if no backend URL
                    metadata = metadata.art_url(format!(
                        "https://img.youtube.com/vi/{}/maxresdefault.jpg",
                        track.youtube_id
                    ));
                }
            }

            Ok(metadata.build())
        } else {
            Ok(Metadata::new())
        }
    }

    async fn play(&self) -> fdo::Result<()> {
        println!("MPRIS: Play requested");
        // Trigger the actual play_pause command through Tauri
        if let Err(e) = self.app_handle.emit("mpris_play_pause", ()) {
            println!("Failed to emit MPRIS play command: {}", e);
        }
        Ok(())
    }

    async fn pause(&self) -> fdo::Result<()> {
        println!("MPRIS: Pause requested");
        // Trigger the actual play_pause command through Tauri
        if let Err(e) = self.app_handle.emit("mpris_play_pause", ()) {
            println!("Failed to emit MPRIS pause command: {}", e);
        }
        Ok(())
    }

    async fn play_pause(&self) -> fdo::Result<()> {
        println!("MPRIS: Play/Pause toggle requested");
        // Trigger the actual play_pause command through Tauri
        if let Err(e) = self.app_handle.emit("mpris_play_pause", ()) {
            println!("Failed to emit MPRIS play_pause command: {}", e);
        }
        Ok(())
    }

    async fn stop(&self) -> fdo::Result<()> {
        println!("MPRIS: Stop requested");
        let mut state = self.state.lock().await;
        state.set_user_paused(true);
        state.update_player_status(AppPlaybackStatus::Stopped);
        Ok(())
    }

    async fn next(&self) -> fdo::Result<()> {
        println!("MPRIS: Next requested (not implemented)");
        // TODO: Implement next track functionality
        Ok(())
    }

    async fn previous(&self) -> fdo::Result<()> {
        println!("MPRIS: Previous requested (not implemented)");
        // TODO: Implement previous track functionality
        Ok(())
    }

    async fn seek(&self, offset: Time) -> fdo::Result<()> {
        println!("MPRIS: Seek requested: {} microseconds", offset.as_micros());
        let mut state = self.state.lock().await;
        let current_pos = state.computed_position();
        let duration = state.duration();
        let new_pos = (current_pos + (offset.as_micros() as f64 / 1_000_000.0)).max(0.0);
        state.update_sync(new_pos, Some(duration));
        Ok(())
    }

    async fn set_position(&self, _track_id: TrackId, position: Time) -> fdo::Result<()> {
        println!(
            "MPRIS: Set position requested: {} microseconds",
            position.as_micros()
        );
        let mut state = self.state.lock().await;
        let duration = state.duration();
        state.update_sync(position.as_micros() as f64 / 1_000_000.0, Some(duration));
        Ok(())
    }

    async fn open_uri(&self, _uri: String) -> fdo::Result<()> {
        println!("MPRIS: Open URI requested (not implemented)");
        // TODO: Implement URI opening functionality
        Ok(())
    }

    async fn set_loop_status(&self, _loop_status: LoopStatus) -> mpris_server::zbus::Result<()> {
        println!("MPRIS: Set loop status requested (not implemented)");
        // TODO: Implement loop status setting
        Ok(())
    }

    async fn set_rate(&self, _rate: f64) -> mpris_server::zbus::Result<()> {
        println!("MPRIS: Set rate requested (not implemented)");
        // Rate changes not supported
        Ok(())
    }

    async fn set_shuffle(&self, _shuffle: bool) -> mpris_server::zbus::Result<()> {
        println!("MPRIS: Set shuffle requested (not implemented)");
        // TODO: Implement shuffle setting
        Ok(())
    }

    async fn set_volume(&self, volume: Volume) -> mpris_server::zbus::Result<()> {
        println!("MPRIS: Set volume requested: {}", volume);
        // Trigger the actual volume change through Tauri
        if let Err(e) = self.app_handle.emit("mpris_volume_change", volume as f32) {
            println!("Failed to emit MPRIS volume command: {}", e);
        }
        Ok(())
    }
}

// Stub implementations for non-Linux platforms
#[cfg(not(target_os = "linux"))]
pub struct MprisManager;

#[cfg(not(target_os = "linux"))]
impl MprisManager {
    pub async fn new(_state: Arc<Mutex<AppState>>) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self)
    }

    pub async fn update_metadata(&self, _track: &Track) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    pub async fn update_playback_status(
        &self,
        _is_playing: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    pub async fn update_position(&self, _position: f64) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    pub async fn update_volume(&self, _volume: f32) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
}

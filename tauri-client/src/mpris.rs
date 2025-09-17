#[cfg(target_os = "linux")]
use crate::state::{AppState, Track};
#[cfg(target_os = "linux")]
use mpris_server::{Metadata, Player, LocalPlayerInterface, PlaybackStatus};
#[cfg(target_os = "linux")]
use mpris_server::zbus::fdo;
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use tokio::sync::Mutex;

#[cfg(target_os = "linux")]
pub struct MprisManager {
    player: Player,
    state: Arc<Mutex<AppState>>,
}

#[cfg(target_os = "linux")]
impl MprisManager {
    pub async fn new(state: Arc<Mutex<AppState>>) -> Result<Self, Box<dyn std::error::Error>> {
        let player = Player::builder("MIU Player")
            .identity("miu-player")
            .desktop_entry("miu-player")
            .can_play(true)
            .can_pause(true)
            .can_go_next(false)
            .can_go_previous(false)
            .can_seek(false)
            .can_set_fullscreen(false)
            .can_raise(true)
            .can_quit(true)
            .build().await?;

        Ok(Self { player, state })
    }

    pub async fn update_metadata(&self, track: &Track) -> Result<(), Box<dyn std::error::Error>> {
        let mut metadata = Metadata::new();

        metadata.set_title(Some(track.title.clone()));

        if let Some(ref requested_by) = track.requested_by {
            metadata.set_artist(vec![requested_by.username.clone()]);
        }

        if let Some(ref channel_title) = track.channel_title {
            metadata.set_album(Some(channel_title.clone()));
        }

        // Set track length in microseconds
        let length_microseconds = (track.duration * 1_000_000.0) as i64;
        metadata.set_length(Some(length_microseconds));

        // Set track ID
        metadata.set_track_id(format!("miu-track-{}", track.youtube_id));

        // Set album art URL if available
        if !track.youtube_id.is_empty() {
            let art_url = format!("https://img.youtube.com/vi/{}/maxresdefault.jpg", track.youtube_id);
            metadata.set_art_url(Some(art_url));
        }

        self.player.set_metadata(metadata).await?;
        Ok(())
    }

    pub async fn update_playback_status(&self, is_playing: bool) -> Result<(), Box<dyn std::error::Error>> {
        let status = if is_playing {
            PlaybackStatus::Playing
        } else {
            PlaybackStatus::Paused
        };

        self.player.set_playback_status(status).await?;
        Ok(())
    }

    pub async fn update_position(&self, position: f64) -> Result<(), Box<dyn std::error::Error>> {
        let position_microseconds = std::time::Duration::from_micros((position * 1_000_000.0) as u64);
        self.player.set_position(position_microseconds);
        Ok(())
    }

    pub async fn update_volume(&self, volume: f32) -> Result<(), Box<dyn std::error::Error>> {
        self.player.set_volume(volume as f64).await?;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl LocalPlayerInterface for MprisManager {
    async fn play(&self) -> fdo::Result<()> {
        println!("MPRIS: Play requested");
        // Trigger play via state update
        let mut state = self.state.lock().await;
        state.set_playing(true);
        Ok(())
    }

    async fn pause(&self) -> fdo::Result<()> {
        println!("MPRIS: Pause requested");
        // Trigger pause via state update
        let mut state = self.state.lock().await;
        state.set_playing(false);
        Ok(())
    }

    async fn play_pause(&self) -> fdo::Result<()> {
        println!("MPRIS: Play/Pause toggle requested");
        let mut state = self.state.lock().await;
        state.set_playing(!state.is_playing);
        Ok(())
    }

    async fn stop(&self) -> fdo::Result<()> {
        println!("MPRIS: Stop requested");
        let mut state = self.state.lock().await;
        state.set_playing(false);
        Ok(())
    }

    async fn next(&self) -> fdo::Result<()> {
        println!("MPRIS: Next requested (not implemented)");
        Ok(())
    }

    async fn previous(&self) -> fdo::Result<()> {
        println!("MPRIS: Previous requested (not implemented)");
        Ok(())
    }

    async fn seek(&self, _offset: i64) -> fdo::Result<()> {
        println!("MPRIS: Seek requested (not implemented)");
        Ok(())
    }

    async fn set_position(&self, _track_id: &str, position: i64) -> fdo::Result<()> {
        println!("MPRIS: Set position requested: {} microseconds", position);
        let position_seconds = position as f64 / 1_000_000.0;
        let mut state = self.state.lock().await;
        state.set_position(position_seconds);
        Ok(())
    }

    async fn open_uri(&self, _uri: &str) -> fdo::Result<()> {
        println!("MPRIS: Open URI requested (not implemented)");
        Ok(())
    }

    async fn set_loop_status(&self, _loop_status: mpris_server::LoopStatus) -> fdo::Result<()> {
        println!("MPRIS: Set loop status requested (not implemented)");
        Ok(())
    }

    async fn set_rate(&self, _rate: f64) -> fdo::Result<()> {
        println!("MPRIS: Set rate requested (not implemented)");
        Ok(())
    }

    async fn set_shuffle(&self, _shuffle: bool) -> fdo::Result<()> {
        println!("MPRIS: Set shuffle requested (not implemented)");
        Ok(())
    }

    async fn set_volume(&self, volume: f64) -> fdo::Result<()> {
        println!("MPRIS: Set volume requested: {}", volume);
        let mut state = self.state.lock().await;
        state.set_volume(volume as f32);
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

    pub async fn update_playback_status(&self, _is_playing: bool) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    pub async fn update_position(&self, _position: f64) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    pub async fn update_volume(&self, _volume: f32) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
}
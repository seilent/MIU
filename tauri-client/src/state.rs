use serde::{Deserialize, Serialize};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedBy {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    #[serde(rename = "youtubeId")]
    pub youtube_id: String,
    pub title: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(rename = "requestedBy", default)]
    pub requested_by: Option<RequestedBy>,
    #[serde(rename = "channelTitle", default)]
    pub channel_title: Option<String>,
    #[serde(rename = "requestedAt", default)]
    pub requested_at: Option<String>,
    #[serde(rename = "isAutoplay", default)]
    pub is_autoplay: Option<bool>,
}

impl Track {
    pub fn as_view(&self, server_url: Option<&str>) -> TrackView {
        let mut album_art_url = server_url.map(|base| {
            format!(
                "{}/backend/api/albumart/{}",
                base.trim_end_matches('/'),
                self.youtube_id
            )
        });

        if album_art_url.is_none() {
            album_art_url = self
                .thumbnail
                .as_ref()
                .map(|thumb| thumb.trim().to_string())
                .filter(|thumb| !thumb.is_empty());
        }

        TrackView {
            youtube_id: self.youtube_id.clone(),
            title: self.title.clone(),
            duration: self.duration,
            thumbnail: self.thumbnail.clone(),
            album_art_url,
            requested_by: self.requested_by.clone(),
            requested_at: self.requested_at.clone(),
            is_autoplay: self.is_autoplay.unwrap_or(false),
            channel_title: self.channel_title.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackView {
    #[serde(rename = "youtubeId")]
    pub youtube_id: String,
    pub title: String,
    pub duration: f64,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub album_art_url: Option<String>,
    #[serde(default)]
    pub requested_by: Option<RequestedBy>,
    #[serde(default)]
    pub requested_at: Option<String>,
    #[serde(default)]
    pub is_autoplay: bool,
    #[serde(default)]
    pub channel_title: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
}

impl Default for PlaybackStatus {
    fn default() -> Self {
        PlaybackStatus::Stopped
    }
}

impl PlaybackStatus {
    pub fn from_str<S: AsRef<str>>(value: S) -> Self {
        match value.as_ref().trim().to_lowercase().as_str() {
            "playing" => PlaybackStatus::Playing,
            "paused" => PlaybackStatus::Paused,
            _ => PlaybackStatus::Stopped,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub connected: bool,
    pub server_url: Option<String>,
    pub stream_url: Option<String>,
    pub player_status: PlaybackStatus,
    pub server_status: PlaybackStatus,
    pub is_playing: bool,
    pub user_paused: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f32,
    pub current_track: Option<TrackView>,
    pub queue: Vec<TrackView>,
    pub last_sync_timestamp: Option<u128>,
}

pub struct AppState {
    server_url: Option<String>,
    backend_url: Option<String>,
    stream_url: Option<String>,
    pub current_track: Option<Track>,
    pub queue: Vec<Track>,
    pub server_status: PlaybackStatus,
    pub player_status: PlaybackStatus,
    pub volume: f32,
    pub user_paused: bool,
    synced_position: f64,
    track_duration: f64,
    last_sync_instant: Option<Instant>,
    last_sync_wallclock: Option<SystemTime>,
    last_track_id: Option<String>,
}

impl AppState {
    pub fn new() -> Self {
        Self::new_with_volume(0.8) // Default volume if config loading fails
    }

    pub fn new_with_volume(volume: f32) -> Self {
        Self {
            server_url: None,
            stream_url: None,
            current_track: None,
            queue: Vec::new(),
            server_status: PlaybackStatus::Stopped,
            player_status: PlaybackStatus::Stopped,
            volume: volume.clamp(0.0, 1.0),
            user_paused: false,
            synced_position: 0.0,
            track_duration: 0.0,
            last_sync_instant: None,
            last_sync_wallclock: None,
            last_track_id: None,
            backend_url: None,
        }
    }

    pub fn backend_url(&self) -> Option<String> {
        self.backend_url.clone()
    }

    pub fn stream_url(&self) -> Option<String> {
        self.stream_url.clone()
    }

    pub fn set_server_url(&mut self, url: String) {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        if trimmed.is_empty() {
            return;
        }

        let (mut root, backend_base) = if let Some(stripped) = trimmed.strip_suffix("/backend") {
            let cleaned_root = stripped.trim_end_matches('/').to_string();
            if cleaned_root.is_empty() {
                (trimmed.clone(), trimmed.clone())
            } else {
                (cleaned_root, trimmed.clone())
            }
        } else {
            let backend = format!("{}/backend", trimmed);
            (trimmed.clone(), backend)
        };

        root = root.trim_end_matches('/').to_string();
        let backend_clean = backend_base.trim_end_matches('/').to_string();

        self.stream_url = Some(format!("{}/api/music/stream", backend_clean));
        self.server_url = Some(root);
        self.backend_url = Some(backend_clean);
    }

    pub fn update_server_status<S: AsRef<str>>(&mut self, status: S) {
        self.server_status = PlaybackStatus::from_str(status);
    }

    pub fn update_player_status(&mut self, status: PlaybackStatus) {
        self.player_status = status;
    }

    pub fn set_user_paused(&mut self, paused: bool) {
        self.user_paused = paused;
        if paused {
            self.player_status = PlaybackStatus::Paused;
        }
    }

    pub fn update_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
    }


    pub fn update_current_track(&mut self, track: Option<Track>) -> bool {
        let changed = match (&self.current_track, &track) {
            (Some(current), Some(next)) => current.youtube_id != next.youtube_id,
            (None, Some(next)) => Some(next.youtube_id.clone()) != self.last_track_id,
            (Some(_), None) => true,
            (None, None) => false,
        };

        if let Some(ref t) = track {
            self.last_track_id = Some(t.youtube_id.clone());
        }

        self.current_track = track;
        changed
    }

    pub fn update_queue(&mut self, queue: Vec<Track>) {
        self.queue = queue;
    }

    pub fn update_sync(&mut self, position: f64, duration: Option<f64>) {
        self.synced_position = position.max(0.0);
        if let Some(dur) = duration {
            self.track_duration = dur.max(0.0);
        }
        self.last_sync_instant = Some(Instant::now());
        self.last_sync_wallclock = Some(SystemTime::now());
    }

    pub fn prepare_sync_preview(&mut self, position: f64, duration: Option<f64>) {
        self.synced_position = position.max(0.0);
        if let Some(dur) = duration {
            self.track_duration = dur.max(0.0);
        }
        self.last_sync_instant = None;
        self.last_sync_wallclock = None;
    }

    pub fn clear_sync(&mut self) {
        self.synced_position = 0.0;
        self.track_duration = 0.0;
        self.last_sync_instant = None;
        self.last_sync_wallclock = None;
    }

    pub fn computed_position(&self) -> f64 {
        if self.user_paused || self.player_status != PlaybackStatus::Playing {
            return self.synced_position.min(self.track_duration);
        }

        if let Some(last_sync) = self.last_sync_instant {
            let elapsed = last_sync.elapsed().as_secs_f64();
            let position = self.synced_position + elapsed;
            return position.min(self.track_duration);
        }

        self.synced_position.min(self.track_duration)
    }

    pub fn duration(&self) -> f64 {
        self.track_duration
    }

    pub fn last_sync_timestamp(&self) -> Option<u128> {
        self.last_sync_wallclock
            .and_then(|ts| ts.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        let server_url = self.server_url.clone();
        let current_track = self
            .current_track
            .as_ref()
            .map(|track| track.as_view(server_url.as_deref()));

        let queue = self
            .queue
            .iter()
            .map(|track| track.as_view(server_url.as_deref()))
            .collect();

        PlayerSnapshot {
            connected: self.server_url.is_some(),
            server_url: server_url.clone(),
            stream_url: self.stream_url.clone(),
            player_status: self.player_status,
            server_status: self.server_status,
            is_playing: self.player_status == PlaybackStatus::Playing,
            user_paused: self.user_paused,
            position: self.computed_position(),
            duration: self.duration(),
            volume: self.volume,
            current_track,
            queue,
            last_sync_timestamp: self.last_sync_timestamp(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

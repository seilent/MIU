use anyhow::{anyhow, Result};
use bytes::Bytes;
use reqwest::header::{HeaderValue, CONTENT_RANGE, RANGE};
use reqwest::{Client, Response, StatusCode};
use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;
use tokio::runtime::Handle;
use tokio::sync::Mutex;

/// Wrapper to make reqwest::Response work with rodio::Decoder
struct HttpStreamReader {
    client: Client,
    url: String,
    response: Option<Response>,
    buffer: Bytes,
    buffer_pos: usize,
    position: u64,
    eof: bool,
    runtime: Handle,
    total_length: Option<u64>,
}

impl HttpStreamReader {
    fn new(
        client: Client,
        url: String,
        response: Response,
        start_offset: u64,
        runtime: Handle,
        total_length: Option<u64>,
    ) -> Self {
        let mut reader = Self {
            client,
            url,
            response: Some(response),
            buffer: Bytes::new(),
            buffer_pos: 0,
            position: start_offset,
            eof: false,
            runtime,
            total_length,
        };

        if let Some(ref response) = reader.response {
            if let Some(total) = total_length_from_response(response) {
                if reader.total_length.is_none() || reader.total_length == Some(0) {
                    reader.total_length = Some(total);
                }
            }
        }

        reader
    }

    fn buffer_start(&self) -> u64 {
        self.position.saturating_sub(self.buffer_pos as u64)
    }

    fn reopen_stream(&mut self, offset: u64) -> std::io::Result<()> {
        let client = self.client.clone();
        let url = self.url.clone();

        // Validate offset before making request
        if let Some(total) = self.total_length {
            if offset > total {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!(
                        "Cannot reopen stream at offset {} beyond file size {}",
                        offset, total
                    ),
                ));
            }
            if offset == total {
                // Don't make HTTP request for EOF position
                self.position = offset;
                self.eof = true;
                self.buffer = bytes::Bytes::new();
                self.buffer_pos = 0;
                return Ok(());
            }
        }

        let request = client
            .get(&url)
            .header(RANGE, format!("bytes={}-", offset))
            .timeout(std::time::Duration::from_secs(30));

        let response = self
            .runtime
            .block_on(async { request.send().await })
            .map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("HTTP stream error: {}", e),
                )
            })?;

        if !(response.status() == StatusCode::PARTIAL_CONTENT || response.status().is_success()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("HTTP stream responded with status {}", response.status()),
            ));
        }

        if let Some(total) = total_length_from_response(&response) {
            if self.total_length.is_none() || self.total_length == Some(0) {
                self.total_length = Some(total);
            }
        }
        self.response = Some(response);
        self.buffer = Bytes::new();
        self.buffer_pos = 0;
        self.position = offset;
        self.eof = false;
        Ok(())
    }

    fn ensure_total_length(&mut self) -> std::io::Result<()> {
        if self.total_length.is_some() {
            return Ok(());
        }

        let client = self.client.clone();
        let url = self.url.clone();
        let runtime = self.runtime.clone();

        let head_result = runtime.block_on(async { client.head(&url).send().await });
        if let Ok(resp) = head_result {
            if resp.status().is_success() {
                if let Some(len) = resp.content_length() {
                    self.total_length = Some(len);
                    return Ok(());
                }
            }
        }

        let request = client.get(&url).header(RANGE, "bytes=0-0");

        let response = runtime
            .block_on(async { request.send().await })
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        if let Some(total) = parse_content_range(response.headers().get(CONTENT_RANGE)) {
            self.total_length = Some(total);
        } else if let Some(len) = response.content_length() {
            self.total_length = Some(len);
        }

        Ok(())
    }

    fn load_next_chunk(&mut self) -> std::io::Result<()> {
        if self.eof {
            return Ok(());
        }

        if self.response.is_none() {
            self.reopen_stream(self.position)?;
        }

        let runtime = self.runtime.clone();
        let chunk_result = if let Some(ref mut response) = self.response {
            runtime.block_on(async move { response.chunk().await })
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Response missing",
            ));
        };
        if let Some(ref response) = self.response {
            if let Some(total) = total_length_from_response(response) {
                if self.total_length.is_none() || self.total_length == Some(0) {
                    self.total_length = Some(total);
                }
            }
        }

        match chunk_result {
            Ok(Some(chunk)) => {
                if chunk.is_empty() {
                    self.eof = true;
                    self.buffer = Bytes::new();
                } else {
                    self.buffer = chunk;
                }
                self.buffer_pos = 0;
                // Only log every 100KB to reduce spam
                if self.position % 100000 < self.buffer.len() as u64 {
                    let _progress = if let Some(total) = self.total_length {
                        format!(" ({:.1}%)", (self.position as f64 / total as f64) * 100.0)
                    } else {
                        String::new()
                    };
                }
                Ok(())
            }
            Ok(None) => {
                self.buffer = Bytes::new();
                self.buffer_pos = 0;
                self.eof = true;
                Ok(())
            }
            Err(e) => {
                // If it's a timeout, try to reconnect and continue from current position
                if e.to_string().contains("timed out") || e.to_string().contains("timeout") {
                    // Clear the current response to force a reconnection
                    self.response = None;
                    self.buffer = Bytes::new();
                    self.buffer_pos = 0;

                    // Try to reconnect
                    match self.reopen_stream(self.position) {
                        Ok(()) => {
                            // Try to load the next chunk after reconnecting
                            self.load_next_chunk()
                        }
                        Err(_reconnect_err) => Err(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("HTTP timeout and reconnection failed: {}", e),
                        )),
                    }
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("HTTP chunk error: {}", e),
                    ))
                }
            }
        }
    }
}

impl Read for HttpStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.buffer_pos >= self.buffer.len() {
            self.load_next_chunk()?;
        }

        if self.buffer_pos >= self.buffer.len() {
            return Ok(0);
        }

        let available = self.buffer.len() - self.buffer_pos;
        let to_copy = buf.len().min(available);
        buf[..to_copy].copy_from_slice(&self.buffer[self.buffer_pos..self.buffer_pos + to_copy]);
        self.buffer_pos += to_copy;
        let old_position = self.position;
        self.position = self.position.checked_add(to_copy as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "Stream position overflow")
        })?;

        if old_position % 100000 == 0 || to_copy == 0 {}

        Ok(to_copy)
    }
}

impl Seek for HttpStreamReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let target: i128 = match pos {
            SeekFrom::Start(offset) => offset as i128,
            SeekFrom::Current(delta) => self.position as i128 + delta as i128,
            SeekFrom::End(delta) => {
                self.ensure_total_length()?;
                let total = self.total_length.ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "Total length unknown for SeekFrom::End",
                    )
                })?;
                total as i128 + delta as i128
            }
        };

        if target < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Seek before start of stream",
            ));
        }

        let target = target as u64;

        if let Some(total) = self.total_length {
            if target > total {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!(
                        "Seek beyond end of stream: target={}, total={}",
                        target, total
                    ),
                ));
            }
            // Allow seeking to EOF (target == total)
            if target == total {
                self.position = target;
                self.eof = true;
                self.buffer = bytes::Bytes::new();
                self.buffer_pos = 0;
                return Ok(self.position);
            }
        }

        if !self.buffer.is_empty() {
            let buffer_start = self.buffer_start();
            let buffer_end = buffer_start + self.buffer.len() as u64;

            if target >= buffer_start && target < buffer_end {
                self.buffer_pos = (target - buffer_start) as usize;
                self.position = target;
                return Ok(self.position);
            }
        }

        self.reopen_stream(target)?;
        Ok(self.position)
    }
}

fn total_length_from_response(response: &Response) -> Option<u64> {
    parse_content_range(response.headers().get(CONTENT_RANGE)).or(response.content_length())
}

struct AudioComponents {
    _stream: OutputStream,
    stream_handle: OutputStreamHandle,
}

unsafe impl Send for AudioComponents {}
unsafe impl Sync for AudioComponents {}

pub struct AudioManager {
    audio: Arc<AudioComponents>,
    sink: Arc<Mutex<Option<Sink>>>,
    volume: f32,
    http: Client,
    track_end_callback: Arc<Mutex<Option<Box<dyn Fn() + Send + Sync>>>>,
}

impl AudioManager {
    pub fn new() -> Result<Self> {
        let (_stream, stream_handle) = OutputStream::try_default()
            .map_err(|e| anyhow!("Failed to create audio output stream: {}", e))?;

        let audio = Arc::new(AudioComponents {
            _stream,
            stream_handle,
        });

        let http = Client::builder()
            .user_agent("MIU Player Tauri")
            .timeout(std::time::Duration::from_secs(300)) // 5 minutes for long streams
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_idle_timeout(std::time::Duration::from_secs(90)) // Keep connections alive
            .pool_max_idle_per_host(2)
            .tcp_keepalive(std::time::Duration::from_secs(30)) // Keep TCP connections alive
            .build()
            .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

        Ok(Self {
            audio,
            sink: Arc::new(Mutex::new(None)),
            volume: 0.8,
            http,
            track_end_callback: Arc::new(Mutex::new(None)),
        })
    }

    async fn send_stream_request(
        client: Client,
        stream_url: String,
        offset: u64,
    ) -> Result<Response> {
        let request = client
            .get(&stream_url)
            .header(RANGE, format!("bytes={}-", offset))
            .timeout(std::time::Duration::from_secs(30));

        let response = request
            .send()
            .await
            .map_err(|e| anyhow!("Failed to request audio stream: {}", e))?;

        if !response.status().is_success()
            && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        {
            return Err(anyhow!(
                "HTTP request failed with status: {}",
                response.status()
            ));
        }

        Ok(response)
    }
    // Add method to fetch current position from server
    async fn fetch_server_position(&self, stream_url: &str) -> Result<f64> {
        let position_url = if stream_url.contains("/api/music/stream") {
            stream_url.replace("/api/music/stream", "/api/music/position")
        } else {
            // Fallback: assume we can find the base URL
            let base = stream_url.split("/api/").next().unwrap_or(stream_url);
            format!("{}/api/music/position", base.trim_end_matches('/'))
        };

        // Remove any query parameters for position request
        let position_url = position_url.split('?').next().unwrap_or(&position_url);

        match self.http.get(position_url).send().await {
            Ok(response) => match response.json::<serde_json::Value>().await {
                Ok(data) => Ok(data["position"].as_f64().unwrap_or(0.0)),
                Err(_e) => Ok(0.0),
            },
            Err(_e) => Ok(0.0),
        }
    }

    pub async fn play_from(
        &mut self,
        stream_url: &str,
        start_position: f64,
        track_duration: Option<f64>,
    ) -> Result<()> {
        // Stop current playback if any
        self.stop().await?;

        // Fetch current position from server (like frontend does)
        let server_position = self.fetch_server_position(stream_url).await.unwrap_or(0.0);

        // Determine which position we'll target for buffering/seek
        let target_position = if server_position > 0.1 {
            server_position
        } else {
            start_position
        };

        let request_offset = 0u64;
        let residual_skip = target_position.max(0.0);

        // Create stream reader and decoder using the computed byte offset
        let runtime_handle = tokio::runtime::Handle::current();
        let http_client = self.http.clone();
        let audio_components = self.audio.clone();
        let stream_url_owned = stream_url.to_string();
        let volume = self.volume;
        let effective_offset = request_offset;
        let skip_seconds = residual_skip;

        let sink = tokio::task::spawn_blocking(move || -> Result<Sink> {
            // Follow frontend pattern: stream full track, then seek
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let stream_url_with_ts = if stream_url_owned.contains('?') {
                format!("{}&ts={}", stream_url_owned, timestamp)
            } else {
                format!("{}?ts={}", stream_url_owned, timestamp)
            };

            let response = runtime_handle.block_on(Self::send_stream_request(
                http_client.clone(),
                stream_url_with_ts.clone(),
                effective_offset,
            ))?;

            // Since rodio doesn't support seeking like HTML audio currentTime,
            // we use skip_duration to skip the audio samples to the right position

            let total_length = parse_content_range(response.headers().get(CONTENT_RANGE))
                .or(response.content_length());

            let reader = HttpStreamReader::new(
                http_client.clone(),
                stream_url_with_ts,
                response,
                effective_offset,
                runtime_handle.clone(),
                total_length,
            );

            // Create decoder
            let decoder = rodio::Decoder::new(reader)
                .map_err(|e| anyhow!("Failed to create decoder: {}", e))?;

            // Use skip_duration to seek to the server position (like frontend's audio.currentTime)
            let final_source: Box<dyn rodio::Source<Item = i16> + Send> = if skip_seconds > 0.1 {
                Box::new(decoder.skip_duration(std::time::Duration::from_secs_f64(skip_seconds)))
            } else {
                Box::new(decoder)
            };

            let sink = Sink::try_new(&audio_components.stream_handle)
                .map_err(|e| anyhow!("Failed to create audio sink: {}", e))?;

            sink.set_volume(volume);
            sink.append(final_source);
            sink.play();

            Ok(sink)
        })
        .await
        .map_err(|err| anyhow!("Audio initialization task panicked: {}", err))??;

        let mut sink_guard = self.sink.lock().await;
        *sink_guard = Some(sink);

        //     "Playback started: volume {:.2}, target position {:.2}s (seeking via skip_duration)",
        //     self.volume, start_position
        // );

        // Start monitoring track completion in the background
        let track_duration_for_monitor = track_duration;
        let audio_manager = {
            // Create a lightweight clone for monitoring
            AudioManager {
                audio: self.audio.clone(),
                sink: self.sink.clone(),
                volume: self.volume,
                http: self.http.clone(),
                track_end_callback: self.track_end_callback.clone(),
            }
        };

        tokio::spawn(async move {
            // Monitor track completion every 2 seconds
            let mut consecutive_stopped_checks = 0;
            loop {
                let is_playing = audio_manager.is_playing().await;
                if !is_playing {
                    consecutive_stopped_checks += 1;

                    // Only consider it truly completed after 3 consecutive checks (6 seconds)
                    // This prevents triggering on temporary network issues or brief interruptions
                    if consecutive_stopped_checks >= 3 {
                        audio_manager
                            .check_track_completion(track_duration_for_monitor)
                            .await;
                        break;
                    }
                } else {
                    // Reset counter if playback resumed
                    if consecutive_stopped_checks > 0 {
                        consecutive_stopped_checks = 0;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut sink_guard = self.sink.lock().await;
        if let Some(sink) = sink_guard.take() {
            sink.stop();
        }
        Ok(())
    }

    pub fn set_volume(&mut self, volume: f32) -> Result<()> {
        self.volume = volume.clamp(0.0, 1.0);

        let sink = self.sink.clone();
        let new_volume = self.volume;
        tokio::spawn(async move {
            let sink_guard = sink.lock().await;
            if let Some(ref sink) = *sink_guard {
                sink.set_volume(new_volume);
            }
        });

        Ok(())
    }

    pub async fn is_playing(&self) -> bool {
        let sink_guard = self.sink.lock().await;
        if let Some(ref sink) = *sink_guard {
            !sink.is_paused() && !sink.empty()
        } else {
            false
        }
    }

    pub async fn set_track_end_callback<F>(&self, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        let mut callback_guard = self.track_end_callback.lock().await;
        *callback_guard = Some(Box::new(callback));
    }

    async fn check_track_completion(&self, track_duration: Option<f64>) {
        if let Some(_duration) = track_duration {
            let sink_guard = self.sink.lock().await;
            if let Some(ref sink) = *sink_guard {
                // Check if sink is empty (track finished playing)
                if sink.empty() && !sink.is_paused() {
                    drop(sink_guard); // Release the lock before calling callback

                    // Call the track end callback
                    let callback_guard = self.track_end_callback.lock().await;
                    if let Some(ref callback) = *callback_guard {
                        callback();
                    }
                }
            }
        }
    }
}

fn parse_content_range(header: Option<&HeaderValue>) -> Option<u64> {
    let header_str = header?.to_str().ok()?;
    // Expected format: bytes start-end/total
    let parts: Vec<&str> = header_str.split('/').collect();
    if parts.len() != 2 {
        return None;
    }

    parts[1].trim().parse::<u64>().ok()
}

// Old decode_audio function removed - now using HTTP streaming directly to rodio

use anyhow::{anyhow, Result};
use bytes::Bytes;
use reqwest::header::{HeaderValue, CONTENT_RANGE, RANGE};
use reqwest::{Client, Response, StatusCode};
use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use std::io::{Error as IoError, ErrorKind};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

const PREFETCH_CHANNEL_SIZE: usize = 5;
const BUFFER_AHEAD_CHUNKS: usize = 3;
const MIN_BUFFER_CHUNKS: usize = 2;
const CHUNK_SIZE_ESTIMATE: u64 = 32768; // Estimated bytes per chunk for position calculation

enum FetchMessage {
    Chunk(Bytes),
    Eof,
    Error(IoError),
}

/// Wrapper to make reqwest::Response work with rodio::Decoder
struct HttpStreamReader {
    client: Client,
    url: String,
    buffer: Bytes,
    buffer_pos: usize,
    position: u64,
    eof: bool,
    runtime: Handle,
    total_length: Option<u64>,
    chunk_rx: Option<mpsc::Receiver<FetchMessage>>,
    fetch_task: Option<JoinHandle<()>>,
    chunk_buffer: Vec<Bytes>,
    buffer_target_position: u64,
    last_sse_position: Option<f64>,
    network_latency_ms: f64,
}

impl HttpStreamReader {
    fn new(client: Client, url: String, start_offset: u64, runtime: Handle) -> Result<Self> {
        let mut reader = Self {
            client,
            url,
            buffer: Bytes::new(),
            buffer_pos: 0,
            position: start_offset,
            eof: false,
            runtime,
            total_length: None,
            chunk_rx: None,
            fetch_task: None,
            chunk_buffer: Vec::new(),
            buffer_target_position: start_offset,
            last_sse_position: None,
            network_latency_ms: 50.0, // Default estimate
        };

        reader
            .start_stream(start_offset)
            .map_err(|e| anyhow!("Failed to start audio stream: {}", e))?;

        Ok(reader)
    }

    fn buffer_start(&self) -> u64 {
        self.position.saturating_sub(self.buffer_pos as u64)
    }

    fn start_stream(&mut self, offset: u64) -> std::io::Result<()> {
        if let Some(total) = self.total_length {
            if offset > total {
                return Err(IoError::new(
                    ErrorKind::InvalidInput,
                    format!(
                        "Cannot open stream at offset {} beyond file size {}",
                        offset, total
                    ),
                ));
            }

            if offset == total {
                self.abort_fetcher();
                self.position = offset;
                self.eof = true;
                self.buffer = Bytes::new();
                self.buffer_pos = 0;
                self.chunk_rx = None;
                return Ok(());
            }
        }

        let request = build_stream_request(&self.client, &self.url, offset);
        let response = self
            .runtime
            .block_on(async { request.send().await })
            .map_err(|e| IoError::new(ErrorKind::Other, format!("HTTP stream error: {}", e)))?;

        if !(response.status() == StatusCode::PARTIAL_CONTENT || response.status().is_success()) {
            return Err(IoError::new(
                ErrorKind::Other,
                format!("HTTP stream responded with status {}", response.status()),
            ));
        }

        if let Some(total) = total_length_from_response(&response) {
            if self.total_length.is_none() || self.total_length == Some(0) {
                self.total_length = Some(total);
            }
        } else if self.total_length.is_none() {
            self.total_length = response.content_length();
        }

        self.position = offset;
        self.buffer = Bytes::new();
        self.buffer_pos = 0;
        self.eof = false;
        self.chunk_buffer.clear();
        self.buffer_target_position = offset;

        self.abort_fetcher();

        let (tx, rx) = mpsc::channel::<FetchMessage>(PREFETCH_CHANNEL_SIZE);
        self.chunk_rx = Some(rx);

        let client = self.client.clone();
        let url = self.url.clone();

        let fetch_task = self.runtime.spawn(async move {
            let sender = tx;
            let mut current_response = response;
            let mut current_offset = offset;

            loop {
                match current_response.chunk().await {
                    Ok(Some(chunk)) => {
                        if chunk.is_empty() {
                            continue;
                        }

                        current_offset = current_offset.saturating_add(chunk.len() as u64);

                        if sender.send(FetchMessage::Chunk(chunk)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = sender.send(FetchMessage::Eof).await;
                        break;
                    }
                    Err(err) => {
                        if err.is_timeout() {
                            match request_stream_async(client.clone(), url.clone(), current_offset)
                                .await
                            {
                                Ok(new_response) => {
                                    current_response = new_response;
                                    continue;
                                }
                                Err(io_err) => {
                                    let _ = sender.send(FetchMessage::Error(io_err)).await;
                                    break;
                                }
                            }
                        } else {
                            let _ = sender
                                .send(FetchMessage::Error(IoError::new(
                                    ErrorKind::Other,
                                    format!("HTTP chunk error: {}", err),
                                )))
                                .await;
                            break;
                        }
                    }
                }
            }
        });

        self.fetch_task = Some(fetch_task);

        Ok(())
    }

    fn reopen_stream(&mut self, offset: u64) -> std::io::Result<()> {
        self.start_stream(offset)
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

        // Try to get chunk from buffer first
        if !self.chunk_buffer.is_empty() {
            self.buffer = self.chunk_buffer.remove(0);
            self.buffer_pos = 0;
            return Ok(());
        }

        let rx = self
            .chunk_rx
            .as_mut()
            .ok_or_else(|| IoError::new(ErrorKind::UnexpectedEof, "Chunk receiver missing"))?;

        // Buffer multiple chunks ahead for smoother playback
        while self.chunk_buffer.len() < MIN_BUFFER_CHUNKS {
            match rx.try_recv() {
                Ok(FetchMessage::Chunk(chunk)) => {
                    if !chunk.is_empty() {
                        self.chunk_buffer.push(chunk);
                    }
                }
                Ok(FetchMessage::Eof) => {
                    self.eof = true;
                    break;
                }
                Ok(FetchMessage::Error(err)) => {
                    self.eof = true;
                    return Err(err);
                }
                Err(mpsc::error::TryRecvError::Empty) => {
                    // No more chunks available immediately, get one blocking
                    match rx.blocking_recv() {
                        Some(FetchMessage::Chunk(chunk)) => {
                            if !chunk.is_empty() {
                                self.chunk_buffer.push(chunk);
                                break;
                            }
                        }
                        Some(FetchMessage::Eof) | None => {
                            self.eof = true;
                            break;
                        }
                        Some(FetchMessage::Error(err)) => {
                            self.eof = true;
                            return Err(err);
                        }
                    }
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    self.eof = true;
                    break;
                }
            }
        }

        // Get next chunk from buffer
        if !self.chunk_buffer.is_empty() {
            self.buffer = self.chunk_buffer.remove(0);
            self.buffer_pos = 0;
            Ok(())
        } else if self.eof {
            self.buffer = Bytes::new();
            self.buffer_pos = 0;
            Ok(())
        } else {
            Err(IoError::new(ErrorKind::UnexpectedEof, "No chunks available"))
        }
    }


    fn abort_fetcher(&mut self) {
        if let Some(handle) = self.fetch_task.take() {
            handle.abort();
        }
        self.chunk_buffer.clear();
    }

    /// Update buffer strategy based on SSE position information
    pub fn update_sse_position(&mut self, position_seconds: f64) {
        self.last_sse_position = Some(position_seconds);

        // Calculate target buffer position based on SSE position
        let position_bytes = (position_seconds * 44100.0 * 2.0 * 2.0) as u64; // Estimate for stereo 16-bit
        let buffer_ahead_bytes = BUFFER_AHEAD_CHUNKS as u64 * CHUNK_SIZE_ESTIMATE;
        self.buffer_target_position = position_bytes + buffer_ahead_bytes;
    }

    /// Check if buffer needs repositioning based on SSE sync
    pub fn needs_buffer_sync(&self) -> bool {
        if let Some(sse_pos) = self.last_sse_position {
            let sse_bytes = (sse_pos * 44100.0 * 2.0 * 2.0) as u64;
            let current_buffer_start = self.buffer_start();
            let drift = if sse_bytes > current_buffer_start {
                sse_bytes - current_buffer_start
            } else {
                current_buffer_start - sse_bytes
            };

            // Sync if drift is more than 2 chunks worth of data
            drift > (2 * CHUNK_SIZE_ESTIMATE)
        } else {
            false
        }
    }

    /// Update network latency estimate for better buffering
    pub fn update_network_latency(&mut self, latency_ms: f64) {
        self.network_latency_ms = latency_ms.clamp(10.0, 500.0);
    }

    /// Get recommended buffer size based on network conditions
    fn get_adaptive_buffer_size(&self) -> usize {
        if self.network_latency_ms > 200.0 {
            PREFETCH_CHANNEL_SIZE * 2 // Double buffer for high latency
        } else if self.network_latency_ms > 100.0 {
            PREFETCH_CHANNEL_SIZE + 2 // Extra buffering for medium latency
        } else {
            PREFETCH_CHANNEL_SIZE // Normal buffering for low latency
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

        // Update buffer metrics for SSE integration
        if old_position % 100000 == 0 || to_copy == 0 {
            // Periodically check buffer health
        }

        Ok(to_copy)
    }
}

impl Drop for HttpStreamReader {
    fn drop(&mut self) {
        self.abort_fetcher();
    }
}

fn build_stream_request(client: &Client, url: &str, offset: u64) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header(RANGE, format!("bytes={}-", offset))
        .timeout(Duration::from_secs(30))
}

async fn request_stream_async(
    client: Client,
    url: String,
    offset: u64,
) -> std::io::Result<Response> {
    let response = client
        .get(&url)
        .header(RANGE, format!("bytes={}-", offset))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| IoError::new(ErrorKind::Other, format!("HTTP stream error: {}", e)))?;

    if !(response.status() == StatusCode::PARTIAL_CONTENT || response.status().is_success()) {
        return Err(IoError::new(
            ErrorKind::Other,
            format!("HTTP stream responded with status {}", response.status()),
        ));
    }

    Ok(response)
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
                self.buffer = Bytes::new();
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
    last_sse_position: Arc<Mutex<Option<f64>>>,
    last_sse_update: Arc<Mutex<Option<std::time::Instant>>>,
    buffer_health: Arc<Mutex<f64>>,
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
            last_sse_position: Arc::new(Mutex::new(None)),
            last_sse_update: Arc::new(Mutex::new(None)),
            buffer_health: Arc::new(Mutex::new(1.0)),
        })
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
        _track_duration: Option<f64>,
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

            // Since rodio doesn't support seeking like HTML audio currentTime,
            // we use skip_duration to skip the audio samples to the right position

            let reader = HttpStreamReader::new(
                http_client.clone(),
                stream_url_with_ts,
                effective_offset,
                runtime_handle.clone(),
            )?;

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

        // Update SSE tracking for the new playback
        let mut last_position = self.last_sse_position.lock().await;
        *last_position = Some(target_position);

        let mut last_update = self.last_sse_update.lock().await;
        *last_update = Some(std::time::Instant::now());

        let mut buffer_health = self.buffer_health.lock().await;
        *buffer_health = 1.0; // Fresh start

        //     "Playback started: volume {:.2}, target position {:.2}s (seeking via skip_duration)",
        //     self.volume, start_position
        // );

        // Removed local track completion monitoring - rely entirely on SSE events from backend
        // The backend handles track timing and advancement, then broadcasts state changes via SSE
        println!("Audio: Playback started, relying on SSE for track progression");

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut sink_guard = self.sink.lock().await;
        if let Some(sink) = sink_guard.take() {
            sink.stop();
        }

        // Clear SSE tracking
        let mut last_position = self.last_sse_position.lock().await;
        *last_position = None;

        let mut buffer_health = self.buffer_health.lock().await;
        *buffer_health = 0.0;

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

    /// Update buffer based on SSE position information
    pub async fn update_from_sse(&self, position_seconds: f64, latency_ms: Option<f64>) -> Result<()> {
        // Update position tracking
        let mut last_position = self.last_sse_position.lock().await;
        let previous_position = *last_position;
        *last_position = Some(position_seconds);
        drop(last_position);

        // Update last SSE timestamp
        let mut last_update = self.last_sse_update.lock().await;
        let previous_update = *last_update;
        *last_update = Some(std::time::Instant::now());
        drop(last_update);

        // Calculate buffer health based on SSE updates
        let mut buffer_health = self.buffer_health.lock().await;
        if let (Some(prev_pos), Some(prev_time)) = (previous_position, previous_update) {
            let time_diff = prev_time.elapsed().as_secs_f64();
            let pos_diff = (position_seconds - prev_pos).abs();

            // Good health if position updates are consistent with time
            let expected_diff = time_diff; // 1:1 ratio for real-time
            let health = if pos_diff > 0.0 {
                (expected_diff / pos_diff.max(expected_diff)).min(1.0)
            } else {
                0.8 // Static position, moderate health
            };

            *buffer_health = health;

            if let Some(latency) = latency_ms {
                // Adjust health based on latency
                let latency_factor = (100.0 / latency.max(100.0)).min(1.0);
                *buffer_health *= latency_factor;
            }

            if *buffer_health < 0.7 {
                println!("Audio: SSE buffer health: {:.2}, position: {:.2}s, latency: {:?}ms",
                         *buffer_health, position_seconds, latency_ms);
            }
        } else {
            *buffer_health = 0.9; // First update
        }

        Ok(())
    }

    /// Prepare buffer for upcoming track transition
    pub async fn prepare_track_transition(&self, next_track_url: &str, start_position: f64) -> Result<()> {
        println!("Audio: Preparing buffer for track transition at position {:.2}s", start_position);

        // Pre-warm connection and validate stream availability
        let response = self.http.head(next_track_url).send().await;
        match response {
            Ok(resp) if resp.status().is_success() => {
                println!("Audio: Next track pre-buffering validated");
                Ok(())
            }
            Ok(resp) => {
                println!("Audio: Next track unavailable: {}", resp.status());
                Err(anyhow!("Next track unavailable: {}", resp.status()))
            }
            Err(e) => {
                println!("Audio: Track transition preparation failed: {}", e);
                Err(anyhow!("Track transition preparation failed: {}", e))
            }
        }
    }

    /// Get buffer health metrics for monitoring
    pub async fn get_buffer_metrics(&self) -> Result<BufferMetrics> {
        let last_update = self.last_sse_update.lock().await;
        let last_position = self.last_sse_position.lock().await;
        let buffer_health = self.buffer_health.lock().await;

        let sse_age_ms = last_update
            .map(|inst| inst.elapsed().as_millis() as f64)
            .unwrap_or(f64::INFINITY);

        let is_active = last_position.is_some() && sse_age_ms < 10000.0;
        let health_score = if sse_age_ms < 5000.0 { *buffer_health } else { 0.5 };

        Ok(BufferMetrics {
            is_active,
            sse_age_ms,
            estimated_buffer_health: health_score,
            last_position: *last_position,
        })
    }

    // Removed track end callback methods - track advancement now handled via SSE events
}

#[derive(Debug)]
pub struct BufferMetrics {
    pub is_active: bool,
    pub sse_age_ms: f64,
    pub estimated_buffer_health: f64,
    pub last_position: Option<f64>,
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

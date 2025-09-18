use anyhow::{anyhow, Result};
use reqwest::Client;
use rodio::{OutputStream, OutputStreamHandle, Sink};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Wrapper to make reqwest::Response work with rodio::Decoder
struct HttpStreamReader {
    response: reqwest::Response,
    buffer: Vec<u8>,
    buffer_pos: usize,
}

impl HttpStreamReader {
    fn new(response: reqwest::Response) -> Self {
        Self {
            response,
            buffer: Vec::new(),
            buffer_pos: 0,
        }
    }
}

impl Read for HttpStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // If we have buffered data, use it first
        if self.buffer_pos < self.buffer.len() {
            let available = self.buffer.len() - self.buffer_pos;
            let to_copy = buf.len().min(available);
            buf[..to_copy].copy_from_slice(&self.buffer[self.buffer_pos..self.buffer_pos + to_copy]);
            self.buffer_pos += to_copy;
            return Ok(to_copy);
        }

        // Buffer is empty, get more data from HTTP response
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            match self.response.chunk().await {
                Ok(Some(chunk)) => {
                    self.buffer = chunk.to_vec();
                    self.buffer_pos = 0;
                    
                    // Copy to output buffer
                    let to_copy = buf.len().min(self.buffer.len());
                    buf[..to_copy].copy_from_slice(&self.buffer[..to_copy]);
                    self.buffer_pos = to_copy;
                    Ok(to_copy)
                }
                Ok(None) => Ok(0), // EOF
                Err(e) => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("HTTP chunk error: {}", e)
                ))
            }
        })
    }
}

impl Seek for HttpStreamReader {
    fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
        // HTTP streams can't seek backwards - seeking is handled at request level with range headers
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Seeking not supported for HTTP streams - use Range headers"
        ))
    }
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
            .build()
            .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

        Ok(Self {
            audio,
            sink: Arc::new(Mutex::new(None)),
            volume: 0.8,
            http,
        })
    }

    pub async fn play_from(&mut self, stream_url: &str, start_position: f64) -> Result<()> {
        // Stop current playback if any
        self.stop().await?;

        // Always request the full stream to avoid seeking issues with rodio
        let request = self.http.get(stream_url);

        println!("HTTP streaming from {} at position {:.2}s", stream_url, start_position);
        let response = request
            .send()
            .await
            .map_err(|e| anyhow!("Failed to request audio stream: {}", e))?;

        println!("Audio stream HTTP status: {}", response.status());
        if !response.status().is_success() {
            return Err(anyhow!("Audio stream HTTP error: {}", response.status()));
        }

        // Create HTTP stream wrapper for rodio
        let http_stream = HttpStreamReader::new(response);
        
        // Create rodio decoder directly from HTTP stream
        let decoder = rodio::Decoder::new(http_stream)
            .map_err(|e| anyhow!("Failed to create decoder from HTTP stream: {}", e))?;

        let sink = Sink::try_new(&self.audio.stream_handle)
            .map_err(|e| anyhow!("Failed to create audio sink: {}", e))?;
        sink.set_volume(self.volume);

        // Stream directly to rodio - no memory buffering!
        sink.append(decoder);
        sink.play();

        let mut sink_guard = self.sink.lock().await;
        *sink_guard = Some(sink);

        println!(
            "Playback started: volume {:.2}, start position {:.2}s (note: position sync handled by server)",
            self.volume, start_position
        );

        Ok(())
    }

    pub async fn pause(&self) -> Result<()> {
        let sink_guard = self.sink.lock().await;
        if let Some(ref sink) = *sink_guard {
            println!("Pausing playback");
            sink.pause();
        } else {
            println!("Pause requested but no active sink");
        }
        Ok(())
    }

    pub async fn resume(&self) -> Result<()> {
        let sink_guard = self.sink.lock().await;
        if let Some(ref sink) = *sink_guard {
            println!("Resuming playback");
            sink.play();
        } else {
            println!("Resume requested but no active sink");
        }
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

    pub fn get_volume(&self) -> f32 {
        self.volume
    }

    pub async fn is_playing(&self) -> bool {
        let sink_guard = self.sink.lock().await;
        if let Some(ref sink) = *sink_guard {
            !sink.is_paused() && !sink.empty()
        } else {
            false
        }
    }
}

// Old decode_audio function removed - now using HTTP streaming directly to rodio

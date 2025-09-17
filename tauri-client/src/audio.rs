use anyhow::{anyhow, Result};
use reqwest::Client;
use rodio::{buffer::SamplesBuffer, OutputStream, OutputStreamHandle, Sink};
use std::io::Cursor;
use std::sync::Arc;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tokio::sync::Mutex;

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

        // Fetch audio bytes
        println!("Fetching audio stream from {}", stream_url);
        let response = self
            .http
            .get(stream_url)
            .send()
            .await
            .map_err(|e| anyhow!("Failed to request audio stream: {}", e))?;

        println!("Audio stream HTTP status: {}", response.status());
        if !response.status().is_success() {
            return Err(anyhow!("Audio stream HTTP error: {}", response.status()));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| anyhow!("Failed to read audio stream: {}", e))?;
        println!("Fetched {} bytes of audio data", bytes.len());

        let start = start_position.max(0.0);
        let data = bytes.to_vec();

        // Decode on blocking thread to avoid stopping async runtime
        let decode_result = tokio::task::spawn_blocking(move || decode_audio(data, start)).await;
        let (samples, sample_rate, channels) = match decode_result {
            Ok(Ok(result)) => result,
            Ok(Err(err)) => {
                println!("Audio decode error: {}", err);
                return Err(err);
            }
            Err(join_err) => {
                println!("Audio decode join error: {}", join_err);
                return Err(anyhow!("Audio decoding task failed: {}", join_err));
            }
        };

        println!(
            "Decoded {} samples @ {} Hz with {} channels",
            samples.len(),
            sample_rate,
            channels
        );
        if samples.is_empty() {
            println!("decode_audio produced empty buffer after skipping; returning silence");
            return Ok(());
        }

        let sink = Sink::try_new(&self.audio.stream_handle)
            .map_err(|e| anyhow!("Failed to create audio sink: {}", e))?;
        sink.set_volume(self.volume);

        // Append decoded samples to sink and start playback
        let source = SamplesBuffer::new(channels, sample_rate, samples);
        sink.append(source);
        sink.play();

        let mut sink_guard = self.sink.lock().await;
        *sink_guard = Some(sink);

        println!(
            "Playback started: volume {:.2}, start position {:.2}s",
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

fn decode_audio(data: Vec<u8>, start_position: f64) -> Result<(Vec<f32>, u32, u16)> {
    println!(
        "Decoding audio buffer ({} bytes) starting at {:.2}s",
        data.len(),
        start_position
    );
    let cursor = Cursor::new(data);
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let mut hint = Hint::new();
    hint.with_extension("m4a");
    hint.with_extension("mp4");
    hint.with_extension("aac");

    let format_opts: FormatOptions = Default::default();
    let metadata_opts: MetadataOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| {
            println!("Symphonia probe failed: {}", e);
            anyhow!("Failed to probe audio format: {}", e)
        })?;

    let mut format = probed.format;
    let track = format.default_track().ok_or_else(|| {
        println!("No default track detected in container");
        anyhow!("No supported audio tracks found")
    })?;

    let codec_params = track.codec_params.clone();
    let track_id = track.id;

    let sample_rate = codec_params.sample_rate.ok_or_else(|| {
        println!("Codec parameters missing sample rate: {:?}", codec_params);
        anyhow!("Missing sample rate in audio stream")
    })?;
    let channels = codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or_else(|| {
            println!("Codec parameters missing channel info, defaulting to stereo");
            2
        });

    let seek_samples =
        (start_position * sample_rate as f64).round().max(0.0) as usize * channels as usize;
    println!(
        "Audio format detected: sample_rate={}Hz channels={} seek_samples={}",
        sample_rate, channels, seek_samples
    );

    let mut consumed = 0usize;
    let mut samples = Vec::new();
    let mut sample_buffer: Option<SampleBuffer<f32>> = None;

    let decoder_opts: DecoderOptions = Default::default();
    println!("Creating decoder for codec params: {:?}", codec_params);
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &decoder_opts)
        .map_err(|e| {
            println!("Failed to create decoder: {}", e);
            anyhow!("Failed to create audio decoder: {}", e)
        })?;

    println!("Beginning packet decode loop");

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::Interrupted =>
            {
                continue;
            }
            Err(error) => return Err(anyhow!("Failed to read audio packet: {}", error)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::Interrupted =>
            {
                continue;
            }
            Err(SymphoniaError::DecodeError(msg)) => {
                return Err(anyhow!("Audio decode error: {}", msg));
            }
            Err(error) => return Err(anyhow!("Failed to decode audio packet: {}", error)),
        };

        let spec = *decoded.spec();
        let capacity = decoded.capacity() as u64;
        let buf = sample_buffer.get_or_insert_with(|| SampleBuffer::<f32>::new(capacity, spec));
        buf.copy_interleaved_ref(decoded);

        let data = buf.samples();

        if consumed < seek_samples {
            let remaining = seek_samples - consumed;
            if remaining >= data.len() {
                consumed += data.len();
                continue;
            } else {
                samples.extend_from_slice(&data[remaining..]);
                consumed = seek_samples;
            }
        } else {
            samples.extend_from_slice(data);
        }

        consumed = consumed.saturating_add(data.len());
    }

    if samples.is_empty() {
        // Return silence if we skipped past the end of the track
        println!("decode_audio produced empty buffer after skipping; returning silence");
        return Ok((Vec::new(), sample_rate, channels));
    }

    println!(
        "decode_audio produced {} samples ({} seconds of audio)",
        samples.len(),
        samples.len() as f64 / (sample_rate as f64 * channels as f64)
    );

    Ok((samples, sample_rate, channels))
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod config;
mod server;
mod state;
// mod mpris;

use audio::AudioManager;
use config::AppConfig;
use server::ServerClient;
use state::{AppState, PlaybackStatus, PlayerSnapshot, Track};
// use mpris::MprisManager;
// Removed unused PathBuf import
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

#[tauri::command]
async fn play_pause(
    app_handle: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    audio: State<'_, Arc<Mutex<AudioManager>>>,
    server: State<'_, Arc<ServerClient>>,
) -> Result<(), String> {
    let audio_arc = audio.inner().clone();
    let server_arc = server.inner().clone();
    let pause_handle = app_handle.clone();

    let mut guard = state.lock().await;

    // Logic: if we're currently playing (and not user-paused), then pause. Otherwise, resume.
    let should_pause = !guard.user_paused && guard.player_status == PlaybackStatus::Playing;

    println!("play_pause called: player_status={:?}, user_paused={}, should_pause={}",
             guard.player_status, guard.user_paused, should_pause);

    if should_pause {
        println!("Taking PAUSE path - stopping playback");
        let position = guard.computed_position();
        guard.set_user_paused(true);
        guard.update_player_status(PlaybackStatus::Paused);
        let duration = guard.duration();
        guard.update_sync(position, Some(duration));
        let snapshot = guard.snapshot();
        drop(guard);

        // Emit state update IMMEDIATELY for instant UI feedback
        println!("Emitting player_state_updated event with isPlaying={}", snapshot.is_playing);
        pause_handle
            .emit("player_state_updated", snapshot)
            .map_err(|e| e.to_string())?;
        println!("Event emitted successfully");

        // Audio stop can happen after UI update (pause = stop for streaming)
        audio_arc
            .lock()
            .await
            .stop()
            .await
            .map_err(|e| e.to_string())?;
    } else {
        println!("Taking RESUME path - calling server");
        guard.set_user_paused(false);
        drop(guard);

        server_arc
            .resume_playback(state.inner().clone(), audio_arc, app_handle)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn set_volume(
    app_handle: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    audio: State<'_, Arc<Mutex<AudioManager>>>,
    volume: f32,
) -> Result<(), String> {
    let audio_arc = audio.inner().clone();

    let snapshot = {
        let mut guard = state.lock().await;
        guard.update_volume(volume);
        guard.snapshot()
    };

    audio_arc
        .lock()
        .await
        .set_volume(volume)
        .map_err(|e| e.to_string())?;

    app_handle
        .emit("player_state_updated", snapshot)
        .map_err(|e| e.to_string())?;

    // Save the new volume to config for persistence
    // Note: We should update the config through the state management system
    // For now, create a minimal config just for volume saving
    // TODO: Properly integrate with config state management
    let mut temp_config = AppConfig::default();
    temp_config.volume = volume;
    if let Err(e) = temp_config.save() {
        println!("Failed to save volume to config: {}", e);
        // Don't fail the command just because config save failed
    }

    Ok(())
}

#[tauri::command]
async fn get_current_track(
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Option<Track>, String> {
    let app_state = state.lock().await;
    Ok(app_state.current_track.clone())
}

#[tauri::command]
async fn get_player_state(
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<PlayerSnapshot, String> {
    let app_state = state.lock().await;
    Ok(app_state.snapshot())
}

#[tauri::command]
async fn connect_to_server(
    app_handle: AppHandle,
    server_url: String,
    state: State<'_, Arc<Mutex<AppState>>>,
    server: State<'_, Arc<ServerClient>>,
) -> Result<(), String> {
    println!("connect_to_server invoked with {}", server_url);
    let backend_url = {
        let mut app_state = state.lock().await;
        app_state.set_server_url(server_url);
        app_state.backend_url()
    };

    let backend_url = backend_url.ok_or_else(|| "Invalid server URL".to_string())?;

    server
        .inner()
        .clone()
        .fetch_and_apply_status(&backend_url, state.inner().clone(), app_handle)
        .await
        .map(|_| {
            println!("Initial status fetch succeeded for {}", backend_url);
        })
        .map_err(|e| e.to_string())
}

// FFmpeg-related commands removed - using HTTP streaming instead

fn main() {
    // Load configuration
    let config = AppConfig::load().unwrap_or_else(|e| {
        println!("Failed to load config, using defaults: {}", e);
        AppConfig::default()
    });

    let app_state = Arc::new(Mutex::new(AppState::new_with_volume(config.volume)));
    let config_arc = Arc::new(Mutex::new(config.clone()));

    // Initialize audio manager with HTTP streaming
    let audio_manager = Arc::new(Mutex::new(
        AudioManager::new().expect("Failed to initialize audio")
    ));

    let server_client = Arc::new(ServerClient::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state.clone())
        .manage(audio_manager.clone())
        .manage(server_client.clone())
        .manage(config_arc.clone())
        .invoke_handler(tauri::generate_handler![
            play_pause,
            set_volume,
            get_current_track,
            get_player_state,
            connect_to_server
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let state_clone = app_state.clone();
            let audio_clone = audio_manager.clone();
            let server_clone = server_client.clone();

            // Initialize volume from config in the async context
            let volume = config.volume;
            let audio_clone_for_init = audio_clone.clone();
            tauri::async_runtime::spawn(async move {
                let mut audio_guard = audio_clone_for_init.lock().await;
                if let Err(e) = audio_guard.set_volume(volume) {
                    println!("Failed to set initial volume: {}", e);
                } else {
                    println!("Set initial volume to: {}", volume);
                }
            });

            server_clone.spawn_background(state_clone, audio_clone, app_handle);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

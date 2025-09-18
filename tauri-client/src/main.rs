// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod config;
mod hyprland;
mod server;
mod state;
mod theme;
// mod mpris;

use audio::AudioManager;
use config::AppConfig;
use server::ServerClient;
use state::{AppState, PlaybackStatus, PlayerSnapshot, Track};
use theme::ThemeOverrides;
// use mpris::MprisManager;
// Removed unused PathBuf import
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

// Hold the tray icon handle so Linux tray implementations keep it alive.
struct TrayHandle {
    _tray_icon: TrayIcon,
}

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

    println!(
        "play_pause called: player_status={:?}, user_paused={}, should_pause={}",
        guard.player_status, guard.user_paused, should_pause
    );

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
        println!(
            "Emitting player_state_updated event with isPlaying={}",
            snapshot.is_playing
        );
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

#[tauri::command]
fn get_hyprland_theme() -> Result<Option<hyprland::HyprlandTheme>, String> {
    Ok(hyprland::detect_theme())
}

#[tauri::command]
async fn get_theme_overrides(
    config: State<'_, Arc<Mutex<AppConfig>>>,
) -> Result<Option<ThemeOverrides>, String> {
    let config_clone = config.lock().await.clone();
    Ok(theme::load_theme_overrides(&config_clone))
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
        AudioManager::new().expect("Failed to initialize audio"),
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
            connect_to_server,
            get_hyprland_theme,
            get_theme_overrides
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let state_clone = app_state.clone();
            let audio_clone = audio_manager.clone();
            let server_clone = server_client.clone();

            let hypr_theme = hyprland::detect_theme();

            if let Some(theme) = hypr_theme.clone() {
                println!("Hyprland detected; applying theme overrides: {:?}", theme);
                if let Err(err) = app.emit("hyprland_theme", &theme) {
                    println!("Failed to emit hyprland_theme event: {}", err);
                }
            }

            if let Some(theme_overrides) = theme::load_theme_overrides(&config) {
                println!(
                    "Loaded CSS theme overrides from {}",
                    theme_overrides.source.as_str()
                );
                if let Err(err) = app.emit("theme_overrides", &theme_overrides) {
                    println!("Failed to emit theme_overrides event: {}", err);
                }
            }

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

            if hypr_theme.is_none() {
                match init_tray(app) {
                    Ok(tray_icon) => {
                        app.manage(TrayHandle {
                            _tray_icon: tray_icon,
                        });
                    }
                    Err(tray_err) => {
                        println!("Failed to initialize tray icon: {}", tray_err);
                    }
                }
            } else {
                println!("Hyprland detected; skipping tray initialization");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn init_tray(app: &mut tauri::App) -> tauri::Result<TrayIcon> {
    let show_item = MenuItemBuilder::with_id("show_main", "Show Player").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let tray_menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&tray_menu)
        .on_menu_event(|app_handle, event: MenuEvent| match event.id().as_ref() {
            "show_main" => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.set_skip_taskbar(false);
                }
            }
            "quit" => {
                app_handle.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event: TrayIconEvent| match event {
            TrayIconEvent::Click { button, .. } if button == MouseButton::Left => {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.set_skip_taskbar(false);
                }
            }
            TrayIconEvent::DoubleClick { .. } => {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.set_skip_taskbar(false);
                }
            }
            _ => {}
        });

    if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/tray-icon.ico")) {
        tray_builder = tray_builder.icon(icon);
    } else if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    let tray_icon = tray_builder.build(app)?;
    Ok(tray_icon)
}

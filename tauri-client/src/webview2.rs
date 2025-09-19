#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use anyhow::{Result, anyhow};
#[cfg(target_os = "windows")]
use tauri::AppHandle;

const WEBVIEW2_DOWNLOAD_URL: &str = "https://miu.gacha.boo/dl/WebView2Loader.dll";

#[cfg(target_os = "windows")]
pub async fn ensure_webview2_available(app_handle: &AppHandle) -> Result<()> {
    // Check if WebView2Loader.dll exists in the same directory as the executable
    let exe_path = std::env::current_exe()?;
    let exe_dir = exe_path.parent().ok_or_else(|| anyhow!("Cannot determine executable directory"))?;
    let webview2_path = exe_dir.join("WebView2Loader.dll");

    println!("Checking for WebView2Loader.dll at: {:?}", webview2_path);

    if webview2_path.exists() {
        println!("WebView2Loader.dll found");
        return Ok(());
    }

    println!("WebView2Loader.dll not found, checking system WebView2 runtime...");

    // Check if WebView2 runtime is installed system-wide
    if is_webview2_runtime_installed() {
        println!("WebView2 runtime is installed system-wide");
        return Ok(());
    }

    println!("WebView2 runtime not available, prompting user for download...");

    // Prompt user for WebView2 download
    let should_download = prompt_webview2_download(app_handle).await?;

    if should_download {
        download_webview2(&webview2_path).await?;
        println!("WebView2Loader.dll downloaded successfully");
    } else {
        return Err(anyhow!("WebView2 is required but user declined download"));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn is_webview2_runtime_installed() -> bool {
    use std::process::Command;

    // Check registry for WebView2 installation
    let output = Command::new("reg")
        .args(&[
            "query",
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            "/v",
            "pv"
        ])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            println!("WebView2 runtime found in registry");
            return true;
        }
    }

    // Alternative check: try to find WebView2 in common installation paths
    let common_paths = [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ];

    for path in &common_paths {
        if Path::new(path).exists() {
            println!("WebView2 runtime found at: {}", path);
            return true;
        }
    }

    // Check for Edge browser (which includes WebView2)
    let edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];

    for path in &edge_paths {
        if Path::new(path).exists() {
            println!("Microsoft Edge found at: {}", path);
            return true;
        }
    }

    false
}

#[cfg(target_os = "windows")]
async fn prompt_webview2_download(app_handle: &AppHandle) -> Result<bool> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind, MessageDialogButtons};

    let message = "MIU Player requires Microsoft WebView2 to run.\n\n\
                   WebView2 was not found on your system. Would you like to download it now?\n\n\
                   This will download approximately 159KB and is required for the application to function.";

    let result = app_handle.dialog()
        .message(message)
        .title("WebView2 Required")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();

    Ok(result)
}

#[cfg(target_os = "windows")]
async fn download_webview2(destination: &Path) -> Result<()> {
    println!("Downloading WebView2Loader.dll from: {}", WEBVIEW2_DOWNLOAD_URL);

    let response = reqwest::get(WEBVIEW2_DOWNLOAD_URL).await?;

    if !response.status().is_success() {
        return Err(anyhow!("Failed to download WebView2: HTTP {}", response.status()));
    }

    let bytes = response.bytes().await?;

    // Ensure the parent directory exists
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(destination, bytes)?;

    // Verify the file was written correctly
    if !destination.exists() {
        return Err(anyhow!("Failed to write WebView2Loader.dll"));
    }

    let file_size = fs::metadata(destination)?.len();
    println!("WebView2Loader.dll downloaded: {} bytes", file_size);

    Ok(())
}

// For non-Windows platforms, provide a no-op implementation
#[cfg(not(target_os = "windows"))]
pub async fn ensure_webview2_available(_app_handle: &tauri::AppHandle) -> anyhow::Result<()> {
    Ok(())
}
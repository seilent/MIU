#[cfg(target_os = "linux")]
mod platform {
    use serde::Serialize;
    use std::process::Command;

    #[derive(Debug, Serialize, Default, Clone)]
    pub struct HyprlandTheme {
        pub is_hyprland: bool,
        pub accent_color: Option<String>,
        pub inactive_color: Option<String>,
        pub prefers_tiling: bool,
    }

    pub fn detect_theme() -> Option<HyprlandTheme> {
        if !is_hyprland() {
            return None;
        }

        let accent = fetch_color("general:col.active_border")
            .or_else(|| fetch_color("decoration:col.active_border"));
        let inactive = fetch_color("general:col.inactive_border")
            .or_else(|| fetch_color("decoration:col.inactive_border"));

        Some(HyprlandTheme {
            is_hyprland: true,
            accent_color: accent,
            inactive_color: inactive,
            prefers_tiling: true,
        })
    }

    fn is_hyprland() -> bool {
        std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok()
    }

    fn fetch_color(option: &str) -> Option<String> {
        let output = Command::new("hyprctl")
            .args(["-j", "getoption", option])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
        let raw = value
            .get("str")
            .and_then(|val| val.as_str())
            .or_else(|| value.get("special").and_then(|val| val.as_str()))?;

        normalize_color(raw)
    }

    fn normalize_color(raw: &str) -> Option<String> {
        let trimmed = raw.trim();

        if let Some(hex) = trimmed.strip_prefix("0x") {
            return normalize_hex(hex);
        }

        if trimmed.starts_with("rgba(") && trimmed.ends_with(')') {
            return rgba_to_hex(trimmed);
        }

        if trimmed.starts_with('#') {
            return normalize_hex(trimmed.trim_start_matches('#'));
        }

        None
    }

    fn normalize_hex(mut hex: &str) -> Option<String> {
        hex = hex.trim();
        if hex.len() == 8 {
            Some(format!("#{}", &hex[2..]))
        } else if hex.len() == 6 {
            Some(format!("#{}", hex))
        } else {
            None
        }
    }

    fn rgba_to_hex(rgba: &str) -> Option<String> {
        let inner = rgba.trim_start_matches("rgba(").trim_end_matches(')');
        let parts: Vec<_> = inner.split(',').map(|part| part.trim()).collect();
        if parts.len() < 3 {
            return None;
        }

        let r = parts.get(0)?.parse::<u8>().ok()?;
        let g = parts.get(1)?.parse::<u8>().ok()?;
        let b = parts.get(2)?.parse::<u8>().ok()?;

        Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use serde::Serialize;

    #[derive(Debug, Serialize, Default, Clone)]
    pub struct HyprlandTheme {
        pub is_hyprland: bool,
        pub accent_color: Option<String>,
        pub inactive_color: Option<String>,
        pub prefers_tiling: bool,
    }

    pub fn detect_theme() -> Option<HyprlandTheme> {
        None
    }
}

pub use platform::{detect_theme, HyprlandTheme};

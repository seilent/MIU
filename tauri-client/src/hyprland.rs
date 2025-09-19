#[cfg(target_os = "linux")]
mod platform {
    use serde::{Deserialize, Serialize};
    use std::fs;
    use std::process::Command;

    #[derive(Debug, Serialize, Default, Clone)]
    pub struct HyprlandTheme {
        pub is_hyprland: bool,
        pub accent_color: Option<String>,
        pub inactive_color: Option<String>,
        pub prefers_tiling: bool,
        // Material You colors from matugen
        pub primary: Option<String>,
        pub primary_container: Option<String>,
        pub secondary: Option<String>,
        pub secondary_container: Option<String>,
        pub tertiary: Option<String>,
        pub background: Option<String>,
        pub surface: Option<String>,
        pub surface_variant: Option<String>,
        pub outline: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct MatugenColors {
        pub primary: String,
        pub primary_container: String,
        pub secondary: String,
        pub secondary_container: String,
        pub tertiary: String,
        pub background: String,
        pub surface: String,
        pub surface_variant: String,
        pub outline: String,
    }

    pub fn detect_theme() -> Option<HyprlandTheme> {
        if !is_hyprland() {
            return None;
        }

        let accent = fetch_color("general:col.active_border")
            .or_else(|| fetch_color("decoration:col.active_border"));
        let inactive = fetch_color("general:col.inactive_border")
            .or_else(|| fetch_color("decoration:col.inactive_border"));

        // Load Material You colors from matugen
        let matugen_colors = load_matugen_colors();

        Some(HyprlandTheme {
            is_hyprland: true,
            accent_color: accent,
            inactive_color: inactive,
            prefers_tiling: true,
            primary: matugen_colors.as_ref().map(|c| c.primary.clone()),
            primary_container: matugen_colors.as_ref().map(|c| c.primary_container.clone()),
            secondary: matugen_colors.as_ref().map(|c| c.secondary.clone()),
            secondary_container: matugen_colors.as_ref().map(|c| c.secondary_container.clone()),
            tertiary: matugen_colors.as_ref().map(|c| c.tertiary.clone()),
            background: matugen_colors.as_ref().map(|c| c.background.clone()),
            surface: matugen_colors.as_ref().map(|c| c.surface.clone()),
            surface_variant: matugen_colors.as_ref().map(|c| c.surface_variant.clone()),
            outline: matugen_colors.as_ref().map(|c| c.outline.clone()),
        })
    }

    fn load_matugen_colors() -> Option<MatugenColors> {
        let home = std::env::var("HOME").ok()?;
        let colors_path = format!("{}/.local/state/quickshell/user/generated/colors.json", home);

        let content = fs::read_to_string(&colors_path).ok()?;
        let colors = serde_json::from_str::<MatugenColors>(&content).ok()?;

        // Debug: Print the actual colors we're reading
        println!("🎨 Loaded matugen colors: background={}, primary={}, surface={}",
                 colors.background, colors.primary, colors.surface);

        Some(colors)
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

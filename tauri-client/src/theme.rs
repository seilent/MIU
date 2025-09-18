use crate::config::AppConfig;
use dirs::home_dir;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ThemeOverrides {
    pub source: String,
    pub variables: HashMap<String, String>,
}

pub fn load_theme_overrides(config: &AppConfig) -> Option<ThemeOverrides> {
    let mut visited = HashSet::new();
    let mut candidates = Vec::new();

    if let Some(custom_path) = config
        .theme_css_path
        .as_ref()
        .and_then(|value| expand_path(value))
    {
        if visited.insert(custom_path.clone()) {
            candidates.push(custom_path);
        }
    }

    if let Some(home) = home_dir() {
        let default_paths = [
            home.join(".config/vesktop/themes/midnight.theme.css"),
            home.join(".config/vesktop/themes/current.theme.css"),
            home.join(".config/Vencord/themes/midnight.theme.css"),
        ];

        for path in default_paths {
            if visited.insert(path.clone()) {
                candidates.push(path);
            }
        }
    }

    for path in candidates {
        if !path.exists() {
            continue;
        }

        if let Some(theme) = parse_css_theme(&path) {
            return Some(theme);
        }
    }

    None
}

fn parse_css_theme(path: &Path) -> Option<ThemeOverrides> {
    let contents = fs::read_to_string(path).ok()?;
    let css_variables = extract_css_variables(&contents);
    if css_variables.is_empty() {
        return None;
    }

    let variables = map_css_to_miu(&css_variables);
    if variables.is_empty() {
        return None;
    }

    Some(ThemeOverrides {
        source: path.to_string_lossy().to_string(),
        variables,
    })
}

fn extract_css_variables(contents: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let regex = Regex::new(r"--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);").unwrap();

    for captures in regex.captures_iter(contents) {
        if let (Some(name), Some(value)) = (captures.get(1), captures.get(2)) {
            map.insert(name.as_str().to_string(), value.as_str().trim().to_string());
        }
    }

    map
}

fn map_css_to_miu(css_variables: &HashMap<String, String>) -> HashMap<String, String> {
    let mut miu_vars = HashMap::new();

    copy_if_present(
        css_variables,
        &mut miu_vars,
        "bg-4",
        "--miu-background-start",
    );
    copy_if_present(css_variables, &mut miu_vars, "bg-3", "--miu-background-end");
    copy_if_present(css_variables, &mut miu_vars, "bg-3", "--miu-surface");
    copy_if_present(css_variables, &mut miu_vars, "bg-2", "--miu-surface-border");
    copy_if_present(css_variables, &mut miu_vars, "bg-1", "--miu-surface-shadow");

    copy_if_present(css_variables, &mut miu_vars, "text-2", "--miu-text-primary");
    copy_if_present(css_variables, &mut miu_vars, "text-3", "--miu-text-muted");
    copy_if_present(
        css_variables,
        &mut miu_vars,
        "text-4",
        "--miu-text-secondary",
    );
    copy_if_present(css_variables, &mut miu_vars, "text-5", "--miu-text-dim");
    copy_if_present(css_variables, &mut miu_vars, "text-5", "--miu-placeholder");

    copy_if_present(css_variables, &mut miu_vars, "accent-2", "--miu-accent");
    copy_if_present(css_variables, &mut miu_vars, "accent-1", "--miu-success");
    copy_if_present(css_variables, &mut miu_vars, "accent-new", "--miu-error");
    copy_if_present(
        css_variables,
        &mut miu_vars,
        "accent-4",
        "--miu-accent-soft-hover",
    );
    copy_if_present(
        css_variables,
        &mut miu_vars,
        "accent-5",
        "--miu-accent-soft-active",
    );
    copy_if_present(css_variables, &mut miu_vars, "hover", "--miu-accent-soft");

    copy_if_present(css_variables, &mut miu_vars, "bg-2", "--miu-scroll-track");
    copy_if_present(
        css_variables,
        &mut miu_vars,
        "accent-4",
        "--miu-scroll-thumb",
    );
    copy_if_present(
        css_variables,
        &mut miu_vars,
        "accent-5",
        "--miu-scroll-thumb-hover",
    );

    copy_if_present(
        css_variables,
        &mut miu_vars,
        "accent-2",
        "--miu-slider-thumb",
    );
    copy_if_present(css_variables, &mut miu_vars, "bg-2", "--miu-slider-track");

    copy_if_present(
        css_variables,
        &mut miu_vars,
        "text-0",
        "--miu-button-foreground",
    );
    copy_if_present(css_variables, &mut miu_vars, "bg-1", "--miu-overlay");

    miu_vars
}

fn copy_if_present(
    source: &HashMap<String, String>,
    target: &mut HashMap<String, String>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(source_key) {
        target.insert(target_key.to_string(), value.clone());
    }
}

fn expand_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }

    if path.starts_with("~/") {
        let home = home_dir()?;
        return Some(home.join(path.trim_start_matches("~/")));
    }

    Some(PathBuf::from(path))
}

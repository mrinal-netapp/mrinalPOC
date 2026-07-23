//! Canonical log level identifiers — parity with the Go/Python/TypeScript clients.

use once_cell::sync::Lazy;
use std::collections::HashMap;

/// Stable level identifier stored on log events and in JSON config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogLevel {
    Debug,
    Info,
    Warning,
    Error,
    Critical,
    Exception,
}

impl LogLevel {
    pub const fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warning => "warning",
            LogLevel::Error => "error",
            LogLevel::Critical => "critical",
            LogLevel::Exception => "exception",
        }
    }
}

/// Maps normalized level names to verbosity rank (higher = more severe).
pub static LEVEL_RANK: Lazy<HashMap<&'static str, u8>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("debug", 10);
    m.insert("info", 20);
    m.insert("warning", 30);
    m.insert("warn", 30);
    m.insert("error", 40);
    m.insert("exception", 40);
    m.insert("critical", 50);
    m
});

/// Levels accepted by [`crate::log_event`] after normalization.
pub static LOG_EVENT_METHODS: Lazy<HashMap<&'static str, ()>> = Lazy::new(|| {
    let mut m = HashMap::new();
    for lv in ["debug", "info", "warning", "error", "critical", "exception"] {
        m.insert(lv, ());
    }
    m
});

/// Lowercases the input, trims whitespace, and maps `warn` → `warning`.
pub fn normalize_level_name(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed == "warn" {
        return "warning".to_string();
    }
    if trimmed == "fatal" {
        return "critical".to_string();
    }
    trimmed
}

/// Returns `Err` when the level is not a known floor.
pub fn validate_min_log_level(level: &str) -> Result<(), String> {
    let norm = normalize_level_name(level);
    if LEVEL_RANK.contains_key(norm.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "min_log_level must be one of debug, info, warning, error, critical, exception; got {level:?}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warn_normalized_to_warning() {
        assert_eq!(normalize_level_name("WARN"), "warning");
        assert_eq!(normalize_level_name(" Info "), "info");
        assert_eq!(normalize_level_name("fatal"), "critical");
    }

    #[test]
    fn valid_levels_accepted() {
        for lv in [
            "debug",
            "info",
            "warning",
            "warn",
            "error",
            "exception",
            "critical",
        ] {
            assert!(validate_min_log_level(lv).is_ok(), "{lv}");
        }
        assert!(validate_min_log_level("verbose").is_err());
    }
}

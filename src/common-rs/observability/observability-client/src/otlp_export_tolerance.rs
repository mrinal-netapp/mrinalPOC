//! Silence the noisy OTel-internal log channel that fires when the OTLP
//! collector is unreachable. Parity with the Go/Python/TypeScript clients.
//!
//! Skipped when `AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS` is set to a truthy value.

use once_cell::sync::OnceCell;
use std::env;

use crate::observability_env::is_truthy;

static APPLIED: OnceCell<()> = OnceCell::new();

/// Best-effort: applied exactly once per process. Subsequent calls are no-ops.
pub fn apply_otlp_unreachable_export_silencing() {
    if APPLIED.set(()).is_err() {
        return;
    }
    if env::var("AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS")
        .map(|v| is_truthy(&v))
        .unwrap_or(false)
    {
        return;
    }

    // The OTel Rust SDK emits its internal diagnostics via the `tracing` crate
    // under the `opentelemetry`, `opentelemetry_sdk`, and
    // `opentelemetry_otlp` target prefixes (when `internal-logs` is enabled).
    // We can't directly silence them without a subscriber, but we can set the
    // common env-filter knob so any subsequent `EnvFilter::from_default_env()`
    // call will exclude them by default.
    //
    // If a previous value is set we *append* — we don't clobber operator intent.
    let existing = env::var("RUST_LOG").unwrap_or_default();
    let directives = [
        "opentelemetry=warn",
        "opentelemetry_sdk=warn",
        "opentelemetry_otlp=warn",
        "opentelemetry-otlp=warn",
        "reqwest=warn",
        "hyper=warn",
    ];
    let mut combined = existing;
    for d in directives {
        if !combined.is_empty() {
            combined.push(',');
        }
        combined.push_str(d);
    }
    // SAFETY: env::set_var is unsafe in 2024 edition but safe here at startup
    // before any threads use the env.
    env::set_var("RUST_LOG", combined);
}

# common-rs

Shared Rust libraries for AgentStudio services — the Rust counterpart to `src/common/` (TypeScript).

## Crates

### `agentstudio-secrets-client`

Rust parity library for the Secrets Store CSI Driver integration.
Reads secrets from CSI-mounted files under `/mnt/secrets/<group>/<key>` and provides live rotation via notify-backed file watching.

See [`secrets-client/`](./secrets-client/) for full API and usage.

### `agentstudio-observability-client-runtime`

Rust parity client for the AgentStudio observability stack — structured
JSON logs, OTLP traces, Prometheus + OTLP metrics, RED span processor, and
Tower HTTP middleware. Same `AGENT_STUDIO_OBSERVABILITY_*` env contract and
packaged `log_config.json` as the Go / Python / TypeScript clients.

See [`observability/observability-client/`](./observability/observability-client/)
for full API and usage, or
[`.specs/observability/11-client-rust.spec.md`](../../.specs/observability/11-client-rust.spec.md)
for the design spec.

## Usage

Add as a local path dependency in your service's `Cargo.toml`:

```toml
[dependencies]
agentstudio-secrets-client = { path = "../../common-rs/secrets-client" }
agentstudio-observability-client-runtime = { path = "../../common-rs/observability/observability-client" }
```

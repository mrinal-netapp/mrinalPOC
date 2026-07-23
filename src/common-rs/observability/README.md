# common-rs/observability

Rust observability crates for AgentStudio services — Rust counterpart to
`src/common-go/observability/`, `src/common-py/observability/`, and
`src/common/src/observability/`.

## Crates

### [`observability-client/`](./observability-client/)

`agentstudio-observability-client-runtime` — structured JSON logs, OTLP
traces, Prometheus + OTLP metrics, RED span processor, and Tower HTTP
middleware. Behaves the same as the Go/Python/TypeScript clients (same
`AGENT_STUDIO_OBSERVABILITY_*` env contract, same packaged
`log_config.json`, same on-the-wire payload shapes).

## Usage

Add as a local path dependency in your service's `Cargo.toml`:

```toml
[dependencies]
agentstudio-observability-client-runtime = { path = "../../common-rs/observability/observability-client" }
```

See [`observability-client/README.md`](./observability-client/README.md) for
the full quick-start guide and configuration matrix, and
[`.specs/observability/11-client-rust.spec.md`](../../../.specs/observability/11-client-rust.spec.md)
for the full design spec.

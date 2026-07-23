# Design: Phoenix and agent-service observability

## Goals

- Capture **LLM/agent** spans (tools, model I/O, latency, tokens where exposed by instrumentation) in **Arize Phoenix**.
- Keep the **observability stack** out of the AgentStudio application chart: Phoenix runs in **`monitoring`** next to Prometheus/Grafana.
- Expose the Phoenix **UI** at **`phoenix.{endpoint}`** using the same pattern as other subdomains (Gateway → HTTPRoute → **apigateway-service** reverse proxy).

## Components

| Component | Namespace | Role |
|-----------|-----------|------|
| **Phoenix** (`arizephoenix/phoenix`) | `monitoring` | OTLP HTTP ingest on port **6006**, web UI and API on the same port; persists trace/session data to **SQLite** on a PVC at `/data` by default (`PHOENIX_SQL_DATABASE_URL` `sqlite:////data/phoenix.db`). Optional **PostgreSQL** via chart values. |
| **agent-service** | `nemo` | Exports spans via OpenTelemetry **OTLP HTTP** to `PHOENIX_COLLECTOR_ENDPOINT` (full URL including `/v1/traces`). Uses **OpenInference Agno** instrumentation. |
| **apigateway-service** | `nemo` | Reverse-proxies browser traffic for host `phoenix.*` to `PHOENIX_UI_URL` (cluster DNS to Phoenix). |
| **Gateway / HTTPRoute** | `nemo` | TLS and routing for `phoenix.{endpoint}` (hostname added via Helm helper `nemo.phoenixSubdomain`). |
| **NetworkPolicy** | `monitoring` | Allows ingress to Phoenix **:6006** only from pods labeled `component=agent-service` or `component=apigateway-service` in namespace `nemo`. |

## Data flow

1. **Traces (OTLP):** `agent-service` → `http://phoenix.monitoring.svc.cluster.local:6006/v1/traces` (cross-namespace).
2. **UI:** Browser → `https://phoenix.{endpoint}:8443` (typical) → Gateway → apigateway → `http://phoenix.monitoring.svc.cluster.local:6006`.

## Standards

- **OpenTelemetry** for export; **OpenInference** for Agno-specific attributes.
- **Retention:** `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS` in Phoenix env (default 30 in chart values).
- **Auth:** Phoenix OSS has no OIDC in this setup; the gateway **skips JWT** for `phoenix.*`. Restrict access in production via **NetworkPolicy**, VPN, or an OAuth2 proxy in front of Phoenix if required.

## Dependencies

- **Default (SQLite):** Only the PVC for `/data`; no dependency on `shared-postgresql`, so **`make deploy-observability` can run before foundation** without a chicken-and-egg issue.
- **Optional PostgreSQL:** Set `phoenix.database.backend: postgresql` and a `PHOENIX_SQL_DATABASE_URL` (or use the chart’s computed URL); enable `database.create` and an init container can create the `phoenix` DB once Postgres is reachable. Deploy foundation before or with observability in that mode.

## Related docs

- [phoenix-runbook.md](phoenix-runbook.md) — operations and troubleshooting.
- [OBSERVABILITY_PLAN.md](OBSERVABILITY_PLAN.md) — platform observability principles.
- [KIND_METRICS_SETUP.md](KIND_METRICS_SETUP.md) — local cluster setup including Phoenix.

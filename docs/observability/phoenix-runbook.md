# Runbook: Arize Phoenix (LLM observability)

## Deploy and upgrade

```bash
# From repo root — installs/updates kube-prometheus-stack + Phoenix into namespace monitoring
make helm-observability-upgrade
```

Optional: pass extra values (e.g. node selectors for Phoenix):

```bash
make helm-observability-upgrade HELM_EXTRA_ARGS="-f path/to/overlay.yaml"
```

For GKE with `ARCH_PIN_WORKLOADS=1`, `scripts/deploy-cloud-auto.sh` generates `observability-values-arch.auto.yaml` with `phoenix.nodeSelector`; use that file with `HELM_EXTRA_ARGS` when upgrading observability.

Chart path: [deployments/helm/observability](../../deployments/helm/observability). Phoenix is a **local subchart** under `charts/phoenix/`.

## Configuration reference

| Setting | Location | Notes |
|---------|----------|------|
| Phoenix image, resources, DB URL, retention | [deployments/helm/observability/values.yaml](../../deployments/helm/observability/values.yaml) `phoenix:` | Default: **SQLite** on the PVC (`database.backend: sqlite`, file under `PHOENIX_WORKING_DIR`). Optional: `database.backend: postgresql` + URL / init. |
| DB creation init | Phoenix subchart | Only when `database.backend: postgresql` and `database.create: true` — init waits for PG and runs `CREATE DATABASE` if needed. |
| Cross-namespace ingress | `deployments/helm/observability/templates/networkpolicy-phoenix-ingress.yaml` | Allows `nemo` **agent-service** and **apigateway-service** → Phoenix :6006. |
| Agent OTLP endpoint | AgentStudio `agent-service.env` | `PHOENIX_COLLECTOR_ENDPOINT=http://phoenix.monitoring.svc.cluster.local:6006/v1/traces` |
| OTLP export tuning (optional) | agent-service | `PHOENIX_OTLP_TIMEOUT_SECONDS` (default 30s HTTP client), `PHOENIX_OTLP_BSP_EXPORT_TIMEOUT_MS` (default 60000 batch wait). Raise if logs show `Failed to export span batch due to timeout` while Phoenix is slow or under load. |
| Gateway proxy target | AgentStudio `apigateway-service.env` | `PHOENIX_UI_URL=http://phoenix.monitoring.svc.cluster.local:6006` |
| Subdomain / TLS | Per-tier chart `_helpers.tpl` — `phoenixSubdomain` helper | Adds `phoenix.{endpoint}` to default Gateway hostnames. |

## Health checks

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=phoenix
kubectl logs -n monitoring deploy/phoenix --tail=100
kubectl get pvc -n monitoring | grep phoenix
```

Phoenix serves HTTP on **6006** (UI + OTLP). The chart sets **`PHOENIX_PORT`** to that integer because Kubernetes otherwise injects `PHOENIX_PORT=tcp://...` when the Service is named `phoenix`, which crashes Phoenix at startup.

## Verify traces

1. Confirm agent-service env:
   ```bash
   kubectl exec -n agentstudio-services deploy/agent-service -- printenv PHOENIX_COLLECTOR_ENDPOINT
   ```
2. Invoke any agent path that exercises the LLM.
3. Open Phoenix UI at **`https://phoenix.{your-endpoint}`** (or port-forward):
   ```bash
   kubectl port-forward -n monitoring svc/phoenix 6006:6006
   ```
   Then browse `http://localhost:6006`.

## Troubleshooting

| Symptom | Checks |
|---------|--------|
| Phoenix pod CrashLoopBackOff | **SQLite (default):** PVC mount and permissions on `/data`. **PostgreSQL mode:** PG reachable, password matches, init created DB. |
| No spans in UI / TCP timeout to `:6006` | `PHOENIX_COLLECTOR_ENDPOINT` unset or wrong; agent-service logs for `Phoenix tracing enabled`. **Egress:** [`agent-service` NetworkPolicy](../../deployments/helm/services/charts/agent-service/templates/networkpolicy.yaml) must allow TCP **6006** to Phoenix in `monitoring` (ingress on the Phoenix side alone is not enough). |
| UI 502 via Gateway | `PHOENIX_UI_URL` on apigateway; Phoenix pod running; DNS `phoenix.monitoring.svc.cluster.local` from nemo namespace. |
| `phoenix.{endpoint}` does not resolve (local) | CoreDNS hosts patch in AgentStudio chart should list `phoenix.{endpoint}`; or add manual `/etc/hosts` for dev. |
| High cardinality / PII | Tune retention (`PHOENIX_DEFAULT_RETENTION_POLICY_DAYS`); consider sampling in `tracing.py` (TraceIdRatioBased) for production. |

## Auth note

JWT validation is **skipped** for `phoenix.*` at the gateway (same pattern as `workflows.*`). Treat the UI as sensitive: use network controls in production.

## See also

- [phoenix-agent-observability-design.md](phoenix-agent-observability-design.md)

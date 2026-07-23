# Worker HPA Runbook (Prometheus Adapter)

This runbook covers safe rollout and operations for processing-worker autoscaling:

- `workers-kb` (phase 1 target)
- `workers-dataset`
- `workers-connector`

It assumes Helm chart values include per-worker `autoscaling` settings and HPA resources (`autoscaling/v2`).

## 0) Metrics Pipeline Architecture

Worker HPA depends on a working metrics pipeline. If any layer is missing, HPA
metrics show `<unknown>` and scaling is frozen.

```
┌─────────────────┐     ┌─────────────┐     ┌────────────────────┐     ┌─────┐
│ Temporal Server  │────▶│ Prometheus  │────▶│ prometheus-adapter │────▶│ HPA │
│ (port 9090)     │     │ (scrape)    │     │ (custom.metrics)   │     │     │
└─────────────────┘     └─────────────┘     └────────────────────┘     └─────┘
   ServiceMonitor          kube-prometheus       observability chart
   must be enabled         -stack                 prometheus-adapter.enabled=true
```

**For CPU-only scaling** (current default): only `metrics-server` is needed.

**For custom metric scaling** (queue backlog): the full pipeline above is required.

| Component | Where to enable | Verify |
|-----------|----------------|--------|
| metrics-server | `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml` | `kubectl top pods -n agentstudio-services` |
| Temporal ServiceMonitor | `temporal.metrics.serviceMonitor.enabled=true` in tier chart values | `kubectl get servicemonitors -n agentstudio-platform \| rg temporal` |
| prometheus-adapter | `prometheus-adapter.enabled=true` in observability chart values | `kubectl get apiservices \| rg custom.metrics` |

## 1) Preflight Checks

One-command preflight:

```bash
make helm-worker-hpa-preflight
```

Optional namespace override:

```bash
make helm-worker-hpa-preflight SERVICES_NAMESPACE=<namespace>
```

### 1.1 Metrics APIs are available

```bash
kubectl get apiservices | rg "metrics.k8s.io|custom.metrics.k8s.io"
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/nodes" >/dev/null && echo "metrics-server OK"
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" >/dev/null && echo "custom metrics API OK"
```

### 1.2 Adapter exposes expected metric names

Replace metric names with the ones configured in values:

```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | rg "temporal_queue_backlog_kb|temporal_queue_backlog_dataset|temporal_queue_backlog_connector"
```

### 1.3 Worker resources include CPU requests

HPA CPU utilization requires container CPU requests:

```bash
kubectl get deploy workers-kb -n agentstudio-workers -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}{"\n"}'
kubectl get deploy workers-dataset -n agentstudio-workers -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}{"\n"}'
```

## 2) Conflict-Safe Upgrade Preparation

If services/deployments were manually changed via `k9s scale` or `kubectl patch`, normalize live state before upgrade.

### 2.1 Reset service type drift

```bash
kubectl patch svc apigateway-service -n agentstudio-services -p '{"spec":{"type":"LoadBalancer"}}'
```

Use your chart value if different from `LoadBalancer`.

### 2.2 Reset deployment replicas drift

For non-HPA-managed deployments:

```bash
kubectl scale deploy kb-retrieval-service -n agentstudio-services --replicas=1
```

For HPA-managed processing workers, Helm should not manage `spec.replicas` when autoscaling is enabled.

## 3) Rollout Sequence

### Phase 1: CPU-only scaling (all workers)

Start with CPU-based autoscaling only. This requires only `metrics-server`:

- `processing-workers.*.autoscaling.enabled=true`
- `processing-workers.*.autoscaling.customMetric.enabled=false`
- `processing-workers.*.autoscaling.targetCPUUtilizationPercentage=60`

> **Important:** Do NOT enable both `customMetric` and `targetCPUUtilizationPercentage`
> on the same HPA. With `autoscaling/v2`, the HPA takes the MAX recommended replicas
> across all metrics. Baseline CPU from Temporal polling can veto scale-down even when
> the queue is empty.

Upgrade using the target for your cloud platform:

| Platform | Target |
|----------|--------|
| AKS | `make helm-workers-upgrade-aks` |
| GKE | `make helm-workers-upgrade-gke` |
| Local (KIND / k3d / Docker Desktop) | `make helm-workers-upgrade-local` |
| AWS (EKS) | `make helm-workers-upgrade-eks` _(target pending — will follow the same `-eks` suffix convention)_ |

Each cloud target applies the matching `values-<platform>.yaml` overlay and platform-specific flags (e.g. Workload Identity bindings on AKS, Filestore RWX on GKE). To deploy the full tier stack for a given platform run the corresponding `deploy-all-tiers-<platform>` target (e.g. `make deploy-all-tiers-aks`, `make deploy-all-tiers-gke`).

```bash
make helm-workers-upgrade-aks
```

### Phase 2: Deploy prometheus-adapter

After CPU-only scaling is stable:

1. Enable Temporal ServiceMonitor (already set in values):
   ```bash
   # Verify Temporal is being scraped
   kubectl get servicemonitors -n agentstudio-platform | rg temporal
   ```

2. Enable prometheus-adapter in the observability chart:
   ```bash
   make helm-observability-upgrade HELM_EXTRA_ARGS="--set prometheus-adapter.enabled=true"
   ```

3. Verify the adapter is serving metrics:
   ```bash
   kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | rg temporal_queue_backlog
   ```

### Phase 3: Switch workers to custom metric scaling

Once the adapter is confirmed serving metrics:

- Remove `targetCPUUtilizationPercentage` (set to `0` or omit)
- Set `customMetric.enabled=true`
- Run Helm upgrade

## 4) Post-Upgrade Verification

### 4.1 HPA objects and targets

```bash
kubectl get hpa -n agentstudio-workers | rg "workers-kb|workers-dataset|workers-connector"
kubectl describe hpa workers-dataset -n agentstudio-workers
```

### 4.2 Health conditions and events

Look for:

- `AbleToScale=True`
- `ScalingActive=True`
- No `FailedGetResourceMetric`
- No `FailedGetPodsMetric` / `FailedGetObjectMetric`

```bash
kubectl describe hpa workers-dataset -n agentstudio-workers | rg "AbleToScale|ScalingActive|FailedGet|Warning"
```

### 4.3 Deployment ownership behavior

For HPA-enabled workers, verify Helm no longer owns fixed replicas in deployment manifests (no upgrade conflict on `spec.replicas`).

```bash
make helm-tier-template-aks | rg -n "workers-dataset|replicas:"
```

## 5) Rollback / Fallback

### 5.1 Disable custom metric, keep CPU fallback

If custom metric API is flaky:

- set `customMetric.enabled=false`
- set `targetCPUUtilizationPercentage: 60`

### 5.2 Disable autoscaling for a worker

- set `autoscaling.enabled=false`
- set explicit fixed replicas (`replicas`)
- run Helm upgrade

### 5.3 Full rollback

```bash
helm history workers -n agentstudio-workers
helm rollback workers <revision> -n agentstudio-workers
```

## 6) Troubleshooting Quick Reference

### Symptom: HPA metrics show `<unknown>` — scaling is frozen

This is the most common issue. The HPA cannot fetch metrics and preserves the
current replica count indefinitely.

**For CPU metric `<unknown>`:**

```bash
# Is metrics-server running?
kubectl get deploy metrics-server -n kube-system
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/pods" | head -c 200

# If not installed:
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# For Kind/local clusters, add --kubelet-insecure-tls:
kubectl patch deployment metrics-server -n kube-system --type='json' \
  -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"}]'
```

**For custom metric `<unknown>`:**

```bash
# Is prometheus-adapter deployed?
kubectl get deploy -n monitoring | rg prometheus-adapter

# Is the custom.metrics.k8s.io API registered?
kubectl get apiservices | rg custom.metrics

# Does the adapter see the expected metrics?
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | rg temporal_queue_backlog

# Is Temporal being scraped by Prometheus?
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query?query=schedule_to_start_latency_count' | python3 -m json.tool
```

### Symptom: HPA never scales down (stays at high replica count)

Cause candidates (in order of likelihood):

1. **Dual metric lock** — Both CPU and custom metric enabled. `autoscaling/v2`
   takes the MAX across metrics, so baseline CPU from Temporal polling vetoes
   scale-down. Fix: use only one metric type.
2. **Scale-down stabilization too long** — Default was 300s (5 min). Reduce to
   120s for queue workers.
3. **Scale-down policy too conservative** — Default was 1 pod per 120s. Use
   2 pods per 60s for faster convergence.
4. **Custom metric never reaches 0** — Verify the PromQL query returns 0 when
   the queue is idle.

### Symptom: `UPGRADE FAILED ... conflict ... .spec.replicas`

Cause: manual scale changed field ownership and chart still manages replicas.

Fix:

1. Ensure worker deployment template omits `spec.replicas` when autoscaling is enabled.
2. Align non-HPA deployment replicas back to chart values.
3. Re-run `helm upgrade`.

### Symptom: HPA never scales up from 1 replica

Cause candidates:

- custom metrics API unavailable
- wrong metric name or selector
- metric value never crosses threshold
- missing CPU requests when CPU metric is used

Fix:

1. Verify APIs and metric discovery (Section 1).
2. Check `kubectl describe hpa` conditions/events.
3. Temporarily use CPU fallback only.

# Troubleshooting Guide - AgentStudio Deployment

## Common Issues and Solutions

### 1. PostgreSQL PVC Provisioning Failures

#### Issue: Pod Security Standards Blocking OpenEBS

If you see errors like:
```
pods "init-pvc-..." is forbidden: violates PodSecurity "baseline:latest": 
hostPath volumes (volumes "data", "dev"), privileged 
(container "local-path-init" must not set securityContext.privileged=true)
```

**Solution**: The namespace needs to allow privileged containers for OpenEBS hostpath provisioner.

The Helm chart now includes Pod Security Standards configuration. Ensure your namespace has the correct labels:

```bash
# Check current namespace labels
kubectl get namespace nemo -o yaml | grep pod-security

# If missing, label the namespace (or upgrade Helm chart)
kubectl label namespace nemo pod-security.kubernetes.io/enforce=privileged --overwrite
kubectl label namespace nemo pod-security.kubernetes.io/audit=privileged --overwrite
kubectl label namespace nemo pod-security.kubernetes.io/warn=privileged --overwrite
```

Or upgrade/reinstall the Helm chart which will apply these labels automatically:
```bash
make deploy-platform
```

#### Issue: OpenEBS Pod Security Standards Violations

If you see warnings/errors like:
```
Warning: would violate PodSecurity "restricted:latest": host namespaces (hostNetwork=true), 
privileged (container "openebs-ndm" must not set securityContext.privileged=true)
```

**Solution**: The OpenEBS namespace needs to allow privileged containers.

**Quick Fix**: Use the helper script:
```bash
./deployments/helm/scripts/fix-opebs-pod-security.sh
```

**Manual Fix**:
```bash
# Find OpenEBS namespace
kubectl get pods -A | grep openebs

# Apply privileged Pod Security Standards (replace <namespace> with actual namespace)
kubectl label namespace <openebs-namespace> \
    pod-security.kubernetes.io/enforce=privileged \
    pod-security.kubernetes.io/audit=privileged \
    pod-security.kubernetes.io/warn=privileged \
    --overwrite

# Restart OpenEBS
kubectl rollout restart daemonset -n <openebs-namespace>
kubectl rollout restart deployment -n <openebs-namespace>
```

#### Issue: Docker Hub Rate Limiting for OpenEBS

If you see errors like:
```
failed to pull and unpack image "docker.io/openebs/node-disk-operator:2.1.0": 
failed to copy: httpReadSeeker: failed open: unexpected status from GET request to 
https://registry-1.docker.io/v2/openebs/node-disk-operator/manifests/...: 429 Too Many Requests
```

**Solution**: Configure Docker Hub authentication or use an alternative StorageClass.

**Quick Fix**: Use a different StorageClass that doesn't require OpenEBS:

1. Check available StorageClasses:
```bash
kubectl get storageclass
```

2. Update values.yaml or use Helm --set:
```bash
helm upgrade nemo deployments/helm/nemo \
  --namespace nemo \
  --set global.storageClass=standard \
  --set postgresql.primary.persistence.storageClass=standard
```

Or update `deployments/helm/nemo/values.yaml`:
```yaml
global:
  storageClass: "standard"  # or another available StorageClass

postgresql:
  primary:
    persistence:
      storageClass: "standard"  # or another available StorageClass
```

#### Issue: Unbound PVCs on Trident CSI (multi-node, ONTAP NAS/SAN)

If you see:
```
0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.
```
and the cluster uses **Trident CSI** (e.g. ONTAP) with no default StorageClass, the shared PostgreSQL PVC (`data-shared-postgresql-0` in namespace `database`) and other PVCs need an explicit `storageClassName`.

**Solution: Use Trident values overlays**

1. **Discover your Trident StorageClass** (must support ReadWriteOnce for PostgreSQL, Redis, S3 gateway):
   ```bash
   kubectl get storageclass
   ```
   Use the Trident-backed class name (e.g. `trident-csi`, `ontap-san`). Replace `trident-csi` in the overlay files if different.

2. **Deploy in order.** The database chart is installed in **Phase 1 (Foundation)**; nemo in **Phase 3/4**. Pass the overlays so every release gets the same StorageClass:
   - **Phase 1 – Database (shared PostgreSQL):**
     ```bash
     make deploy-foundation HELM_EXTRA_ARGS="-f deployments/helm/database/values-trident.yaml"
     ```
     Or only the database upgrade:
     ```bash
     make helm-database-upgrade HELM_EXTRA_ARGS="-f deployments/helm/database/values-trident.yaml"
     ```
   - **Phase 3 & 4 – AgentStudio (Redis, S3 gateway PVCs):** Redis and S3 gateway use `global.storageClass` when component-level `storageClass` is unset. Pass the AgentStudio overlay:
     ```bash
     make deploy-platform-deps HELM_EXTRA_ARGS="-f deployments/helm/nemo/values-trident.yaml"
     make deploy-platform HELM_EXTRA_ARGS="-f deployments/helm/nemo/values-trident.yaml"
     ```

3. **If the shared PostgreSQL PVC already exists and is Pending:** The existing PVC was created without a StorageClass. Upgrade the database release with the Trident overlay first, then delete the PVC and the pod so the StatefulSet controller recreates the PVC from the updated template:
   ```bash
   kubectl delete pvc data-shared-postgresql-0 -n database
   kubectl delete pod shared-postgresql-0 -n database
   ```
   The StatefulSet will recreate the pod and a new PVC with the correct `storageClassName`. Wait for the new PVC to bind and the pod to become Ready.

4. **Bitnami PostgreSQL duplicate `storageClassName`:** Some Bitnami PostgreSQL chart versions render `storageClassName` twice in the StatefulSet, causing `YAMLException: duplicated mapping key`. If `helm template` or upgrade fails with that error, try:
   - Pinning the database subchart to a version that fixes it (see [Bitnami charts issues](https://github.com/bitnami/charts/issues)), or
   - Using `--set postgresql.primary.persistence.storageClass=trident-csi` instead of `-f values-trident.yaml` (if the duplicate still appears, the bug is in the chart template and a chart update is required).

### 2. Image Pull Errors

If pods show `ImagePullBackOff` or `ErrImagePull`:

1. Verify image registry is accessible
2. Check image pull secrets are configured:
```bash
kubectl get secrets -n nemo
```

3. Add image pull secrets to values.yaml:
```yaml
global:
  imagePullSecrets: ["regcred"]  # Your registry secret name
```

4. Verify image tags exist in your registry

### 3. PostgreSQL Connection Issues

If namespace-service can't connect to PostgreSQL:

1. Check PostgreSQL service name:
```bash
kubectl get svc -n nemo | grep postgresql
```

2. Verify the service name in namespace-service environment variables matches:
```yaml
# In deployments/helm/nemo/values.yaml
namespace-service:
  env:
    - name: DB_HOST
      value: "nemo-postgresql"  # Should match actual service name
```

3. Check PostgreSQL pod logs:
```bash
kubectl logs -n nemo -l app.kubernetes.io/component=postgresql
```

4. Verify database credentials in the secret:
```bash
kubectl get secret -n nemo nemo-postgresql -o yaml
```

### 4. Namespace Service Not Starting

1. Check pod status:
```bash
kubectl get pods -n nemo
kubectl describe pod <namespace-service-pod-name> -n nemo
```

2. Check logs:
```bash
kubectl logs -n nemo -l app.kubernetes.io/component=namespace-service
```

3. Verify database connection:
```bash
# Test PostgreSQL connectivity from namespace-service pod
kubectl exec -it <namespace-service-pod-name> -n nemo -- \
  sh -c 'nc -zv nemo-postgresql 5432'
```

### 5. GUI Not Accessible

1. Check service:
```bash
kubectl get svc -n nemo | grep gui
```

2. Check pod status:
```bash
kubectl get pods -n nemo | grep gui
```

3. Check logs:
```bash
kubectl logs -n nemo -l app.kubernetes.io/component=gui
```

4. Verify API service URL in gui configuration:
```yaml
# In deployments/helm/nemo/values.yaml
gui:
  apiService:
    name: namespace-service
    port: 8080
```

### 6. Debug Commands

Use the Makefile debug target:
```bash
make helm-nemo-debug
```

This will show:
- Deployment status
- ReplicaSet status
- Pod status
- ServiceAccount status
- Recent events
- Pod details

### 7. Verify Chart Renders Correctly

Before deploying, verify the chart renders:
```bash
make helm-nemo-template
```

Or manually:
```bash
cd deployments/helm/nemo
helm dependency update
helm template nemo . --namespace nemo
```

### 8. Check Helm Release Status

```bash
helm status nemo -n nemo
```

### 9. Reinstall if Necessary

If all else fails, try uninstalling and reinstalling:
```bash
make helm-nemo-uninstall
make deploy-platform
```

**Note**: Uninstalling will delete the PostgreSQL database. Backup data first if needed.

### 10. Apex Domain Not Resolving (Single-Label Wildcard DNS)

#### Symptom

Browser cannot reach the console at `https://{endpoint}/console` (e.g. `https://sks6078.sks.rtp.openeng.netapp.com:8443/console`) — `dig` returns NXDOMAIN for the bare endpoint — but subdomains like `auth.{endpoint}` resolve fine.

#### Cause

DNS wildcards match exactly one label at the wildcard's position. A wildcard record `*.{endpoint}` covers `auth.{endpoint}`, `s3.{endpoint}`, etc. (one label) but does **not** cover the apex `{endpoint}` itself (zero labels) and does **not** cover two-deep names like `*.ws.{endpoint}` or `*.s3.{endpoint}`. This is a property of DNS, not a misconfiguration of the cluster.

#### Resolution

The chart is designed to operate cleanly under a single-label wildcard:

- **Console + API gateway** is published on `{consoleSubdomain}.{endpoint}` (default `app.{endpoint}`) instead of the apex. Browse to `https://app.{endpoint}:8443/console`. See `consoleSubdomain` in `values.yaml`.
- **Workspaces** are published on `{workspaceLabelPrefix}<workspaceId>.{endpoint}` (default `ws-<id>.{endpoint}`) — single label so the wildcard covers them.
- **S3** uses path-style addressing only: `https://s3.{endpoint}/<bucket>/<key>` (not `https://<bucket>.s3.{endpoint}/<key>`). All in-tree clients enable `forcePathStyle` / `UsePathStyle` / `addressing_style: path`.
- **HTTPRoute hostnames**: see `nemo.defaultGatewayHostnames` in `templates/_helpers.tpl`. The list intentionally omits the apex and two-deep wildcards and includes `*.{endpoint}` to cover all single-label hosts (including dynamically allocated workspace hosts).
- **TLS**: a single wildcard cert for `*.{endpoint}` covers every public host (`app`, `auth`, `catalog`, `workflows`, `phoenix`, `s3`, and every `ws-<id>`). Provision it into the `nemo-gateway-tls` Secret (or use cert-manager — the chart's `Certificate` already pulls SANs from the same helper).

#### Verification

```bash
# Wildcard subdomains resolve to the LB IP:
dig app.{endpoint}                +short
dig ws-smoketest.{endpoint}       +short
# Apex still NXDOMAIN — and that is fine, nothing should target it any more:
dig {endpoint}                    +short

# HTTPRoute lists the right hostnames:
kubectl get httproute -n agentstudio -o yaml | grep -A 20 hostnames

# End-to-end:
curl -kI https://app.{endpoint}:8443/console
```

If you accidentally pin the canonical URL back to the apex, the OIDC redirect from Keycloak (which lives on `auth.{endpoint}`) will fail to land — the browser will hang on a hostname it cannot resolve. Re-run the keycloak-setup job after correcting `consoleHost` so the registered redirect URIs are reconciled.

### 11. Worker HPA Rollout and Helm Scale Conflicts

If Helm upgrades fail after manual `k9s`/`kubectl` scaling or service patching (field-manager conflicts on `.spec.replicas` or `.spec.type`), use the dedicated runbook:

- [`docs/observability/worker-hpa-runbook.md`](../../../docs/observability/worker-hpa-runbook.md)

It includes:

- conflict-safe pre-upgrade cleanup
- phased worker HPA rollout (`workers-kb` first)
- HPA verification checks (`FailedGet*Metric`, scale conditions)
- rollback and CPU fallback procedures

## Quick Diagnostic Checklist

- [ ] Dependencies updated (`helm dependency update`)
- [ ] Namespace exists (`kubectl get namespace nemo`)
- [ ] Namespace has Pod Security labels (`kubectl get namespace nemo -o yaml | grep pod-security`)
- [ ] Deployments created (`kubectl get deployments -n nemo`)
- [ ] ServiceAccount exists (`kubectl get serviceaccount -n nemo`)
- [ ] Shared PostgreSQL PVC is bound (`kubectl get pvc -n database`; look for `data-shared-postgresql-0` when using shared DB)
- [ ] Shared PostgreSQL pod is running (`kubectl get pods -n database | grep postgresql`) when using shared database in `database` namespace
- [ ] Pods exist (`kubectl get pods -n nemo`)
- [ ] No image pull errors (`kubectl describe pod <pod-name>`)
- [ ] No security context errors (check pod events)
- [ ] Sufficient node resources (`kubectl describe nodes`)

## Insufficient CPU / Insufficient Memory (Scheduling)

### Why you see "insufficient" when the host has enough RAM

Kubernetes **scheduling** is based on **requests**, not limits. The scheduler only places a pod on a node when the node’s **allocatable capacity minus sum of all pod requests** can satisfy that pod’s **requests**. So:

- **“Insufficient CPU” / “Insufficient memory”** usually means: no node has enough *unreserved* capacity to meet the **requests** of the pending pod. The host may have free RAM/CPU, but it’s already “reserved” by other pods’ requests.

### Should you remove LIMITS?

**Best practice: do not remove limits globally.**

| Resource | Recommendation | Reason |
|----------|----------------|--------|
| **Memory limits** | **Keep them.** | Without a limit, one pod can consume all node memory; the kernel OOM killer may kill critical processes or random pods. Set limits from actual usage + headroom. |
| **CPU limits** | Optional to remove or set much higher than requests. | CPU limits can cause throttling. Many teams omit CPU limits so pods can use spare CPU (burstable QoS). Tradeoff: one pod can temporarily starve others. |
| **Requests** | **Do not remove.** | Required for scheduling. If you remove requests, the scheduler cannot make good placement decisions. |

### What to do on a resource-constrained cluster

1. **Lower requests (and optionally limits)** so the same nodes can fit more pods. Use the provided overlay for development/small clusters:
   ```bash
   helm upgrade --install nemo ... -f values.yaml -f values-resource-constrained.yaml
   ```
2. **Right-size over time**: Use metrics (e.g. Prometheus, `kubectl top pod`) to set requests near typical usage and limits near peak usage.
3. **Optional**: For non-critical workloads, you can remove or raise **CPU** limits only (e.g. in a custom values file) if your charts support it; keep **memory** limits.


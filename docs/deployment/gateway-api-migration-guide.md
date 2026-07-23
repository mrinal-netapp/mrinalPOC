# Gateway API Migration Guide

This guide provides step-by-step instructions for migrating AgentStudio from Ingress NGINX to Kubernetes Gateway API.

## Overview

Gateway API is the future of Kubernetes ingress, replacing the deprecated Ingress NGINX. This migration provides:

- Better separation of concerns (Gateway = infrastructure, HTTPRoute = application routing)
- More powerful routing capabilities
- Standardized API across implementations
- Better support for advanced features

## Prerequisites

### Kubernetes Version

- **Minimum**: Kubernetes 1.24+
- Gateway API v1.4.1 requires K8s 1.24+
- Verify your version: `kubectl version --short`

### Required Tools

- `kubectl` (configured to access your cluster)
- `helm` 3.0+ (for deploying AgentStudio)
- `mkcert` (for local certificate generation) or `openssl` (for AWS/cloud/CI when mkcert is not available). Set `USE_OPENSSL=1` to force openssl; set `ENDPOINT` to your custom domain. In CI, set `CERT_DIR` if `$HOME` is not set.

### DNS contract: single-label wildcard

The chart targets clusters whose wildcard DNS resolves single-label subdomains (`*.${ENDPOINT}`) and does not assume the apex resolves. All public hostnames are single-label so a single `*.${ENDPOINT}` wildcard covers them:

| Purpose                | Public hostname                          |
|------------------------|------------------------------------------|
| Console + API gateway  | `${CONSOLE_SUBDOMAIN:-app}.${ENDPOINT}`  |
| Auth (Keycloak)        | `auth.${ENDPOINT}`                       |
| Catalog (Lakekeeper)   | `catalog.${ENDPOINT}`                    |
| Workflows (Temporal)   | `workflows.${ENDPOINT}`                  |
| Phoenix UI             | `phoenix.${ENDPOINT}`                    |
| S3 (path-style only)   | `s3.${ENDPOINT}`                         |
| Workspaces             | `${WORKSPACE_LABEL_PREFIX:-ws-}<id>.${ENDPOINT}` |

The legacy `*.ws.${ENDPOINT}` and `*.s3.${ENDPOINT}` two-deep wildcards are no longer in the routing or SAN list — they were unreachable under a single-label wildcard. Workspaces moved to `ws-<id>.${ENDPOINT}` and S3 uses path-style addressing only (`https://s3.${ENDPOINT}/<bucket>/<key>`).

A single wildcard cert for `*.${ENDPOINT}` covers all of the above. `prepare-nemo-gateway.sh` issues an openssl/mkcert SAN list aligned with this contract; with cert-manager enabled, the chart's `Certificate` pulls SANs from `nemo.effectiveGatewayHostnames`.

## Installation Steps

### Step 1: Install Gateway API CRDs

Install the Gateway API Custom Resource Definitions:

```bash
# Option 1: Using the Makefile (recommended)
make install-gateway-api

# Option 2: Manual installation (using server-side apply)
kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.1/standard-install.yaml
```

Verify installation:

```bash
kubectl get crd | grep gateway.networking.k8s.io
```

You should see CRDs like:
- `gateways.gateway.networking.k8s.io`
- `httproutes.gateway.networking.k8s.io`
- `gatewayclasses.gateway.networking.k8s.io`

### Step 2: Install NGINX Gateway Fabric (NGF) Controller

The `install-gateway-api` Makefile target installs both Gateway API CRDs and NGF via Helm OCI. To install only the controller manually:

```bash
# Using Makefile (recommended; installs CRDs + NGF)
make install-gateway-api

# Or install NGF manually via Helm OCI (Gateway API CRDs must already be installed)
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric --create-namespace -n nginx-gateway
```

Optional: pin NGF version with `NGF_HELM_VERSION=2.4.0 make install-gateway-api`. Use a different release name with `NGF_HELM_RELEASE=myngf make install-gateway-api` (AgentStudio values must use the same GatewayClass name, e.g. `nginx`).

Verify controller installation:

```bash
kubectl get pods -n nginx-gateway
kubectl get gatewayclass
```

### Step 3: Verify GatewayClass

Ensure a GatewayClass named `nginx` exists:

```bash
kubectl get gatewayclass nginx
```

If it doesn't exist, the installation script will create it automatically.

## Migration Procedure

### Step 1: Update Helm Values

The AgentStudio Helm chart now defaults to Gateway API. The `values.yaml` has been updated with:

- `gateway.enabled: true` (default)
- `ingress.enabled: false` (default, for backward compatibility)

No changes needed unless you want to customize the configuration.

### Step 2: Prepare Certificates

Certificates are automatically prepared by `deploy-local-bootstrap-fresh` (for local clusters) as part of the tier-based local deploy. The script:

1. Generates SSL certificates using `mkcert` (or `openssl` when mkcert is not available or `USE_OPENSSL=1`)
2. Creates TLS secrets in the services namespace
3. Verifies Gateway API components are installed

Manual preparation (if needed):

```bash
ENDPOINT=agentstudio.local NAMESPACE=agentstudio-services scripts/prepare-nemo-gateway.sh
```

For AWS/cloud or CI: use `ENDPOINT=nemo-demo.example.com USE_OPENSSL=1` (or leave mkcert uninstalled so the script uses openssl). Leave `WORKSPACE_SUBDOMAIN` unset to get `ws.${ENDPOINT}`. Set `CERT_DIR` if `$HOME` is not set.

### Step 3: Deploy AgentStudio with Gateway API

Deploy or upgrade AgentStudio using the Makefile:

```bash
# Full AKS deployment (includes Gateway API configuration)
make deploy-all-tiers-aks

# Individual services tier upgrade
make helm-services-upgrade-aks
```

> **Note**: The legacy `ENABLE_GATEWAY=1` and `ENABLE_INGRESS=1` flags (previously accepted by `make deploy-platform`) have been removed. The tiered deployment always uses Gateway API via NGINX Gateway Fabric; legacy Kubernetes Ingress is no longer supported.

```bash
```

The Makefile automatically:
- Prepares TLS certificates (via `deploy-local-bootstrap-fresh` for local clusters; via `prepare-nemo-gateway.sh` for AKS)
- Sets `gateway.enabled=true` for the services tier
- Sets `ingress.enabled=false` (Gateway API is the only supported ingress)
- Configures TLS certificate references in the Gateway resource

### Step 4: Verify Deployment

Check Gateway and HTTPRoute resources:

```bash
# Check Gateway
kubectl get gateway -n agentstudio-services
kubectl describe gateway -n agentstudio-services

# Check HTTPRoute
kubectl get httproute -n agentstudio-services
kubectl describe httproute -n agentstudio-services

# Check Gateway status
kubectl get gateway -n agentstudio-services -o yaml | grep -A 10 status
```

Expected output:

```bash
$ kubectl get gateway -n agentstudio-services
NAME              CLASS   ADDRESS         READY   AGE
nemo-gateway     nginx   10.96.0.1       True    5m

$ kubectl get httproute -n agentstudio-services
NAME                HOSTNAMES                                    AGE
nemo-httproute     agentstudio.local,*.ws.agentstudio.local,...     5m
```

### Step 5: Test Routing

Test that routing works correctly:

```bash
# Test HTTP endpoint
curl -k http://agentstudio.local:8080/health

# Test HTTPS endpoint
curl -k https://agentstudio.local:8443/health

# Test workspace subdomain
curl -k https://test.ws.agentstudio.local:8443/
```

## Feature Parity Comparison

### Supported Features

| Feature | Ingress NGINX | Gateway API | Notes |
|--------|---------------|-------------|-------|
| HTTP/HTTPS routing | ✅ | ✅ | Fully supported |
| TLS termination | ✅ | ✅ | Fully supported |
| Wildcard hostnames | ✅ | ✅ | Fully supported |
| Path-based routing | ✅ | ✅ | Fully supported |
| Multiple hosts | ✅ | ✅ | Fully supported |

### Configuration Differences

| Setting | Ingress NGINX | Gateway API |
|---------|---------------|-------------|
| Timeouts | Annotations | GatewayClass/Controller ConfigMap |
| Keepalive | Annotations | GatewayClass/Controller ConfigMap |
| Buffers | Annotations | GatewayClass/Controller ConfigMap |
| Rate Limiting | Annotations | Policy attachments or Controller ConfigMap |
| Retry Logic | Annotations | HTTPRoute filters or Controller ConfigMap |
| HTTP/2 | Annotations | Gateway listener (automatic for HTTPS) |

See [Gateway API - NGINX Annotations Mapping](gateway-api-nginx-annotations-mapping.md) for detailed mapping.

## Note on Legacy Ingress

Legacy Ingress NGINX support has been completely removed. Gateway API is now the only supported ingress method. If you need to migrate from an existing Ingress deployment, follow the migration steps in this guide.

### Option 2: Manual Rollback

1. Set values in `values.yaml` or via Helm:

```bash
make helm-services-upgrade-aks HELM_EXTRA_ARGS="--set gateway.enabled=false --set ingress.enabled=true"
```

2. Verify Ingress is created:

```bash
kubectl get ingress -n agentstudio-services
```

3. Remove Gateway resources (optional):

```bash
kubectl delete gateway -n agentstudio-services --all
kubectl delete httproute -n agentstudio-services --all
```

## Troubleshooting

### Gateway Not Ready

If Gateway shows `READY=False`:

```bash
# Check Gateway status
kubectl describe gateway -n agentstudio-services

# Check GatewayClass
kubectl get gatewayclass nginx

# Check controller logs
kubectl logs -n nginx-gateway -l app.kubernetes.io/name=nginx-gateway
```

### HTTPRoute Not Attached

If HTTPRoute doesn't attach to Gateway:

```bash
# Check HTTPRoute status
kubectl describe httproute -n agentstudio-services

# Verify parentRefs
kubectl get httproute -n agentstudio-services -o yaml | grep -A 5 parentRefs

# Check Gateway listeners allow the route
kubectl get gateway -n agentstudio-services -o yaml | grep -A 10 listeners
```

### TLS Certificate Issues

If TLS doesn't work:

```bash
# Check TLS secret exists
kubectl get secret nemo-gateway-tls -n agentstudio-services

# Verify certificate in Gateway
kubectl get gateway -n agentstudio-services -o yaml | grep -A 10 certificateRefs

# Check certificate format
kubectl get secret nemo-gateway-tls -n agentstudio-services -o yaml
```

### Port Configuration

Gateway API uses ports 8080 (HTTP) and 8443 (HTTPS) by default, matching the gateway service ports. If you need different ports:

1. Update `values.yaml`:
```yaml
gateway:
  listeners:
    http:
      port: 8080
    https:
      port: 8443
```

2. Update service configuration if needed:
```yaml
gateway:
  service:
    port: 8080
    httpsPort: 8443
```

## Performance Configuration

Many NGINX-specific performance optimizations need to be configured at the GatewayClass or controller level. See [Gateway API - NGINX Annotations Mapping](gateway-api-nginx-annotations-mapping.md) for details.

### Gateway NGINX Controller ConfigMap

Configure performance settings via the controller ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-gateway-config
  namespace: nginx-gateway
data:
  proxy-connect-timeout: "10s"
  proxy-send-timeout: "20s"
  proxy-read-timeout: "20s"
  upstream-keepalive-connections: "128"
  client-max-body-size: "200m"
```

## Makefile Usage Updates

### New Targets

- `make install-gateway-api` - Install Gateway API CRDs and controller
- `make optimize-gateway-nginx` - Optimize Gateway NGINX controller

### Updated Targets

- `make helm-services-upgrade-aks` - Uses Gateway API by default
  - Gateway API is the default and only supported method

### Deprecated Targets

- Legacy Ingress NGINX support has been removed. Use Gateway API instead.

## References

- [Gateway API Specification](https://gateway-api.sigs.k8s.io/)
- [Gateway NGINX Documentation](https://github.com/nginxinc/nginx-kubernetes-gateway)
- [Gateway API - NGINX Annotations Mapping](gateway-api-nginx-annotations-mapping.md)

## Support

For issues or questions:

1. Check Gateway and HTTPRoute status: `kubectl get gateway,httproute -n agentstudio-services`
2. Review controller logs: `kubectl logs -n nginx-gateway -l app.kubernetes.io/name=nginx-gateway`
3. Check Gateway API CRDs: `kubectl get crd | grep gateway`
4. Verify GatewayClass: `kubectl get gatewayclass`

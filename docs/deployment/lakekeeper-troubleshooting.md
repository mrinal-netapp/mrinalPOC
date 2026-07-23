# Lakekeeper & Helm Troubleshooting Guide

## Table of Contents

- [Helm Upgrade Issues](#helm-upgrade-issues)
  - [Strategic Merge Patch Errors](#strategic-merge-patch-errors)
  - [Duplicate Environment Variable Warnings](#duplicate-environment-variable-warnings)
  - [Unknown Field Warning: imagePullSecrets](#unknown-field-warning-imagepullsecrets)
  - [Helm Release in Failed State](#helm-release-in-failed-state)
  - [General Helm Upgrade Tips](#general-helm-upgrade-tips)
- [Lakekeeper Bootstrap](#lakekeeper-bootstrap)
  - [Automatic Bootstrap](#automatic-bootstrap)
  - [Manual Bootstrap](#manual-bootstrap)
  - [Default Bucket and Warehouse](#default-bucket-and-warehouse)
- [UI Authentication (OIDC)](#ui-authentication-oidc)
  - [401 Unauthorized on UI Access](#401-unauthorized-on-ui-access)
  - [Required OIDC Configuration](#required-oidc-configuration)
  - [Public URI vs Base URI](#public-uri-vs-base-uri)
  - [Environment-Specific Configuration](#environment-specific-configuration)
  - [CORS Errors](#cors-errors)
  - [Related Keycloak Configuration](#related-keycloak-configuration)
- [API Endpoints](#api-endpoints)
  - [Warehouse Management Endpoints](#warehouse-management-endpoints)
  - [Catalog Endpoints](#catalog-endpoints)
  - [Request and Response Formats](#request-and-response-formats)
- [S3 Endpoint Configuration](#s3-endpoint-configuration)
  - [Access Denied When Writing to S3](#access-denied-when-writing-to-s3)
  - [Endpoint Format](#endpoint-format)
  - [Deployment Endpoint Resolution](#deployment-endpoint-resolution)
- [Service URL Resolution](#service-url-resolution)
  - [DNS Resolution Failure](#dns-resolution-failure)
  - [Auto-Constructed Service URL](#auto-constructed-service-url)
  - [Manual Override](#manual-override)

---

## Helm Upgrade Issues

### Strategic Merge Patch Errors

**Error:**

```
Error: UPGRADE FAILED: failed to create patch: list element types are not identical
```

**Root cause:** Helm performs strategic merge patches on arrays (e.g. environment variables). If the structure in `values.yaml` diverges from the deployed state — such as missing secret-based env vars that exist in the live deployment — the merge fails because the array element types are incompatible.

**Fix:** Ensure `values.yaml` contains all env var entries that match the currently deployed state, including any secret-referencing entries. Then retry the upgrade.

**Alternative recovery options:**

| Method | Command | Notes |
|--------|---------|-------|
| Force recreation | `kubectl delete deployment lakekeeper -n <namespace>` then redeploy | Causes brief downtime |
| Helm force | `helm upgrade <release> <chart> -n <namespace> --force` | Replaces instead of patching |
| Manual edit | `kubectl edit deployment lakekeeper -n <namespace>` | Remove conflicting env vars, then redeploy |

### Duplicate Environment Variable Warnings

**Warnings:**

```
Warning: spec.template.spec.containers[0].env[3]: hides previous definition of "LAKEKEEPER__PG_USER"
Warning: spec.template.spec.containers[0].env[4]: hides previous definition of "LAKEKEEPER__PG_PASSWORD"
Warning: spec.template.spec.containers[0].env[5]: hides previous definition of "LAKEKEEPER__PG_ENCRYPTION_KEY"
```

**Root cause:** The Lakekeeper Helm chart automatically creates env vars from the `externalDatabase` configuration block:

- `LAKEKEEPER__PG_USER` from `externalDatabase.userSecret`
- `LAKEKEEPER__PG_PASSWORD` from `externalDatabase.passwordSecret`
- `LAKEKEEPER__PG_ENCRYPTION_KEY` from encryption configuration

If `catalog.extraEnv` also defines these variables, Kubernetes receives duplicates. It uses the **last** definition and silently drops earlier ones, which can cause unpredictable behavior when ordering changes.

**Fix:** Remove `LAKEKEEPER__PG_USER`, `LAKEKEEPER__PG_PASSWORD`, and `LAKEKEEPER__PG_ENCRYPTION_KEY` from `catalog.extraEnv`. Configure them exclusively through `externalDatabase`:

```yaml
externalDatabase:
  userSecret: "shared-postgresql-secret"
  userSecretKey: "postgres"
  passwordSecret: "shared-postgresql-secret"
  passwordSecretKey: "postgres-password"
  encryptionKeySecret: "lakekeeper-postgres-encryption"
  encryptionKeySecretKey: "encryptionKey"
```

### Unknown Field Warning: imagePullSecrets

```
Warning: unknown field "metadata.imagePullSecrets"
```

This is an informational warning from the Lakekeeper subchart. It does not affect functionality and can be safely ignored. The `global.imagePullSecrets` configuration works correctly for all other components.

### Helm Release in Failed State

```bash
helm list -n <namespace>

# If in failed state, retry the upgrade (Helm will attempt recovery)
helm upgrade <release> <chart> -n <namespace>
```

If retrying doesn't work, consider uninstalling and reinstalling (note: this causes data loss unless the database is external).

### General Helm Upgrade Tips

**Pre-upgrade checks:**

```bash
helm get values <release> -n <namespace>
kubectl get deployment lakekeeper -n <namespace> -o yaml > lakekeeper-current.yaml
```

**Dry run:**

```bash
helm upgrade <release> <chart> -n <namespace> --dry-run --debug
```

**Rollback:**

```bash
helm history <release> -n <namespace>
helm rollback <release> -n <namespace>          # previous revision
helm rollback <release> <revision> -n <namespace>  # specific revision
```

**Monitor during upgrade:**

```bash
watch kubectl get pods -n <namespace>
kubectl logs -n <namespace> deployment/lakekeeper --tail=50
```

**Best practices:**

- Back up before major upgrades: `kubectl get all -n <namespace> -o yaml > backup-$(date +%Y%m%d).yaml`
- Edit `values.yaml` directly rather than using fragile `--set array[index].field=value` syntax
- Use `--set-json` or `-f override.yaml` for complex value overrides
- Test upgrades in non-production environments first

---

## Lakekeeper Bootstrap

### Automatic Bootstrap

The standard Helm install/upgrade includes a post-deploy hook job (`default-setup`) that runs after Keycloak setup. It:

1. Registers the default S3 bucket in S3gateway
2. Calls the Lakekeeper bootstrap API (accepts EULA/terms)
3. Creates the default warehouse

No manual bootstrap is required — the app is ready for users once the hook completes.

To disable: set `defaultSetup.enabled: false` or `s3gateway.defaultBucket.enabled: false`.

**Check if bootstrap is still needed:**

```bash
kubectl logs -n <namespace> -l app.kubernetes.io/name=lakekeeper | grep -i bootstrap
# "The catalog is open for bootstrap" means bootstrapping is required
```

### Manual Bootstrap

**Via API:**

```bash
TOKEN="<keycloak-access-token>"

curl -X POST https://<domain>:<port>/internal/lakekeeper/v1/bootstrap \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "admin_user": "admin@example.com" }'
```

**Via UI:** Navigate to `https://<domain>:<port>/internal/lakekeeper/ui` and follow the bootstrap prompts.

**If bootstrap fails:**

```bash
kubectl logs -n <namespace> -l app.kubernetes.io/name=lakekeeper | tail -100
kubectl logs -n <namespace> -l app.kubernetes.io/name=lakekeeper | grep -i "postgres\|database"
kubectl get secret -n <namespace> | grep -E "postgresql|lakekeeper|keycloak"
```

### Default Bucket and Warehouse

On deploy, the chart creates:

- **Default S3 bucket:** `default-<release-name>` (e.g. `default-nemo`), backed by a PVC. Size is configurable via `s3gateway.defaultBucket.size` (default 10Gi). For custom release names, set `s3gateway.defaultBucket.name=default-<release-name>`.
- **Default warehouse:** Created by the `default-setup` Helm hook (post-install/post-upgrade, weight 10), using the default bucket and default S3 credentials. The warehouse name matches the default bucket name unless overridden via `defaultSetup.warehouseName`.

The `default-setup` job is idempotent: bucket-already-exists, bootstrap-already-done, and warehouse-409 responses are all treated as success.

---

## UI Authentication (OIDC)

### 401 Unauthorized on UI Access

**Symptom:**

```
GET https://<domain>:<port>/ui/ 401 (Unauthorized)
{"error":"Unauthorized","message":"Missing Authorization header"}
```

**Root cause:** The Lakekeeper UI is an OIDC public client but the `LAKEKEEPER__UI__OPENID_PROVIDER_URI` environment variable was missing. Without it, the UI cannot redirect to the identity provider for authentication and instead expects a Bearer token that the browser doesn't have.

### Required OIDC Configuration

```yaml
catalog:
  extraEnv:
    # Backend OIDC (service-to-service)
    - name: LAKEKEEPER__OPENID_PROVIDER_URI
      value: "http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/<realm>"
    - name: LAKEKEEPER__OPENID_CLIENT_ID
      valueFrom:
        secretKeyRef:
          name: keycloak-oidc-secrets
          key: lakekeeper-client-id
    - name: LAKEKEEPER__OPENID_CLIENT_SECRET
      valueFrom:
        secretKeyRef:
          name: keycloak-oidc-secrets
          key: lakekeeper-client-secret

    # UI OIDC (browser authentication)
    - name: LAKEKEEPER__UI__OPENID_PROVIDER_URI
      value: "https://auth.<domain>:<port>/realms/<realm>"
    - name: LAKEKEEPER__UI__OPENID_CLIENT_ID
      valueFrom:
        secretKeyRef:
          name: keycloak-oidc-secrets
          key: lakekeeper-ui-client-id
    - name: LAKEKEEPER__UI__OPENID_SCOPE
      value: "openid profile email"
```

The backend OIDC provider URI points to the **internal** Keycloak service. The UI OIDC provider URI must point to the **external** Keycloak URL that the browser can reach.

### Public URI vs Base URI

```yaml
- name: LAKEKEEPER__BASE_URI
  value: "http://lakekeeper:8181"
- name: LAKEKEEPER__PUBLIC_URI
  value: "https://<domain>:<port>/internal/lakekeeper"
```

| Variable | Used by | Must be reachable from |
|----------|---------|----------------------|
| `BASE_URI` | Backend services | Inside the cluster |
| `PUBLIC_URI` | UI (browser) | Outside the cluster |

If the UI is making API calls to the internal `BASE_URI` instead of the external `PUBLIC_URI`, the `PUBLIC_URI` configuration is not being applied.

### Environment-Specific Configuration

Update the external-facing URIs for each environment:

```yaml
- name: LAKEKEEPER__PUBLIC_URI
  value: "https://<domain>:<port>/internal/lakekeeper"
- name: LAKEKEEPER__UI__OPENID_PROVIDER_URI
  value: "https://auth.<domain>:<port>/realms/<realm>"
```

**Verify after deployment:**

```bash
kubectl get pod -n <namespace> -l app.kubernetes.io/name=lakekeeper -o yaml \
  | grep -A2 "PUBLIC_URI\|UI__OPENID_PROVIDER_URI"
```

### CORS Errors

There are **two distinct** CORS surfaces in the catalog stack. Browser console
errors usually point to one or the other.

**1. Lakekeeper API CORS** (browser → `catalog.<endpoint>` API calls)

If Lakekeeper itself rejects cross-origin API calls, configure its allow list:

```yaml
- name: LAKEKEEPER__CORS__ALLOW_ORIGINS
  value: "https://<domain>:<port>"
```

Verify in logs:

```bash
kubectl logs -n <namespace> -l app.kubernetes.io/name=lakekeeper | grep -i cors
```

**2. S3 (object storage) CORS** (browser → `s3.<endpoint>` direct reads)

Symptom — error text mentions DuckDB, Iceberg metadata, and lists required
headers `authorization, content-type, range, x-user-agent`:

```
CORS Error: Cannot access object storage from the browser.
DuckDB tried to read Iceberg metadata files from object storage ...
1. Cross-origin requests from https://catalog.<endpoint>:8443
2. Required headers: authorization, content-type, range, x-user-agent
3. HTTP methods: GET, HEAD, OPTIONS
4. Expose headers: content-range, content-length, etag
```

Root cause: the Lakekeeper UI uses DuckDB-WASM **in the browser** to read
Iceberg metadata (and parquet data files) directly from `s3.<endpoint>`. That
is a cross-origin request from `catalog.<endpoint>` to `s3.<endpoint>`, so the
S3 gateway must serve CORS preflight and response headers that cover:

- the catalog origin in `Access-Control-Allow-Origin`
- `Range`, `X-User-Agent`, `Authorization`, `X-Host-Override` in
  `Access-Control-Allow-Headers` (the UI adds `X-Host-Override` when its
  configured S3 URL differs from the storage endpoint)
- `Content-Range`, `Accept-Ranges`, `ETag`, `Content-Length` in
  `Access-Control-Expose-Headers`

The apigateway-service S3 proxy handles this and auto-allows any
`<sub>.<endpoint>` origin where `<endpoint>` matches the `PUBLIC_ENDPOINT`
environment variable (wired from the Helm chart's `global.endpoint`). Verify
the apigateway pod actually has it set:

```bash
kubectl get pod -n <namespace> -l app.kubernetes.io/name=apigateway-service \
  -o jsonpath='{.items[0].spec.containers[0].env}' | tr ',' '\n' | grep PUBLIC_ENDPOINT
```

If `PUBLIC_ENDPOINT` is empty or wrong, the suffix match fails and the proxy
does **not** echo the catalog origin in `Access-Control-Allow-Origin` (it emits
no CORS grant for the untrusted origin rather than a wildcard). The browser then
blocks the credentialed cross-origin read and the table page fails to load. Fix
by setting `global.endpoint` (or `endpoint`) in your values file to match the
actual public hostname so the proxy recognizes the `catalog.<endpoint>` origin.

### Related Keycloak Configuration

The Keycloak OIDC client must have matching redirect URIs:

```python
"redirectUris": [
    f"http://{domain}/internal/lakekeeper/ui/*",
    f"https://{domain}/internal/lakekeeper/ui/*",
    f"http://{domain}:{port}/internal/lakekeeper/ui/*",
    f"https://{domain}:{port}/internal/lakekeeper/ui/*",
]
```

The API gateway proxies `/internal/lakekeeper` to the `LAKEKEEPER_URL` backend. Auth is bypassed at the gateway level because Lakekeeper handles its own OIDC authentication.

---

## API Endpoints

### Warehouse Management Endpoints

| Operation | Method | Path |
|-----------|--------|------|
| Create warehouse | `POST` | `/management/v1/warehouse` |
| List warehouses | `GET` | `/management/v1/warehouse` |
| Get warehouse | `GET` | `/management/v1/warehouse/{id}` |

Getting a warehouse by name requires listing all warehouses and filtering client-side, since the API uses UUIDs for direct access.

### Catalog Endpoints

All catalog endpoints use the format `/v1/{prefix}/namespaces/...` where `{prefix}` is typically empty for the default catalog.

| Operation | Method | Path |
|-----------|--------|------|
| Create namespace | `POST` | `/v1/{prefix}/namespaces` |
| List namespaces | `GET` | `/v1/{prefix}/namespaces` |
| Get namespace | `GET` | `/v1/{prefix}/namespaces/{namespace}` |
| Update namespace properties | `POST` | `/v1/{prefix}/namespaces/{namespace}/properties` |
| Delete namespace | `DELETE` | `/v1/{prefix}/namespaces/{namespace}` |
| Create table | `POST` | `/v1/{prefix}/namespaces/{namespace}/tables` |
| List tables | `GET` | `/v1/{prefix}/namespaces/{namespace}/tables` |
| Get table | `GET` | `/v1/{prefix}/namespaces/{namespace}/tables/{table}` |
| Delete table | `DELETE` | `/v1/{prefix}/namespaces/{namespace}/tables/{table}` |

When `{prefix}` is empty, the path normalizes to `/v1/namespaces`. If that fails, try the explicit double-slash form `/v1//namespaces`.

Namespace parts can be separated by dots (`.`) or the unit separator character (`\x1F`).

### Request and Response Formats

**Create warehouse request:**

```json
{
  "warehouse-name": "my-bucket",
  "storage-profile": {
    "type": "s3",
    "bucket": "my-bucket",
    "region": "us-east-1",
    "sts-enabled": false,
    "endpoint": "https://s3.example.com"
  }
}
```

**List warehouses response:** `{ "warehouses": [...] }`

**List namespaces response:** `{ "namespaces": [...] }`

**List tables response:** `{ "identifiers": [...] }` — map identifiers to table names.

---

## S3 Endpoint Configuration

### Access Denied When Writing to S3

**Error:**

```
IO operation failed (PermissionDenied): S3 write failed: Access Denied at `s3://nemo/0`
```

**Root cause:** Warehouses were created without a custom S3 endpoint in their storage profile. Lakekeeper defaults to AWS S3 endpoints, which cannot reach custom S3-compatible storage (e.g. an API gateway fronting MinIO/S3gateway).

**Fix:** Pass the S3 endpoint when creating warehouses. The dataset creation flow must:

1. Resolve the deployment endpoint for the target bucket (from deployment assignments)
2. Prepend `s3.` to the hostname to form the S3 endpoint
3. Include the endpoint in the warehouse storage profile

### Endpoint Format

The S3 endpoint is derived by adding an `s3.` prefix to the deployment endpoint hostname:

| Deployment endpoint | S3 endpoint |
|---------------------|-------------|
| `https://us-east-1.example.com` | `https://s3.us-east-1.example.com` |

This prefix is required for the API gateway to route S3 requests correctly.

The endpoint is included in the `storage-profile` when creating a warehouse:

```json
{
  "warehouse-name": "my-bucket",
  "storage-profile": {
    "type": "s3",
    "bucket": "my-bucket",
    "region": "us-east-1",
    "sts-enabled": false,
    "endpoint": "https://s3.us-east-1.example.com"
  }
}
```

### Deployment Endpoint Resolution

The resolution logic:

1. Get all active deployment assignments for the bucket
2. Filter for primary deployments with healthy status
3. Sort by priority (highest first)
4. Fall back to any primary deployment if none are healthy
5. Fall back to the first deployment if no primary is found

Buckets must be assigned to a deployment before datasets can be created. If no deployment endpoint is found, dataset creation fails with a descriptive error.

---

## Service URL Resolution

### DNS Resolution Failure

**Error:**

```
Failed to get warehouse: getaddrinfo ENOTFOUND lakekeeper
```

**Root cause:** When Helm installs a subchart (like lakekeeper), the Kubernetes service name is prefixed with the Helm release name. For a release named `nemo`, the service is `nemo-lakekeeper`, not `lakekeeper`.

### Auto-Constructed Service URL

The config-service deployment template dynamically constructs the Lakekeeper service URL:

```
http://<release-name>-lakekeeper.<namespace>.svc.cluster.local:8181
```

If `LAKEKEEPER_URL` is empty or unset, the template builds the URL from `.Release.Name` and `.Release.Namespace`. If explicitly set, the provided value is used as-is.

**Verify the service exists:**

```bash
kubectl get svc -n <namespace> | grep lakekeeper
```

**Test connectivity from a config-service pod:**

```bash
kubectl exec -n <namespace> <config-service-pod> -- \
  curl -v http://<release>-lakekeeper.<namespace>.svc.cluster.local:8181/health
```

### Manual Override

To use a custom service URL, set it explicitly in `values.yaml`:

```yaml
config-service:
  env:
    - name: LAKEKEEPER_URL
      value: "http://custom-lakekeeper-service:8181"
```

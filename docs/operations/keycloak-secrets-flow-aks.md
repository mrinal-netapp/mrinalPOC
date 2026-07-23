# Keycloak OIDC Secrets Flow - Architecture Diagram

## Current Implementation (Phase 1 - Manual Bridge)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AZURE KEY VAULT                                  │
│  (agentstudio-keycloak-addl-dev-<region>)                               │
│                                                                          │
│  ├─ agentstudio-analytics-engine     → "abc123..."                      │
│  ├─ agentstudio-config-service       → "ZN4U9OxOxjl2..."                │
│  ├─ agentstudio-workflow-engine      → "def456..."                      │
│  ├─ agentstudio-agent-service        → "ghi789..."                      │
│  ├─ agentstudio-storage-manager      → "jkl012..."                      │
│  ├─ agentstudio-connector-worker     → "mno345..."                      │
│  ├─ agentstudio-lakekeeper           → "pqr678..."                      │
│  └─ agentstudio-gateway              → "stu901..."                      │
│                                                                          │
│  🔐 Access Control:                                                      │
│     ✅ Keycloak UAMI (6e1cc2fb...) → "Key Vault Secrets User"           │
│     ❌ Service UAMIs               → NO ACCESS (least privilege)        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ (1) materialise-secrets.sh
                                    │     • Runs manually via mk/identity.mk
                                    │     • Uses Keycloak UAMI credentials
                                    │     • Reads from Key Vault
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              KUBERNETES: agentstudio-identity namespace                  │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Individual -from-kv Secrets (created by script)                │   │
│  │  • keycloak-addl-agentstudio-analytics-engine-from-kv          │   │
│  │  • keycloak-addl-agentstudio-config-service-from-kv    ◄───────┼───┼─ ✅ Used by
│  │  • keycloak-addl-agentstudio-workflow-engine-from-kv           │   │    realm-bootstrap-job
│  │  • keycloak-addl-agentstudio-agent-service-from-kv             │   │    (additionalClients)
│  │  • keycloak-addl-agentstudio-storage-manager-from-kv           │   │
│  │  • keycloak-addl-agentstudio-connector-worker-from-kv          │   │
│  │  • keycloak-addl-agentstudio-lakekeeper-from-kv                │   │
│  │  • keycloak-addl-agentstudio-gateway-from-kv                   │   │
│  │                                                                 │   │
│  │  Metadata: managed-by=materialise-secrets.sh                   │   │
│  │            source=azure-key-vault                               │   │
│  │            materialised-at=<timestamp>                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                     │
│                                    │ (2) keycloak-oidc-secrets.yaml     │
│                                    │     template SHOULD lookup         │
│                                    │     these -from-kv secrets         │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  keycloak-oidc-secrets (CONSOLIDATED SECRET)                    │   │
│  │                                                                  │   │
│  │  🐛 BUG: Template resolution order is WRONG:                    │   │
│  │     1. Existing K8s secret (via lookup)                         │   │
│  │     2. ❌ SKIPS -from-kv lookup ❌                               │   │
│  │     3. values-aks.yaml placeholders → "changeme-*"              │   │
│  │                                                                  │   │
│  │  Current template (BROKEN):                                     │   │
│  │  ────────────────────────────────────────────────────────────   │   │
│  │  config-service-client-secret: {{ index $existing "..." |       │   │
│  │    default .Values.keycloak.oidcClients.configService... }}     │   │
│  │                                                                  │   │
│  │  Should be (FIXED):                                             │   │
│  │  ────────────────────────────────────────────────────────────   │   │
│  │  config-service-client-secret: {{ index $existing "..." |       │   │
│  │    default (lookup -from-kv secret) |                           │   │
│  │    default .Values.keycloak.oidcClients.configService... }}     │   │
│  │                                                                  │   │
│  │  Data (when working):                                           │   │
│  │  • analytics-engine-client-id: "analytics-engine"               │   │
│  │  • analytics-engine-client-secret: "abc123..." (from KV)        │   │
│  │  • config-service-client-id: "config-service"                   │   │
│  │  • config-service-client-secret: "ZN4U9OxOxjl2..." (from KV)    │   │
│  │  • [... 6 more service pairs ...]                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                     │
│                                    │ (3) sync-shared-secrets             │
│                                    │     (mk/tier-helm.mk)              │
│                                    │     Copies to service namespaces   │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
        ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
        │   SERVICES    │  │   WORKERS     │  │   PLATFORM    │
        │   namespace   │  │   namespace   │  │   namespace   │
        │               │  │               │  │               │
        │ keycloak-oidc │  │ keycloak-oidc │  │ keycloak-oidc │
        │    -secrets   │  │    -secrets   │  │    -secrets   │
        │  (synced copy)│  │  (synced copy)│  │  (synced copy)│
        └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
                │                  │                  │
                │ (4) Mount        │                  │
                │     as volume    │                  │
                ▼                  ▼                  ▼
        ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
        │ config-service│  │ storage-mgr   │  │ platform pods │
        │ workflow-eng  │  │ connector-wkr │  │               │
        │ agent-service │  │               │  │               │
        │ artifact-svc  │  │               │  │               │
        └───────────────┘  └───────────────┘  └───────────────┘
                │
                │ (5) Init container: wait-for-keycloak-setup
                │     • Check if secret != "changeme-*"
                │     • Wait up to 10 minutes (120 attempts × 5s)
                │     • 🐛 BUG: Expects someone to update secret!
                │
                ▼
        ┌───────────────────────────────────────────┐
        │  Bootstrap Jobs                            │
        │  • analytics-mcp-server-bootstrap          │
        │  • Reads OIDC credentials                  │
        │  • Gets token from Keycloak               │
        │  • Registers with config-service          │
        │                                            │
        │  🚨 FAILS if placeholder values remain    │
        └────────────────────────────────────────────┘
```

---

## How the Bug Manifested

### Timeline:
```
Day 1 (weeks ago):
  • Cluster provisioned via provision-aks.sh
  • Key Vault created with 8 real secrets
  • keycloak-oidc-secrets manually created/seeded
  • Status: ✅ Working

Day 2-30:
  • Deployments work fine
  • Services read from pre-existing keycloak-oidc-secrets
  • Status: ✅ Working

PR #169 (today):
  • Added oidcClients to values-aks.yaml
  • Template triggered to CREATE secret (didn't exist in fresh namespace)
  • Template resolution: existing (none) → values-aks → "changeme-*" ❌
  • Forgot to add: -from-kv lookup in template
  • Status: 🔥 BROKEN - Bootstrap stuck waiting for real values
```

### Why Old Clusters Didn't Break:
```
Old cluster: keycloak-oidc-secrets existed with real values
             ↓
         Template lookup() found existing secret
             ↓
         Preserved real values ✅

New cluster: keycloak-oidc-secrets didn't exist
             ↓
         Template lookup() returned empty
             ↓
         Fell through to values-aks.yaml placeholders
             ↓
         Created secret with "changeme-*" ❌
             ↓
         Bootstrap jobs stuck waiting ❌
```

---

## Manual Fix Applied (Temporary)

```bash
# Read real secret from Key Vault
REAL_SECRET=$(az keyvault secret show \
  --vault-name agentstudio-keycloak-addl-dev-eastus2 \
  --name agentstudio-config-service \
  --query value -o tsv)

# Patch consolidated secret in identity namespace
kubectl patch secret keycloak-oidc-secrets \
  -n agentstudio-identity \
  -p "{\"data\":{\"config-service-client-secret\":\"$(echo -n "$REAL_SECRET" | base64)\"}}"

# Patch consolidated secret in services namespace
kubectl patch secret keycloak-oidc-secrets \
  -n agentstudio-services \
  -p "{\"data\":{\"config-service-client-secret\":\"$(echo -n "$REAL_SECRET" | base64)\"}}"

# Result: Bootstrap job succeeded ✅
```

---

## Permanent Fix Needed

### Template Update (keycloak-oidc-secrets.yaml):

```yaml
{{- /* Step 1: Lookup existing secret (preserves manual patches) */ -}}
{{- $existing := dict }}
{{- $existingSecret := (lookup "v1" "Secret" .Release.Namespace "keycloak-oidc-secrets") }}
{{- if and $existingSecret $existingSecret.data }}
{{-   range $key, $value := $existingSecret.data }}
{{-     $decoded := $value | b64dec }}
{{-     if not (hasPrefix "changeme-" $decoded) }}
{{-       $_ := set $existing $key $decoded }}
{{-     end }}
{{-   end }}
{{- end }}

{{- /* Step 2: Lookup -from-kv secrets (Phase 1 bridge) */ -}}
{{- $kvSecrets := dict }}
{{- $kvConfigService := (lookup "v1" "Secret" .Release.Namespace "keycloak-addl-agentstudio-config-service-from-kv") }}
{{- if and $kvConfigService $kvConfigService.data $kvConfigService.data.clientSecret }}
{{-   $_ := set $kvSecrets "config-service-client-secret" ($kvConfigService.data.clientSecret | b64dec) }}
{{- end }}
{{- /* Repeat for all 8 services... */ }}

{{- /* Step 3: Resolution order: existing → -from-kv → values.yaml */ -}}
data:
  config-service-client-secret: {{ 
    index $existing "config-service-client-secret" | 
    default (index $kvSecrets "config-service-client-secret") | 
    default (.Values.keycloak.oidcClients.configService.clientSecret) | 
    quote 
  }}
```

---

## Multi-Cloud Support

### AKS (Current):
```
Azure Key Vault
    ↓ materialise-secrets.sh
-from-kv K8s secrets
    ↓ template lookup (TO BE ADDED)
keycloak-oidc-secrets
```

### GKE (Existing):
```
values-gke.yaml (real secrets embedded)
    ↓ template default
keycloak-oidc-secrets
```

### EKS (Assumed):
```
values-eks.yaml (real secrets embedded)
    ↓ template default
keycloak-oidc-secrets
```

**Template handles all patterns:**
- If -from-kv exists → use it (AKS Phase 1)
- If values.yaml has real secrets → use them (GKE/EKS)
- Else → placeholder (dev/local)

---

## Future: Phase 2 (CSI Driver - Not Enabled Yet)

```
┌─────────────────┐
│  Azure Key      │
│  Vault          │
└────────┬────────┘
         │
         │ CSI Driver (secrets-store.csi.k8s.io)
         │ • Enabled: false (current)
         │ • SecretProviderClass: 0 resources
         │
         ▼
┌─────────────────────────────────────────┐
│  When enabled (secretProviderClass:     │
│    enabled: true):                      │
│                                         │
│  • CSI driver mounts KV secrets        │
│    directly into pods                  │
│  • No materialise-secrets.sh needed    │
│  • Secrets auto-sync from KV          │
│  • Still creates K8s secrets via      │
│    secretObjects mapping               │
└─────────────────────────────────────────┘
```

**Status:** Infrastructure ready, not enabled
- Driver installed (44h ago)
- Keycloak pods have azure-identity-token volume
- Waiting for Phase 2 activation

---

## Security Model

```
┌──────────────────────────────────────────────────────────────┐
│  Principle: LEAST PRIVILEGE                                   │
│                                                               │
│  ✅ Keycloak UAMI (6e1cc2fb-41c3-4f83-8217-f0bda46c3c42)    │
│     • Role: "Key Vault Secrets User"                         │
│     • Access: Read all secrets in KV                         │
│     • Reason: Provisions OIDC clients, needs all credentials │
│                                                               │
│  ❌ Service UAMIs (config-service, workflow-engine, etc.)    │
│     • Role: NONE on Key Vault                                │
│     • Access: Read K8s secrets only                          │
│     • Reason: If compromised, cannot access KV directly      │
│                                                               │
│  Design Decision:                                            │
│  • Central secret distribution via Kubernetes                │
│  • Only Keycloak as KV access point                         │
│  • Services isolated from KV                                 │
└──────────────────────────────────────────────────────────────┘
```

---

## Summary: Where Each Service Gets Secrets

| Tier       | Secret Source                  | Auth Method              |
|------------|--------------------------------|--------------------------|
| Identity   | -from-kv → keycloak-oidc-sec  | Keycloak UAMI → KV       |
| Services   | keycloak-oidc-secrets (synced)| Service UAMI → K8s only  |
| Workers    | keycloak-oidc-secrets (synced)| Worker UAMI → K8s only   |
| Platform   | keycloak-oidc-secrets (synced)| Platform UAMI → K8s only |
| LLM        | (no OIDC deps)                | N/A                      |
| Console    | (no OIDC deps)                | N/A                      |

**Key Point:** Only identity/Keycloak touches Key Vault. All others read from Kubernetes.

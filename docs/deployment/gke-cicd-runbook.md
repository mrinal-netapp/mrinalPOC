# GKE CI/CD Runbook (ACR -> GAR/ECR mirror -> GKE)

This runbook captures the validated path for building images to ACR, mirroring to GAR/ECR, and deploying to the `dev-gke` environment.

## Prerequisites

- GitHub Environment `dev` configured with build/publish variables:
  - `ACR_REGISTRY`
  - `GAR_REGISTRY`
  - `ECR_REGISTRY`
  - `AZURE_CLIENT_ID`
  - `AZURE_TENANT_ID`
  - `AZURE_SUBSCRIPTION_ID`
  - `GCP_PROJECT_ID`
  - `GCP_WORKLOAD_IDENTITY_PROVIDER`
  - `GCP_SERVICE_ACCOUNT`
  - `AWS_REGION`
  - `AWS_ROLE_ARN`
- GitHub Environment `dev-gke` configured with deploy variables:
  - `GAR_REGISTRY`
  - `GCP_PROJECT_ID`
  - `GKE_CLUSTER_NAME`
  - `GKE_CLUSTER_LOCATION`
  - `GCP_WORKLOAD_IDENTITY_PROVIDER`
  - `GCP_SERVICE_ACCOUNT`
  - `AGENTSTUDIO_ENDPOINT`
  - Keycloak Entra broker (see "Keycloak Entra Identity Broker" below):
    - `KEYCLOAK_ENTRA_APP_CLIENT_ID` (appId of the dedicated `agent-studio-dev-gke-broker` app)
    - `AZURE_TENANT_ID` (Entra tenant; also used as the broker `tenantId`)
    - `KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID`
    - `KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID`
  - Externally-managed K8s Secret `keycloak-entra-broker` (key `clientSecret`) in the identity namespace, created once via `make gke-keycloak-broker-secret` (see below). CD does **not** take a `KEYCLOAK_ENTRA_CLIENT_SECRET` GitHub secret — it only verifies this Secret is present.
- Optional: GitHub Environment `dev-eks` for EKS deploy path:
  - `ECR_REGISTRY`
  - `AWS_REGION`
  - `EKS_CLUSTER_NAME`
  - `AWS_ROLE_ARN`
  - `AGENTSTUDIO_ENDPOINT`
- GKE node service account has `roles/artifactregistry.reader` on GAR repo `agentstudio`.
- Docker base images used by this repo are available in `docker.repo.eng.netapp.com`.

## Keycloak Entra Identity Broker

GKE Keycloak brokers user login through Microsoft Entra ID, using its **own dedicated app registration** `agent-studio-dev-gke-broker` (separate from the AKS app). The identity chart's broker support is enabled in `deployments/helm/identity/values-gke.yaml` (`realmBootstrap.broker.enabled: true`); the four public identifiers are threaded in at install time.

GKE has no Key Vault, so the client secret is delivered through an **externally-managed** K8s Secret named `keycloak-entra-broker` (key `clientSecret`) in the identity namespace, which the chart references via `realmBootstrap.broker.existingSecret`. This Secret is the GKE analog of the AKS KV-materialised `keycloak-entra-broker-from-kv`:

- An operator creates it **once** with `make gke-keycloak-broker-secret` (idempotent; re-run to rotate).
- `deploy-all-tiers-gke` does **not** create or overwrite it — it only verifies it is present via `make gke-keycloak-broker-secret-require` and fails fast with instructions if missing. So CD needs no `KEYCLOAK_ENTRA_CLIENT_SECRET` GitHub secret.

Because `existingSecret` is set, the chart does **not** render an inline secret.

### One-time Entra setup (platform/Entra team)

The dedicated app must have:
- Reply (redirect) URI: `https://auth.<AGENTSTUDIO_ENDPOINT>/realms/nemo/broker/azure-entra/endpoint` (note: the Keycloak IdP alias is `azure-entra`, so the path uses it even for the GKE app).
- The `groups` claim emitted in the id_token (`groupMembershipClaims=SecurityGroup` + `optionalClaims.idToken=groups`).
- Membership of the tenant security groups `AgentStudio-PlatformAdmins` / `AgentStudio-PlatformMembers` (same groups AKS uses; objectIds are tenant-wide).

Collect the inputs:

```bash
# clientId (appId)
az ad app list --display-name agent-studio-dev-gke-broker --query "[0].appId" -o tsv
# tenantId
az account show --query tenantId -o tsv
# group objectIds
az ad group show --group AgentStudio-PlatformAdmins  --query id -o tsv
az ad group show --group AgentStudio-PlatformMembers --query id -o tsv
# clientSecret: from the app's "Certificates & secrets" (only shown once at creation)
```

These are tenant/directory values — no Azure subscription is involved.

### Manual install

First create the broker client-secret K8s Secret (the chart's `existingSecret` target), then install:

```bash
# 1. Create/update the keycloak-entra-broker Secret in the identity namespace.
#    Pass the secret as an ENV VAR prefix (NOT a make var) so a value
#    containing `$` is not mangled by GNU Make expansion.
KEYCLOAK_ENTRA_CLIENT_SECRET='<clientSecret>' make gke-keycloak-broker-secret \
  KEYCLOAK_NAMESPACE=agentstudio-identity

# 2. Install the identity chart (reads the Secret via broker.existingSecret).
make helm-identity-install-gke \
  KEYCLOAK_HOSTNAME=https://auth.<AGENTSTUDIO_ENDPOINT> \
  KEYCLOAK_ENTRA_APP_CLIENT_ID=<appId> \
  KEYCLOAK_TENANT_ID=<tenantId> \
  KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID=<adminsObjectId> \
  KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID=<membersObjectId>
```

Equivalently, create the Secret directly with `kubectl` (the key MUST be `clientSecret`):

```bash
kubectl create secret generic keycloak-entra-broker \
  --namespace agentstudio-identity \
  --from-literal=clientSecret='<clientSecret>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

The four public IDs flow automatically through the CD path (`make deploy CLOUD=gke` -> `deploy-all-tiers-gke`) from the `dev-gke` GitHub variables above. The client secret is **not** a CD input: `deploy-all-tiers-gke` runs `make gke-keycloak-broker-secret-require` to confirm the pre-created `keycloak-entra-broker` Secret is present (failing fast if not) and the chart reads it via `broker.existingSecret`. Create/rotate that Secret out of band with `make gke-keycloak-broker-secret`.

### Admin elevation

Group membership drives roles automatically: members of `AgentStudio-PlatformAdmins` get `platform-admin`, everyone else gets `platform-member`. Add platform engineers to the admins group in Entra; no per-user Keycloak action is needed.

## Validation Sequence

1. **WIF smoke test**
   - Run workflow: `WIF smoke test (GKE)`
   - Confirms OIDC/WIF auth, GAR access, and cluster connectivity.

2. **Build + mirror only (no deploy)**
   - Run workflow: `Build and Publish Images & Release`
   - Inputs:
     - `deploy_to_aks=false`
     - `deploy_to_gke=false`
     - `deploy_to_eks=false`
   - Confirms images are built to ACR and mirrored to GAR/ECR.

3. **Deploy-only to GKE**
   - Run workflow: `Deploy to GKE Dev`
   - Input: `image_tag=<tag from step 2>`
   - Confirms tiered Helm deployment succeeds on self-hosted runner.

4. **End-to-end path (workflow chaining)**
   - Run workflow: `Build and Publish Images & Release`
   - Inputs:
     - `deploy_to_aks=true` (optional; set false to skip AKS deploy)
     - `deploy_to_gke=true`
     - `deploy_to_eks=true` (optional; set false to skip EKS deploy)
   - Confirms `build-common.yml` -> `deploy-gke.yml` reusable-workflow path.

## Post-deploy Smoke Checks

- Verify cluster:
  - `kubectl get nodes`
  - `kubectl get pods -A`
- Verify endpoint(s):
  - `https://app.<AGENTSTUDIO_ENDPOINT>/console`
  - `https://auth.<AGENTSTUDIO_ENDPOINT>:8443`

## Troubleshooting Notes

- **`gke-gcloud-auth-plugin not found`**
  - Ensure plugin install step succeeds and `USE_GKE_GCLOUD_AUTH_PLUGIN=true` is set.
- **Docker Hub 429 rate limits**
  - Use internal mirrored base images under `docker.repo.eng.netapp.com`.
- **Helm dependency errors in smoke test**
  - `helm-tier-template-gke` should run `helm dependency update` per tier.
- **`unknown flag: --force-conflicts` from Helm**
  - This flag is for `kubectl apply`, not `helm upgrade`.

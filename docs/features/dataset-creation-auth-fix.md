# Dataset Creation and Authentication Fix

## Issues Identified

### Issue 1: Warehouse Creation During Dataset Creation ✅ FIXED

**Problem:**
- When creating a dataset, the config-service was attempting to create a warehouse in Lakekeeper
- This was failing because the warehouse already exists (created during project initialization)
- Error: `Failed to create warehouse: Request failed with status code 400`

**Root Cause:**
The `DataSetCatalogOrchestrator.ensureWarehouse()` method was calling `catalogService.ensureWarehouse()`, which tries to create a warehouse if it doesn't exist. However, warehouses should only be created during project initialization, not during dataset creation.

**Solution Applied:**
Modified `src/nemo/config-service/services/DataSetCatalogOrchestrator.ts`:
- Changed `ensureWarehouse()` to only **verify** warehouse existence, not create it
- Added clear error messages if warehouse doesn't exist
- The method now:
  1. Gets warehouse ID from project metadata
  2. Verifies warehouse exists in Lakekeeper (throws error if not found)
  3. Returns warehouse ID and S3 endpoint for table creation

### Issue 2: Service Account Authentication Failure ⚠️ NEEDS ACTION

**Problem:**
- Config-service cannot authenticate with Keycloak when trying to access Lakekeeper
- Error: `HTTP 401: {"error":"unauthorized_client","error_description":"Invalid client or Invalid client credentials"}`

**Root Cause:**
The `keycloak-setup.py` script was creating Keycloak clients and retrieving their secrets, but was only **printing** them to the console instead of updating the Kubernetes secret (`keycloak-oidc-secrets`).

Services were using placeholder secrets like `"changeme-config-service-secret"` which are invalid.

**How Keycloak setup works today:**

Keycloak realm and client configuration is handled automatically by the **identity chart's `realm-bootstrap-job`** — a Helm `post-install` + `post-upgrade` hook defined in `deployments/helm/identity/templates/realm-bootstrap-job.yaml`. On every `helm upgrade --install` of the identity tier it:

1. Waits for the Keycloak StatefulSet to pass `/health/ready`
2. Authenticates as the bootstrap admin via `kcadm.sh config credentials`
3. Creates or updates the `agent-studio` realm from `deployments/helm/identity/realms/agent-studio-realm.json` (idempotent create-or-update, avoids `partialImport` bugs)
4. Patches the `keycloak-oidc-secrets` Kubernetes Secret (initially created with placeholder values by `keycloak-oidc-secrets.yaml`) with the real Keycloak-generated client secrets for all service accounts

The `scripts/keycloak-setup.py` script is a standalone **manual fallback** for environments where the Helm hook cannot run (e.g. re-running setup without a full Helm upgrade).

**Solution Applied:**
Updated both versions of `keycloak-setup.py`:
- `scripts/keycloak-setup.py` (for manual setup)
- The Helm-embedded copy in the platform chart's job image

The script now:
1. Creates all Keycloak clients
2. Retrieves their client secrets
3. **Automatically updates the Kubernetes secret** with real values
4. Provides instructions for restarting services

## How to Fix Your Current Environment

### Option 1: Re-run Keycloak Setup (Recommended)

The Keycloak setup job should run automatically during Helm install/upgrade. To manually trigger it:

```bash
# Check if the setup job completed successfully
kubectl get job -n agentstudio-platform | grep keycloak-setup

# If failed or not found, delete the old job (if exists) and re-run platform upgrade
kubectl delete job -n agentstudio-platform -l job-name=platform-keycloak-setup --ignore-not-found=true

# Re-run the platform tier upgrade (will re-create hook jobs)
make helm-platform-upgrade-aks
```

### Option 2: Use the Update Script

Run the provided script to update just the config-service secret:

```bash
./scripts/update-config-service-keycloak-secret.sh
```

This script:
- Connects to Keycloak
- Retrieves the correct client secret for `agentstudio-config-service`
- Updates the Kubernetes secret
- Prompts you to restart the service

### Option 3: Manual Secret Update

If you know the correct client secret:

```bash
# Get the client secret from Keycloak UI or admin API
# Then update the secret:
kubectl patch secret keycloak-oidc-secrets -n agentstudio-services \
  --type merge \
  -p '{"stringData":{"config-service-client-secret":"YOUR_ACTUAL_SECRET_HERE"}}'
```

### Step 3: Restart Affected Services

After updating the secrets, restart the services to pick up the new credentials:

```bash
kubectl rollout restart deployment/config-service -n agentstudio-services
kubectl rollout restart deployment/workflow-engine -n agentstudio-services
kubectl rollout restart deployment/analytics-engine -n agentstudio-services
```

### Step 4: Verify the Fix

```bash
# Check config-service logs
kubectl logs -n agentstudio-services deployment/config-service --tail=50

# You should see successful authentication instead of 401 errors
# Look for: "[ServiceAccountClient] Successfully obtained access token"
```

## Verification Checklist

After applying the fixes:

- [ ] Keycloak clients exist: `agentstudio-config-service`, `agentstudio-workflow-engine`, etc.
- [ ] Kubernetes secret `keycloak-oidc-secrets` contains valid secrets (not "changeme-...")
- [ ] Config-service can authenticate with Keycloak (check logs)
- [ ] Dataset creation verifies warehouse exists (no creation attempts)
- [ ] Dataset creation can successfully create tables in Lakekeeper

## Testing Dataset Creation

Once authentication is working:

```bash
# Create a dataset via the API
curl -X POST http://agentstudio.local/api/v1/projects/YOUR_PROJECT_ID/datasets \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-dataset",
    "description": "Test dataset"
  }'

# Check logs for success:
# - Should verify warehouse exists (not create)
# - Should create namespace if needed
# - Should create Iceberg table
```

## Files Modified

1. **src/nemo/config-service/services/DataSetCatalogOrchestrator.ts**
   - Changed `ensureWarehouse()` to verify-only mode

2. **scripts/keycloak-setup.py**
   - Added `update_k8s_secret()` function
   - Modified `main()` to collect and update all secrets

3. **Platform chart Helm-embedded `keycloak-setup.py`**
   - Already had the update functionality (confirmed working)

## Related Documentation

- Project initialization workflow: `src/nemo/workflow-engine/internal/workflows/project_init.go`
- Warehouse creation happens here: `src/nemo/workflow-engine/internal/activities/project_init.go`
- Keycloak OIDC setup guide: `docs/auth/keycloak-oidc-setup-guide.md`

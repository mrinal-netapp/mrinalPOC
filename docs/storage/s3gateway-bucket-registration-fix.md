# S3Gateway Bucket Registration Fix

## Issue

The `project-init` workflow was failing in the `WaitForBucketReadyActivity` with 403 Forbidden errors when trying to verify that buckets exist in S3.

**Symptoms:**
- Workflow-engine logs showed repeated 403 errors on HeadBucket requests
- S3gateway logs showed: `403 | HEAD | /p-<project-id>`
- Buckets were created as PVCs and directories existed in `/mnt/pvcs/` 
- But buckets were NOT registered in versitygw's metadata store (`/mnt/metadata/`)

## Root Cause

**VersityGW requires buckets to be explicitly registered via the S3 `CreateBucket` API before they can be accessed.**

The storage-manager creates PVCs which create directories under `/mnt/pvcs/`, but versitygw maintains its own metadata store in `/mnt/metadata/`. Without calling the S3 `CreateBucket` API, versitygw doesn't know the bucket exists and rejects all requests with 403 Forbidden.

## The Fix

Modified `WaitForBucketReadyActivity` in `workflow-engine/internal/activities/project_init.go`:

1. **Connect directly to s3gateway** instead of going through API gateway
   - Changed endpoint from `http://gateway:8080` to `http://s3gateway:7070`
   - Removed the `hostHeaderTransport` complexity for Host header manipulation
   - This avoids any auth middleware issues in the API gateway

2. **Added S3 CreateBucket call** before polling for bucket readiness
   - Explicitly calls `s3Client.CreateBucket()` to register the bucket with versitygw
   - Handles "bucket already exists" errors as idempotent (which is correct behavior)
   - This creates the necessary metadata in `/mnt/metadata/<bucket-name>/`

3. **Added proper error handling**
   - Import `errors` package and `s3Types` for AWS SDK error types
   - Check for `BucketAlreadyExists` and `BucketAlreadyOwnedByYou` errors
   - Treat these as success cases (idempotent operation)

## Code Changes

### Fix 1: Activity Code (project_init.go - activities)
```go
// Step 1: Create bucket via S3 API to register it with versitygw
log.Printf("[WaitForBucketReadyActivity] Step 1: Creating bucket %s via S3 API (registering with versitygw)", bucketName)
_, err = s3Client.CreateBucket(ctx, &s3.CreateBucketInput{
    Bucket: aws.String(bucketName),
})
if err != nil {
    // Check if bucket already exists (this is okay)
    var bne *s3Types.BucketAlreadyExists
    var bnaoe *s3Types.BucketAlreadyOwnedByYou
    if errors.As(err, &bne) || errors.As(err, &bnaoe) {
        log.Printf("[WaitForBucketReadyActivity] Bucket %s already exists in S3, continuing...", bucketName)
    } else {
        log.Printf("[WaitForBucketReadyActivity] ERROR: Failed to create bucket in S3: %v", err)
        return fmt.Errorf("failed to create bucket in S3: %w", err)
    }
} else {
    log.Printf("[WaitForBucketReadyActivity] Bucket %s created successfully in S3", bucketName)
}

// Step 2: Poll until bucket is accessible
// ...existing polling logic...
```

### Fix 2: Workflow Definition (project_init.go - workflows)
```go
s3GatewayEndpoint := input.S3GatewayEndpoint
if s3GatewayEndpoint == "" {
    s3GatewayEndpoint = os.Getenv("S3GATEWAY_ENDPOINT")
    if s3GatewayEndpoint == "" {
        // Connect directly to s3gateway to avoid auth middleware issues
        s3GatewayEndpoint = "http://s3gateway:7070"
    }
}
```

### Fix 3: Config Service (ProjectInitService.ts) **[PRIMARY ROOT CAUSE]**
```typescript
// Get configuration from environment with defaults
const region = process.env.REGION || 'us-east-1';
const storageClass = process.env.DEFAULT_STORAGE_CLASS || 'standard';
const storageSize = process.env.DEFAULT_STORAGE_SIZE || '10Gi';
// Connect directly to s3gateway to avoid auth middleware issues
// Lakekeeper will use AWS signature v4 auth with the provided credentials
const s3GatewayEndpoint = process.env.S3GATEWAY_ENDPOINT || 'http://s3gateway:7070';
```

**This was the ACTUAL root cause** - the config-service was setting the default to `http://apigateway-service:8080` before calling workflow-engine.

### Fix 4: Route Handler (project_init.go - routes)
```go
req.S3GatewayEndpoint = os.Getenv("S3GATEWAY_ENDPOINT")
if req.S3GatewayEndpoint == "" {
    // Connect directly to s3gateway to avoid auth middleware issues
    req.S3GatewayEndpoint = "http://s3gateway:7070"
}
```

### Fix 5: Add Project ID to Warehouse Request **[NEW ERROR FIX]**

After fixing the S3 endpoint, encountered: `Project with id '00000000-0000-0000-0000-000000000000' not found`

**Type Definition (execution.go):**
```go
type RegisterWarehouseRequest struct {
    ProjectId      string                 `json:"project-id"`  // ADDED
    WarehouseName  string                 `json:"warehouse-name"`
    StorageProfile map[string]interface{} `json:"storage-profile"`
    StorageCredential map[string]interface{} `json:"storage-credential,omitempty"`
}
```

**Workflow Update (project_init.go):**
```go
warehouseRequest := types.RegisterWarehouseRequest{
    ProjectId:     input.ProjectId,  // ADDED
    WarehouseName: result.WarehouseName,
    StorageProfile: map[string]interface{}{
        // ... storage config
    },
}
```

## Additional Fix: Lakekeeper Warehouse Registration

### Issue
After fixing the bucket registration, the `RegisterWarehouseActivity` was still failing with:
```
IO error at `s3://p-juu6qdbu/.../metadata/test`: Unknown S3 error during write: unhandled error
error parsing XML: no root element
```

### Root Cause
Lakekeeper validates S3 storage by writing a test file during warehouse registration. The original configuration used `http://apigateway-service:8080` as the S3 endpoint, but:
1. Lakekeeper's S3 write requests were not appearing in apigateway logs
2. The AWS SDK was getting non-XML responses (likely HTML/JSON error pages)
3. This suggested the apigateway's auth middleware was blocking the requests

### The Fix
Changed the default S3 gateway endpoint in `project_init.go` from `http://apigateway-service:8080` to `http://s3gateway:7070`:

```go
s3GatewayEndpoint := input.S3GatewayEndpoint
if s3GatewayEndpoint == "" {
    s3GatewayEndpoint = os.Getenv("S3GATEWAY_ENDPOINT")
    if s3GatewayEndpoint == "" {
        // Connect directly to s3gateway to avoid auth middleware issues
        // Lakekeeper will use AWS signature v4 auth with the provided credentials
        s3GatewayEndpoint = "http://s3gateway:7070"
    }
}
```

This allows Lakekeeper to connect directly to s3gateway using AWS Signature v4 authentication, bypassing any potential auth middleware issues in the API gateway.

## Deployment

### Initial Attempt (Had Missing Import)
1. Built workflow-engine image: `docker.repo.eng.netapp.com/user/$(USER)/nemo/workflow-engine:8e66049`
2. Compilation error: `undefined: s3Types` 
3. **Fix:** Added missing import: `s3Types "github.com/aws/aws-sdk-go-v2/service/s3/types"`

### Second Attempt (Fixed Import, But Still Wrong Endpoint)
1. Rebuilt workflow-engine image with fixed import: `docker.repo.eng.netapp.com/user/$(USER)/nemo/workflow-engine:8e66049`
2. Pushed to container registry
3. Restarted deployment
4. **Issue:** Warehouse registration still used `http://apigateway-service:8080`
5. **Root Cause Found:** Route handler in `internal/server/routes/project_init.go` line 50 was hardcoding the wrong endpoint

### Third Deployment (Config Service Fix)
1. Fixed **config-service** default endpoint: `http://s3gateway:7070` (PRIMARY SOURCE)
2. Rebuilt config-service image: `docker.repo.eng.netapp.com/user/$(USER)/nemo/config-service:fix-s3gateway-1769151286` (no cache)
3. Pushed to container registry
4. Updated deployment: `kubectl set image deployment/config-service ...`
5. **Result:** S3 endpoint now correct, but new error: `Project with id '00000000-0000-0000-0000-000000000000' not found`

### Final Deployment (Project ID Fix)
1. Added `project-id` field to `RegisterWarehouseRequest` type
2. Updated workflow to pass `input.ProjectId` when creating warehouse request
3. Rebuilt workflow-engine image: `docker.repo.eng.netapp.com/user/$(USER)/nemo/workflow-engine:fix-projectid-1769151614` (no cache)
4. Pushed to container registry
5. Updated deployment: `kubectl set image deployment/workflow-engine ...`

**Important Notes:**
- The **config-service** was the actual root cause for the S3 endpoint issue - it sets the endpoint before calling workflow-engine
- Lakekeeper requires a valid `project-id` field in the warehouse creation request
- Using `--no-cache` with podman build ensures changes are included
- When using the same image tag, Kubernetes may not pull the new image if `imagePullPolicy` is not `Always`

## Testing

To test the fix:
1. Create a new project via the AgentStudio GUI or API
2. Monitor workflow-engine logs for successful bucket creation:
   ```bash
   kubectl logs -n agentstudio-services -l app.kubernetes.io/name=workflow-engine --tail=50 -f | grep WaitForBucket
   ```
3. Verify bucket metadata exists in s3gateway:
   ```bash
   kubectl exec -n agentstudio-services <s3gateway-pod> -- ls -la /mnt/metadata/
   ```

## Related Files

- `src/nemo/config-service/services/ProjectInitService.ts` - **PRIMARY SOURCE (was setting wrong endpoint before calling workflow-engine)**
- `src/nemo/workflow-engine/internal/activities/project_init.go` - Activity implementation (bucket creation)
- `src/nemo/workflow-engine/internal/workflows/project_init.go` - Workflow definition (warehouse endpoint default + project-id)
- `src/nemo/workflow-engine/internal/server/routes/project_init.go` - Route handler (endpoint default)
- `src/nemo/workflow-engine/pkg/types/execution.go` - RegisterWarehouseRequest type (added project-id field)
- `deployments/helm/workers/charts/s3gateway/` - S3gateway (versitygw) configuration

## References

- VersityGW documentation: Bucket registration via S3 API is required for metadata initialization
- AWS S3 API: CreateBucket operation creates bucket metadata
- Project-init workflow: Multi-step process for project initialization (bucket + warehouse + namespace)

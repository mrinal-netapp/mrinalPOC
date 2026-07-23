# Workspace CRD Design

## Overview

This document proposes a Custom Resource Definition (CRD) based approach for managing workspace lifecycle in Kubernetes. This replaces the current imperative API-based approach with a declarative, operator-style pattern.

### Multi-Deployment Support

The workspace-service is designed to be **deployment-agnostic** and can be deployed in multiple contexts:

- **AgentStudio Deployment**: Manages JupyterLab workspaces for data science workflows
- **Ray Deployment**: Manages SQL Workbench workspaces for SQL analytics

The same workspace-service codebase supports both deployment contexts through:
- **Deployment context configuration**: Identifies which deployment the service is running in
- **Workspace type flexibility**: Supports different workspace types (JupyterLab, SQL Workbench, etc.)
- **Context-aware polling**: Filters workspaces by deployment context
- **Type-specific resource creation**: Controller adapts resource creation based on workspace type

## Current Architecture Issues

### Problems with Current Approach

1. **Error Handling Complexity**: Error detection is scattered and inconsistent
2. **Race Conditions**: Multiple API calls without proper coordination
3. **State Management**: State is split between database and Kubernetes resources
4. **Recovery**: No automatic retry or reconciliation logic
5. **Observability**: Difficult to track workspace lifecycle events
6. **Scalability**: Synchronous API calls block request handling

### Current Flow

```
User Request → config-service → workspace-manager API → Kubernetes API
                                                         ↓
                                                    Create Pod/PVC/Service
                                                         ↓
                                                    Update config-service
```

## Proposed CRD-Based Architecture

### Benefits

1. **Declarative**: Desired state is declared, Kubernetes handles reconciliation
2. **Resilient**: Automatic retry and reconciliation on failures
3. **Observable**: Status and events tracked in Kubernetes
4. **Scalable**: Async processing, no blocking API calls
5. **Simpler**: Less error handling code, Kubernetes handles edge cases
6. **Standard**: Uses Kubernetes-native patterns

### New Flow (Polling-Based)

```
User Request → config-service → Store Workspace in DB (status: 'new')
                                    ↓
                            (No direct call to workspace-service)
                                    ↓
                            workspace-service polls config-service
                            GET /api/v1/workspaces?status=new,creating
                                    ↓
                            workspace-service creates Workspace CRD
                                    ↓
                            Workspace Controller (Operator in workspace-service)
                                    ↓
                            Reconcile: Create/Update Pod/PVC/Service
                                    ↓
                            Update CRD Status
                                    ↓
                            workspace-service watches CRD status
                                    ↓
                            Update config-service via callback
                            PUT /api/v1/workspaces/:workspaceId/status
                                    ↓
                            config-service updates database only
```

## CRD Definition

### Workspace CRD

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: workspaces.agentstudio.io
spec:
  group: agentstudio.io
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - workspaceId
                - namespaceId
                - template
              properties:
                workspaceId:
                  type: string
                  pattern: '^[0-9a-z]{8,12}$'
                namespaceId:
                  type: string
                template:
                  type: object
                  properties:
                    type:
                      type: string
                      # Flexible enum: supports jupyterlab, vscode, custom, sql-workbench, etc.
                      # Controller handles different types appropriately
                      enum: [jupyterlab, vscode, custom, sql-workbench]
                deploymentContext:
                  type: object
                  description: "Identifies which deployment context this workspace belongs to"
                  properties:
                    deploymentId:
                      type: string
                      description: "Ray deployment ID (e.g., 'us-west-2') or 'nemo' for AgentStudio deployment"
                    deploymentType:
                      type: string
                      enum: [nemo, ray]
                      description: "Type of deployment: 'nemo' for AgentStudio deployment, 'ray' for Ray deployment"
                    environment:
                      type: object
                      properties:
                        baseImage:
                          type: string
                        libraries:
                          type: array
                          items:
                            type: string
                        environmentVariables:
                          type: object
                    resources:
                      type: object
                      properties:
                        cpu:
                          type: string
                        memory:
                          type: string
                        storage:
                          type: string
                s3Config:
                  type: object
                  properties:
                    bucketName:
                      type: string
                    accessKey:
                      type: string
                    secretKey:
                      type: string
                    endpoint:
                      type: string
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Pending, Creating, Running, Stopping, Stopped, Error]
                conditions:
                  type: array
                  items:
                    type: object
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                        enum: [True, False, Unknown]
                      lastTransitionTime:
                        type: string
                        format: date-time
                      reason:
                        type: string
                      message:
                        type: string
                podName:
                  type: string
                pvcName:
                  type: string
                serviceName:
                  type: string
                endpoint:
                  type: string
                errorMessage:
                  type: string
      subresources:
        status: {}
  scope: Namespaced
  names:
    plural: workspaces
    singular: workspace
    kind: Workspace
    shortNames:
      - ws
```

## Service Responsibilities

### config-service (State Management Only - Database-Backed)

- ✅ **CRUD operations** for Workspace/WorkspaceTemplate in database
- ✅ **Business logic validation** (workspace name uniqueness, template validation)
- ✅ **Status tracking** in database (synced from workspace-service)
- ✅ **API endpoints** for UI/frontend
- ✅ **Query endpoint** for workspace-service polling: `GET /api/v1/workspaces?status=...`
- ✅ **Status update endpoint** for workspace-service callbacks: `PUT /api/v1/workspaces/:workspaceId/status`
- ❌ **NO Kubernetes operations** (no K8s client dependencies)
- ❌ **NO CRD creation or monitoring**
- ❌ **NO knowledge of Kubernetes or CRDs**
- ✅ **Database-only dependencies**

### workspace-service (Infrastructure & CRD Management)

- ✅ **Deployment Context Awareness**: Identifies deployment context (AgentStudio or Ray) via environment configuration
- ✅ **Polling Service**: Periodically polls config-service for workspaces to manage (filters by deployment context)
- ✅ **CRD Creation**: Creates Workspace CRD for workspaces that need launching
- ✅ **CRD Monitoring**: Watches Workspace CRD status changes
- ✅ **Controller/Operator**: Reconciles CRD desired state with Kubernetes resources (workspace-type agnostic)
- ✅ **Resource Lifecycle**: Creates/updates/deletes Pod, PVC, Service, Secret (adapts based on workspace type)
- ✅ **Status Sync**: Updates config-service when CRD status changes
- ✅ **Error Handling**: Retries failed operations, updates error status in CRD
- ✅ **Cleanup**: Handles resource deletion when workspace is deleted
- ✅ **Multi-Type Support**: Handles different workspace types (JupyterLab, SQL Workbench, etc.) with type-specific logic

## Workspace Controller (Operator)

### Location

The Workspace Controller runs **inside workspace-service**, not in config-service.

### Responsibilities

1. **Reconciliation Loop**: Watch Workspace CRDs and reconcile desired state
2. **Resource Creation**: Create Pod, PVC, Service, Secret as needed
3. **Status Updates**: Update CRD status based on resource state
4. **Error Handling**: Retry failed operations, update error status
5. **Cleanup**: Handle resource deletion when workspace is deleted
6. **Status Sync**: Call config-service API to sync CRD status to database

### Controller Implementation

```typescript
// Simplified controller structure
class WorkspaceController {
  async reconcile(workspace: WorkspaceCRD): Promise<void> {
    const { spec, status } = workspace;
    
    // Determine current phase
    const currentPhase = status?.phase || 'Pending';
    
    switch (currentPhase) {
      case 'Pending':
        await this.handlePending(workspace);
        break;
      case 'Creating':
        await this.handleCreating(workspace);
        break;
      case 'Running':
        await this.handleRunning(workspace);
        break;
      case 'Stopping':
        await this.handleStopping(workspace);
        break;
      case 'Error':
        await this.handleError(workspace);
        break;
    }
  }
  
  private async handlePending(workspace: WorkspaceCRD): Promise<void> {
    // Create PVC
    const pvc = await this.ensurePVC(workspace);
    
    // Create Secret if S3 config provided
    if (workspace.spec.s3Config) {
      await this.ensureSecret(workspace);
    }
    
    // Create Pod
    const pod = await this.ensurePod(workspace);
    
    // Create Service
    await this.ensureService(workspace);
    
    // Update status to Creating
    await this.updateStatus(workspace, {
      phase: 'Creating',
      pvcName: pvc.metadata.name,
      podName: pod.metadata.name,
    });
  }
  
  private async handleCreating(workspace: WorkspaceCRD): Promise<void> {
    // Check pod status
    const pod = await this.getPod(workspace.status.podName);
    
    if (pod.status.phase === 'Running' && this.isPodReady(pod)) {
      // Update status to Running
      await this.updateStatus(workspace, {
        phase: 'Running',
        endpoint: this.buildEndpoint(workspace),
      });
    } else if (pod.status.phase === 'Failed') {
      // Update status to Error
      await this.updateStatus(workspace, {
        phase: 'Error',
        errorMessage: this.extractPodError(pod),
      });
    }
    // Otherwise, continue waiting (reconcile will be called again)
  }
  
  // ... other handlers
}
```

## Architecture Details

### Service Separation

```
┌─────────────────┐
│  config-service │  (Database + API Only)
│                 │
│  - Workspace DB │
│  - Templates DB │
│  - REST API     │
│  - No K8s deps  │
│  - No CRD deps  │
└────────┬────────┘
         │
         │ Polling (GET workspaces)
         │ Status Updates (PUT status)
         ↓
┌─────────────────┐
│ workspace-service│  (Kubernetes + CRD)
│                 │
│  - Poller       │
│  - CRD Manager  │
│  - Controller   │
│  - Status Watch │
│  - K8s Client   │
└────────┬────────┘
         │
         │ CRD + K8s Resources
         ↓
┌─────────────────┐
│   Kubernetes    │
│                 │
│  - Workspace CRD│
│  - Pod/PVC/Svc  │
└─────────────────┘
```

### Data Flow

1. **User creates workspace**:
   - Frontend → config-service API
   - config-service stores in database (status: 'new')
   - No call to workspace-service (polling-based)

2. **Workspace launch (polling-based)**:
   - workspace-service periodically polls config-service for workspaces with status 'new' or 'creating'
   - workspace-service creates Workspace CRD for each workspace that needs launching
   - Controller detects new CRD, starts reconciliation
   - Controller creates Pod/PVC/Service
   - Controller updates CRD status

3. **Status sync**:
   - workspace-service watches CRD status changes
   - On status change, calls config-service API to update database
   - config-service updates workspace record in DB (status, podName, endpoint, etc.)

4. **User queries workspace**:
   - Frontend → config-service API
   - config-service reads from database (no K8s access needed)

5. **Workspace stop/delete**:
   - User → config-service API (updates status to 'stopping' or marks for deletion)
   - workspace-service polls and detects status change
   - workspace-service updates/deletes CRD
   - Controller reconciles and deletes resources
   - workspace-service syncs final status to config-service

## Implementation Strategy

Since there are no existing workspaces deployed, we can implement the CRD-based approach directly without migration concerns.

### Implementation Phases

1. **Phase 1: CRD and Controller**
   - Install Workspace CRD definition
   - Implement Workspace Controller in workspace-service
   - Implement CRD Manager Service

2. **Phase 2: Polling and Status Sync**
   - Add Workspace Poller Service to workspace-service
   - Add Status Watcher Service to workspace-service
   - Add query and status update endpoints to config-service

3. **Phase 3: Integration and Testing**
   - Test end-to-end flow: create workspace → poll → CRD → reconcile → status sync
   - Verify error handling and retry logic
   - Test workspace stop and delete flows

## Implementation Details

### workspace-service Architecture Changes

#### Current (Imperative API)
```typescript
// config-service calls workspace-service
POST /api/v1/workspaces/:workspaceId/launch
Body: { workspaceId, namespaceId, template, s3Config }
→ Creates Pod/PVC/Service directly
→ Returns immediately
```

#### New (Polling + CRD-based)
```typescript
// workspace-service polls config-service
GET /api/v1/workspaces?status=new,creating
→ Returns list of workspaces needing management

// For each workspace, workspace-service:
1. Creates Workspace CRD (if not exists)
2. Controller reconciles in background
3. Status watcher syncs CRD status to config-service

// config-service updates status
PUT /api/v1/workspaces/:workspaceId/status
Body: { status, podName, endpoint, errorMessage }
→ Updates database only
```

### Polling Strategy

```typescript
// WorkspacePollerService runs periodically (e.g., every 10 seconds)
class WorkspacePollerService {
  private pollInterval: number = 10000; // 10 seconds (configurable)
  
  async start(): Promise<void> {
    // Poll immediately on start
    await this.pollWorkspaces();
    
    // Then poll at regular intervals
    setInterval(() => {
      this.pollWorkspaces().catch(err => {
        console.error('[WorkspacePoller] Error polling workspaces:', err);
      });
    }, this.pollInterval);
  }
  
  async pollWorkspaces(): Promise<void> {
    try {
      // Get deployment context from environment
      const deploymentContext = this.getDeploymentContext();
      
      // Query config-service for workspaces needing management
      // Filter by deployment context to only manage workspaces for this deployment
      const workspaces = await configServiceClient.getWorkspaces({
        status: ['new', 'creating', 'stopping'],
        deploymentId: deploymentContext.deploymentId,
        deploymentType: deploymentContext.deploymentType,
      });
      
      for (const workspace of workspaces) {
        // Verify workspace matches this deployment context
        if (!this.matchesDeploymentContext(workspace, deploymentContext)) {
          continue;
        }
        
        if (workspace.status === 'new' || workspace.status === 'creating') {
          // Ensure CRD exists (idempotent)
          await crdManager.ensureCRD(workspace);
        } else if (workspace.status === 'stopping') {
          // Delete CRD (controller will clean up resources)
          await crdManager.deleteCRD(workspace.id);
        }
      }
    } catch (error) {
      console.error('[WorkspacePoller] Failed to poll workspaces:', error);
      // Continue polling even on error
    }
  }
  
  private getDeploymentContext(): { deploymentId: string; deploymentType: 'nemo' | 'ray' } {
    // Read from environment variables
    const deploymentId = process.env.DEPLOYMENT_ID || 'nemo';
    const deploymentType = (process.env.DEPLOYMENT_TYPE || 'nemo') as 'nemo' | 'ray';
    return { deploymentId, deploymentType };
  }
  
  private matchesDeploymentContext(workspace: any, context: any): boolean {
    // Match by deploymentId and deploymentType
    return workspace.deploymentId === context.deploymentId &&
           workspace.deploymentType === context.deploymentType;
  }
}
```

### Polling Configuration

- **Poll Interval**: Configurable (default: 10 seconds)
- **Environment Variable**: `WORKSPACE_POLL_INTERVAL_MS` (in milliseconds)
- **Query Parameters**: Filter by status (`new`, `creating`, `stopping`)
- **Deployment Context**: Filter by `deploymentId` and `deploymentType` to only manage relevant workspaces
  - **Environment Variables**:
    - `DEPLOYMENT_ID`: Deployment identifier (e.g., `nemo`, `us-west-2`)
    - `DEPLOYMENT_TYPE`: Type of deployment (`nemo` or `ray`)
- **Idempotent**: Safe to poll frequently, CRD creation is idempotent
- **Resilient**: Continues polling even if config-service is temporarily unavailable

### Error Handling

With CRD approach, error handling is much simpler:

```typescript
// Old approach (complex) - in workspace-service
try {
  await createPod();
} catch (error) {
  if (isNotFoundError(error)) { ... }
  if (isConflictError(error)) { ... }
  // Complex error extraction
}

// New approach (simple) - in Controller
await ensurePod(workspace); // Controller handles all errors
// Errors are reflected in CRD status.conditions
// workspace-service watches CRD and syncs status to config-service
```

### Status Conditions

```typescript
conditions: [
  {
    type: 'PVCReady',
    status: 'True',
    lastTransitionTime: '2024-01-01T00:00:00Z',
  },
  {
    type: 'PodReady',
    status: 'True',
    lastTransitionTime: '2024-01-01T00:01:00Z',
  },
  {
    type: 'ServiceReady',
    status: 'True',
    lastTransitionTime: '2024-01-01T00:02:00Z',
  },
]
```

### Reconciliation

Controller automatically reconciles:
- If Pod is deleted, recreates it
- If PVC is missing, creates it
- If status is out of sync, updates it
- Handles all race conditions automatically

### Workspace Type Handling

The controller is **workspace-type agnostic** and adapts resource creation based on the workspace type:

```typescript
class WorkspaceController {
  async reconcile(workspace: WorkspaceCRD): Promise<void> {
    const workspaceType = workspace.spec.template.type;
    
    switch (workspaceType) {
      case 'jupyterlab':
        await this.createJupyterLabResources(workspace);
        break;
      case 'sql-workbench':
        await this.createSQLWorkbenchResources(workspace);
        break;
      case 'vscode':
        await this.createVSCodeResources(workspace);
        break;
      default:
        await this.createCustomResources(workspace);
    }
  }
  
  private async createJupyterLabResources(workspace: WorkspaceCRD): Promise<void> {
    // JupyterLab-specific resource creation
    // - Pod with JupyterLab image
    // - Service exposing JupyterLab port (8888)
    // - PVC for user data
    // - ConfigMap for JupyterLab configuration
  }
  
  private async createSQLWorkbenchResources(workspace: WorkspaceCRD): Promise<void> {
    // SQL Workbench-specific resource creation
    // - Pod with SQL Workbench image
    // - Service exposing SQL Workbench port (different from JupyterLab)
    // - PVC for query history and saved queries
    // - ConfigMap for SQL Workbench configuration
    // - Potentially different resource requirements
  }
}
```

### Multi-Deployment Support

The same workspace-service codebase can be deployed in multiple contexts:

#### AgentStudio Deployment
- **Deployment ID**: `nemo`
- **Deployment Type**: `nemo`
- **Workspace Types**: Primarily `jupyterlab`, `vscode`
- **Namespace**: `nemo` (or configurable)
- **Environment Variables**:
  ```bash
  DEPLOYMENT_ID=nemo
  DEPLOYMENT_TYPE=nemo
  CONFIG_SERVICE_URL=http://config-service:3000
  ```

#### Ray Deployment
- **Deployment ID**: Region-specific (e.g., `us-west-2`)
- **Deployment Type**: `ray`
- **Workspace Types**: Primarily `sql-workbench`
- **Namespace**: Ray deployment namespace (e.g., `ray-us-west-2`)
- **Environment Variables**:
  ```bash
  DEPLOYMENT_ID=us-west-2
  DEPLOYMENT_TYPE=ray
  CONFIG_SERVICE_URL=http://config-service.nemo.svc.cluster.local:3000
  ```

#### Deployment Context Filtering

Each workspace-service instance only manages workspaces for its deployment context:

1. **Polling**: Filters workspaces by `deploymentId` and `deploymentType`
2. **CRD Creation**: Includes deployment context in CRD spec
3. **Controller**: Only watches CRDs in its namespace (deployment-specific)
4. **Status Sync**: Updates config-service with deployment context

This ensures:
- **Isolation**: AgentStudio workspace-service doesn't interfere with Ray workspaces
- **Scalability**: Each deployment manages its own workspaces independently
- **Flexibility**: Same codebase, different configurations

## Benefits Summary

1. **Simpler Code**: 70% less error handling code
2. **More Reliable**: Automatic retry and reconciliation
3. **Better Observability**: Status visible in `kubectl get workspaces`
4. **Standard Pattern**: Uses Kubernetes operator pattern
5. **Easier Testing**: Can test with fake Kubernetes client
6. **Better Scalability**: Async processing, no blocking
7. **Clean Separation**: config-service is database-only, no K8s dependencies
8. **Decoupled**: workspace-service polls independently, no tight coupling
9. **Resilient**: Polling continues even if services are temporarily unavailable
10. **Idempotent**: Safe to poll frequently, operations are idempotent

## Implementation Components

### 1. Workspace CRD Definition

Create CRD YAML file (deployed via Helm or kubectl):
- `deployments/helm/services/charts/workspace-manager/templates/crd.yaml`

### 2. Workspace Controller (in workspace-service)

Implement controller in workspace-service:
- Location: `src/nemo/workspace-manager/src/controller/WorkspaceController.ts`
- Uses Kubernetes client-node (already in use)
- Watches Workspace CRDs via informer
- Reconciles desired state

### 3. Workspace Poller Service (in workspace-service)

Service to poll config-service for workspaces to manage:
- Location: `src/nemo/workspace-manager/src/services/WorkspacePollerService.ts`
- Periodically queries config-service API: `GET /api/v1/workspaces?status=new,creating`
- Identifies workspaces that need CRD creation
- Detects workspace status changes (stopping, deleted)
- Triggers CRD creation/update/deletion

### 4. CRD Manager Service (in workspace-service)

Service to create/update CRDs:
- Location: `src/nemo/workspace-manager/src/services/CRDManagerService.ts`
- Creates Workspace CRD when poller detects workspace needs launching
- Updates CRD spec when workspace config changes
- Deletes CRD when workspace is deleted or stopped

### 5. Status Watcher Service (in workspace-service)

Service to watch CRD status and sync to config-service:
- Location: `src/nemo/workspace-manager/src/services/StatusWatcherService.ts`
- Watches Workspace CRD status changes
- Calls config-service API to update database: `PUT /api/v1/workspaces/:workspaceId/status`
- Handles retries and error recovery

### 6. config-service API Updates

Minimal changes to config-service:
- Add endpoint for workspace-service to query workspaces: 
  ```
  GET /api/v1/workspaces?status=new,creating,stopping&deploymentId=<id>&deploymentType=<type>
  ```
  - Query parameters:
    - `status`: Comma-separated list of statuses to filter (e.g., `new,creating,stopping`)
    - `deploymentId`: Filter by deployment ID (e.g., `nemo`, `us-west-2`)
    - `deploymentType`: Filter by deployment type (`nemo` or `ray`)
  - Returns: List of workspaces matching the filters
- Add endpoint for workspace-service to update status: `PUT /api/v1/workspaces/:workspaceId/status`
  - Body: `{ status, podName, endpoint, errorMessage, ... }`
  - Updates database only (no Kubernetes operations)
- No Kubernetes dependencies needed
- No CRD creation or monitoring code
- Only database operations

## Next Steps

1. **Create CRD definition YAML**
   - Add to Helm chart templates
   - Deploy with workspace-service

2. **Implement Workspace Controller in workspace-service**
   - Use Kubernetes client-node (current library)
   - Implement reconciliation loop
   - Handle all resource creation/updates

3. **Add CRD Manager Service**
   - Create/update/delete Workspace CRDs
   - Called from launch/stop endpoints

4. **Add Status Watcher Service**
   - Watch CRD status changes
   - Sync status to config-service via API callback

5. **Add Workspace Poller Service**
   - Poll config-service for workspaces to manage
   - Trigger CRD creation/update/deletion based on workspace status
   - Run as background service with configurable interval

6. **Remove imperative API from workspace-service**
   - Remove direct Pod/PVC/Service creation endpoints
   - Keep only polling, CRD management, controller, and status watching

7. **Update config-service API**
   - Add query endpoint: `GET /api/v1/workspaces?status=new,creating,stopping&deploymentId=<id>&deploymentType=<type>`
     - Support filtering by `deploymentId` and `deploymentType` for multi-deployment support
   - Add status update endpoint: `PUT /api/v1/workspaces/:workspaceId/status`
   - No Kubernetes dependencies
   - Only database operations

8. **Test implementation**
   - Deploy CRD and controller
   - Test polling mechanism
   - Test CRD creation and reconciliation
   - Test status sync to config-service
   - Test workspace lifecycle (create, stop, delete)

## Key Architectural Decisions

### 1. Polling-Based Discovery

**Decision**: workspace-service polls config-service to discover workspaces to manage

**Rationale**:
- Keeps config-service completely stateless (database-only)
- No tight coupling between services
- workspace-service can recover independently
- Configurable polling interval for performance tuning

**Implementation**:
- workspace-service polls every 10 seconds (configurable)
- Queries: `GET /api/v1/workspaces?status=new,creating,stopping&deploymentId=<id>&deploymentType=<type>`
- Filters by deployment context to only manage relevant workspaces
- Idempotent operations ensure safe frequent polling

### 2. config-service is Database-Only

**Decision**: config-service has zero Kubernetes dependencies

**Rationale**:
- Simpler deployment and testing
- Can scale independently
- No need for Kubernetes access in config-service pods
- Clear separation of concerns

**Implementation**:
- Only database operations
- REST API for workspace CRUD
- Query endpoint for workspace-service polling
- Status update endpoint for workspace-service callbacks

### 3. workspace-service Manages All CRD Operations

**Decision**: All CRD creation, monitoring, and status syncing happens in workspace-service

**Rationale**:
- Single point of Kubernetes knowledge
- Easier to maintain and debug
- Controller runs in same service as CRD management
- Better resource utilization

**Implementation**:
- Workspace Poller Service (polls config-service)
- CRD Manager Service (creates/updates/deletes CRDs)
- Workspace Controller (reconciles CRD state)
- Status Watcher Service (syncs CRD status to config-service)

### 4. Multi-Deployment Support

**Decision**: Same workspace-service codebase deployed in multiple contexts (AgentStudio and Ray)

**Rationale**:
- Code reuse: Single codebase for all workspace types
- Consistency: Same patterns and behaviors across deployments
- Flexibility: Easy to add new workspace types or deployment contexts
- Isolation: Each deployment manages only its own workspaces

**Implementation**:
- Deployment context via environment variables (`DEPLOYMENT_ID`, `DEPLOYMENT_TYPE`)
- Context-aware polling: Filters workspaces by deployment context
- Workspace-type agnostic controller: Adapts resource creation based on workspace type
- Namespace isolation: Each deployment uses its own Kubernetes namespace
- Flexible CRD spec: Supports different workspace types (JupyterLab, SQL Workbench, etc.)

**Workspace Types Supported**:
- `jupyterlab`: JupyterLab workspaces (AgentStudio deployment)
- `sql-workbench`: SQL Workbench workspaces (Ray deployment)
- `vscode`: VS Code workspaces (AgentStudio deployment)
- `custom`: Custom workspace types (both deployments)


# Workspace Architecture - Separation of Concerns

## Current Problem

The `WorkspaceOrchestratorService` in `config-service` violates several design principles:

1. **Single Responsibility Principle**: Config-service should manage configuration/state, not Kubernetes orchestration
2. **Separation of Concerns**: Infrastructure operations mixed with business logic
3. **Tight Coupling**: Config-service now depends on Kubernetes client libraries
4. **Scalability**: Kubernetes operations should be independently scalable
5. **Deployment Complexity**: Config-service needs Kubernetes RBAC permissions

## Recommended Architecture

### Option 1: Separate Orchestrator Service (Recommended) ⭐

```
┌─────────────────┐         HTTP API         ┌──────────────────────┐
│  config-service │ ────────────────────────> │ workspace-orchestrator     │
│                 │                           │      -service        │
│ - State Mgmt    │ <──────────────────────── │                      │
│ - Validation    │    Status Updates        │ - K8s Operations     │
│ - Business Logic│                           │ - Pod/PVC/Service    │
│ - Database      │                           │ - Resource Lifecycle │
└─────────────────┘                           └──────────────────────┘
```

**Benefits:**
- ✅ Clear separation: Config = state, Orchestrator = infrastructure
- ✅ Independent scaling and deployment
- ✅ Different security boundaries (K8s RBAC only on orchestrator)
- ✅ Can be written in different languages if needed
- ✅ Easier to test (mock orchestrator API)
- ✅ Follows existing pattern (storage-manager handles storage K8s ops)

**Communication Pattern:**
```typescript
// config-service calls orchestrator
POST /api/v1/workspaces/{id}/launch
{
  workspaceId: string,
  template: WorkspaceTemplate,
  s3Config: { bucketName, accessKey, secretKey, endpoint }
}

// Orchestrator returns immediately with operation ID
{
  operationId: string,
  status: 'pending'
}

// Orchestrator calls back to config-service to update status
PUT /api/v1/workspaces/{id}/status
{
  status: 'running' | 'error',
  podName: string,
  endpoint: string,
  error?: string
}
```

### Option 2: Event-Driven Architecture

```
┌─────────────────┐                           ┌──────────────────────┐
│  config-service │  Publishes Event          │ workspace-orchestrator     │
│                 │ ─────────────────────────> │      -service        │
│ - State Mgmt    │                           │                      │
│ - Validation    │  Status Event             │ - K8s Operations     │
│ - Business Logic│ <──────────────────────── │ - Pod/PVC/Service   │
│ - Database      │                           │ - Resource Lifecycle │
└─────────────────┘                           └──────────────────────┘
       │                                              │
       └─────────── Message Queue ───────────────────┘
                  (Kafka/RabbitMQ)
```

**Benefits:**
- ✅ Decoupled (async communication)
- ✅ Better for high-volume operations
- ✅ Natural retry mechanism
- ✅ Can have multiple orchestrators

**Drawbacks:**
- ❌ More complex (requires message queue)
- ❌ Harder to debug (async flows)
- ❌ Eventual consistency

### Option 3: Hybrid (API + Events)

Use HTTP API for synchronous operations (launch/stop), events for status updates.

## Recommended Implementation: Separate Orchestrator Service

### Service Responsibilities

#### config-service (State Management)
- ✅ CRUD operations for Workspace/WorkspaceTemplate
- ✅ Business logic validation
- ✅ Status tracking in database
- ✅ API endpoints for UI
- ❌ NO Kubernetes operations
- ❌ NO direct K8s client dependencies

#### workspace-orchestrator (Infrastructure)
- ✅ Kubernetes Pod/PVC/Service creation
- ✅ Resource lifecycle management
- ✅ S3 sync operations
- ✅ Library installation coordination
- ✅ Health checks and monitoring
- ✅ Status callbacks to config-service
- ❌ NO database access (except maybe for operation logs)

### File Structure

```
src/nemo/
├── config-service/
│   ├── services/
│   │   ├── WorkspaceService.ts          # State management only
│   │   └── WorkspaceTemplateService.ts
│   └── routes/
│       └── workspaceRoutes.ts           # Thin HTTP layer
│
└── workspace-orchestrator/                  # NEW SERVICE
    ├── src/
    │   ├── services/
    │   │   ├── WorkspaceOrchestratorService.ts  # K8s operations
    │   │   ├── PodManager.ts
    │   │   ├── PVCManager.ts
    │   │   └── ServiceManager.ts
    │   ├── routes/
    │   │   └── orchestratorRoutes.ts
    │   ├── clients/
    │   │   └── ConfigServiceClient.ts   # Callback to config-service
    │   └── index.ts
    ├── package.json
    └── Dockerfile
```

### Implementation Steps

1. **Create workspace-orchestrator**
   - Move `WorkspaceOrchestratorService` from config-service
   - Add HTTP API endpoints
   - Add callback client to config-service

2. **Update config-service**
   - Remove Kubernetes dependencies
   - Add HTTP client to call orchestrator
   - Add callback endpoint for status updates
   - Keep only state management logic

3. **Communication Contract**
   - Define API contract between services
   - Add OpenAPI specs for both services
   - Implement retry logic and error handling

## Code Changes

### config-service/services/WorkspaceService.ts

```typescript
import axios from 'axios';

const WORKSPACE_ORCHESTRATOR_URL = process.env.WORKSPACE_ORCHESTRATOR_URL || 'http://workspace-orchestrator:8080';

export class WorkspaceService extends BaseService {
  static async launchWorkspace(
    workspaceId: string,
    namespaceId: string
  ): Promise<Workspace> {
    const workspace = await this.getWorkspaceOrThrow(workspaceId, namespaceId);
    
    // Validation (stays in config-service)
    if (workspace.status === 'running') {
      throw new BusinessLogicError('Workspace is already running');
    }

    // Update status to creating
    workspace.status = 'creating';
    await workspaceRepo().save(workspace);

    try {
      // Call orchestrator service (infrastructure concern)
      const template = await WorkspaceTemplateService.getTemplateOrThrow(workspace.templateId);
      
      await axios.post(`${ORCHESTRATOR_SERVICE_URL}/api/v1/workspaces/${workspaceId}/launch`, {
        workspaceId: workspace.id,
        namespaceId,
        template: {
          type: template.type,
          environment: template.environment,
          resources: template.resources,
        },
        s3Config: {
          bucketName: workspace.bucketName,
          accessKey: process.env.S3_ACCESS_KEY,
          secretKey: process.env.S3_SECRET_KEY,
          endpoint: process.env.S3_ENDPOINT,
        },
      });

      // Status will be updated via callback from orchestrator
      return workspace;
    } catch (error: any) {
      workspace.status = 'error';
      workspace.metadata = {
        ...workspace.metadata,
        errorMessage: error.message,
      };
      await workspaceRepo().save(workspace);
      throw error;
    }
  }

  // Callback endpoint for orchestrator to update status
  static async updateWorkspaceStatus(
    workspaceId: string,
    status: WorkspaceStatus,
    resources?: { podName?: string; endpoint?: string; pvcName?: string }
  ): Promise<Workspace> {
    const workspace = await this.getWorkspaceOrThrow(workspaceId);
    workspace.status = status;
    if (resources) {
      if (resources.podName) workspace.podName = resources.podName;
      if (resources.endpoint) workspace.endpoint = resources.endpoint;
      if (resources.pvcName) workspace.pvcName = resources.pvcName;
    }
    return await workspaceRepo().save(workspace);
  }
}
```

### workspace-orchestrator/src/services/WorkspaceOrchestratorService.ts

```typescript
import * as k8s from '@kubernetes/client-node';
import axios from 'axios';

const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';

export class WorkspaceOrchestratorService {
  // Move all K8s operations here
  static async launchWorkspace(options: LaunchWorkspaceOptions): Promise<void> {
    // ... existing K8s operations ...
    
    // Callback to config-service to update status
    await this.updateConfigServiceStatus(options.workspaceId, 'running', {
      podName,
      endpoint,
      pvcName,
    });
  }

  private static async updateConfigServiceStatus(
    workspaceId: string,
    status: string,
    resources: any
  ): Promise<void> {
    await axios.put(
      `${CONFIG_SERVICE_URL}/api/v1/internal/workspaces/${workspaceId}/status`,
      { status, ...resources }
    );
  }
}
```

## Benefits Summary

| Aspect | Current (Monolithic) | Proposed (Separated) |
|--------|---------------------|---------------------|
| **Responsibility** | Mixed (state + infra) | Clear separation |
| **Dependencies** | Config needs K8s client | Only orchestrator needs K8s |
| **Scaling** | Scale together | Scale independently |
| **Security** | Config needs K8s RBAC | Only orchestrator needs RBAC |
| **Testing** | Hard to mock K8s | Easy to mock orchestrator API |
| **Deployment** | Single service | Independent deployments |
| **Maintainability** | Tightly coupled | Loosely coupled |

## Migration Path

1. **Phase 1**: Create orchestrator service alongside existing code
2. **Phase 2**: Update config-service to call orchestrator (feature flag)
3. **Phase 3**: Remove K8s code from config-service
4. **Phase 4**: Add monitoring, retries, circuit breakers

## Conclusion

**Recommendation**: Extract `WorkspaceOrchestratorService` into a separate `workspace-orchestrator` service that communicates with `config-service` via HTTP API. This maintains clear separation of concerns, follows existing patterns (storage-manager), and provides better scalability and maintainability.


# Analytics Service Redesign - Final Design Document

## Architecture Overview

### Service Split

1. **analytics-service** (TypeScript, `nemo` namespace)
   - Session management and state (source of truth)
   - Session-to-endpoint mapping
   - Periodic polling of analytics-engine for status updates
   - Database persistence
   - Returns full query URLs to frontend

2. **analytics-engine** (Go, Ray namespace)
   - Agent to analytics-service
   - Pod orchestration (GizmoSQL deployment with init container)
   - Query execution via Flight SQL
   - Status reporting (exposes polling endpoint)
   - No callbacks - passive agent pattern

## Updated Architecture Flow

### Session Launch Flow

```
1. Frontend → AgentStudio Gateway → analytics-service (AgentStudio)
   POST /api/v1/namespaces/:ns/datasets/:ds/analytics/launch
   
   analytics-service:
   - Validates dataset
   - Gets bucket routing → determines Ray deployment
   - Creates session in DB (status: "initializing")
   - Determines analytics-engine endpoint
   - Calls analytics-engine to initialize

2. analytics-service → Ray API Gateway → analytics-engine (Ray)
   POST /api/v1/internal/sessions
   {
     sessionId, namespaceId, datasetId,
     datasetInfo, podSize
   }

3. analytics-engine:
   - Creates GizmoSQL deployment with init container
   - Init container processes LanceDB data
   - Waits for pod ready
   - Gets GizmoSQL endpoint
   - Stores session state locally (in-memory or cache)

4. analytics-service (Periodic Polling):
   - Polls analytics-engine: GET /api/v1/internal/sessions/:sessionId/status
   - Updates session in DB when status changes
   - Continues polling until session is ready/error/stopped

5. analytics-service → Frontend
   Returns session with full query URL:
   {
     session: {
       id: "...",
       status: "ready",
       queryUrl: "http://ray-us-east-1-apigateway/analytics/api/v1/sessions/{sessionId}/query",
       schemaUrl: "http://ray-us-east-1-apigateway/analytics/api/v1/sessions/{sessionId}/schema/dataset",
       deploymentId: "ray-us-east-1"
     }
   }
```

### Status Update Patterns

#### Pattern A: Polling (Recommended for Initial Implementation)

```typescript
// analytics-service (AgentStudio)
class AnalyticsSessionService {
  private pollInterval = 5000; // 5 seconds
  
  async startSessionPolling(sessionId: string) {
    const interval = setInterval(async () => {
      try {
        const session = await this.getSession(sessionId);
        if (session.status === 'stopped' || session.status === 'error') {
          clearInterval(interval);
          return;
        }
        
        // Get proxy endpoint from session
        const proxyEndpoint = session.metadata?.proxyEndpoint;
        if (!proxyEndpoint) {
          clearInterval(interval);
          return;
        }
        
        // Poll analytics-engine for status
        const status = await this.httpClient.get(
          `${proxyEndpoint}/api/v1/internal/sessions/${sessionId}/status`
        );
        
        // Update session if status changed
        if (status.podStatus !== session.status) {
          await this.updateSession(sessionId, {
            status: status.podStatus,
            gizmosqlEndpoint: status.gizmosqlEndpoint,
            errorMessage: status.errorMessage
          });
        }
      } catch (error) {
        console.error(`Failed to poll session ${sessionId}:`, error);
        // Continue polling on error
      }
    }, this.pollInterval);
  }
}
```

#### Pattern B: Push Updates (Like SysManager - Future Enhancement)

```go
// analytics-engine (Go)
type SessionStatusReport struct {
    SessionID      string    `json:"sessionId"`
    PodStatus      string    `json:"podStatus"`
    GizmoSQLEndpoint string  `json:"gizmosqlEndpoint"`
    ErrorMessage   string    `json:"errorMessage,omitempty"`
    LastUpdated    time.Time `json:"lastUpdated"`
}

func (p *AnalyticsProxy) reportStatuses() {
    ticker := time.NewTicker(30 * time.Second) // Report every 30 seconds
    defer ticker.Stop()
    
    for range ticker.C {
        sessions := p.getAllActiveSessions()
        report := make([]SessionStatusReport, 0, len(sessions))
        
        for _, session := range sessions {
            podStatus := p.getPodStatus(session.PodID)
            report = append(report, SessionStatusReport{
                SessionID:        session.SessionID,
                PodStatus:        podStatus.Status,
                GizmoSQLEndpoint: podStatus.Endpoint,
                ErrorMessage:     podStatus.Error,
                LastUpdated:      time.Now(),
            })
        }
        
        // Send batch update to analytics-service
        p.sendStatusUpdateBatch(report)
    }
}
```

### Query Execution Flow

```
1. Frontend → Ray API Gateway → analytics-engine (Ray)
   POST {queryUrl}
   POST http://ray-us-east-1-apigateway/analytics/api/v1/sessions/{sessionId}/query
   Body: { sql: "SELECT * FROM dataset LIMIT 100" }

2. analytics-engine:
   - Validates session exists locally
   - Gets GizmoSQL endpoint from session cache
   - Executes query via Flight SQL client (Go)
   - Converts Arrow results to JSON

3. analytics-engine → Frontend
   { columns, rows, rowCount, executionTime }
```

### Session Deletion Flow

```
1. Frontend → AgentStudio Gateway → analytics-service (AgentStudio)
   DELETE /api/v1/namespaces/:ns/analytics/:sessionId
   
2. analytics-service:
   - Marks session as "stopping" in DB
   - Gets proxy endpoint from session
   
3. analytics-service → Ray API Gateway → analytics-engine (Ray)
   DELETE /api/v1/internal/sessions/:sessionId
   
4. analytics-engine:
   - Deletes GizmoSQL pod
   - Removes session from local cache
   - Returns success
   
5. analytics-service:
   - Updates session status to "stopped" in DB
   - Stops polling for this session
```

### Pod Failure Reconciliation Flow

```
1. analytics-engine detects pod failure:
   - Pod crashes or becomes unhealthy
   - Status check fails
   
2. analytics-engine updates local status:
   - Marks session as "error"
   - Stores error message
   
3. analytics-service (next poll):
   - Polls analytics-engine
   - Gets error status
   - Updates session in DB with error
   - Stops polling
   
4. Frontend (next status check):
   - Gets session status from analytics-service
   - Displays error to user
```

## API Design

### analytics-service (AgentStudio) - Public APIs

```typescript
// Session Management
POST   /api/v1/namespaces/:namespaceId/datasets/:datasetId/analytics/launch
  Response: {
    session: {
      id: string,
      status: "initializing" | "processing" | "ready" | "error" | "stopped",
      queryUrl: "http://{deployment}-apigateway/analytics/api/v1/sessions/{sessionId}/query",
      schemaUrl: "http://{deployment}-apigateway/analytics/api/v1/sessions/{sessionId}/schema/dataset",
      deploymentId: string,
      createdAt: string,
      expiresAt: string
    }
  }

GET    /api/v1/namespaces/:namespaceId/analytics/:sessionId
  Response: {
    session: {
      id: string,
      status: string,
      queryUrl: string,
      schemaUrl: string,
      errorMessage?: string,
      ...
    }
  }

GET    /api/v1/namespaces/:namespaceId/analytics?datasetId={datasetId}
DELETE /api/v1/namespaces/:namespaceId/analytics/:sessionId
```

### analytics-engine (Ray) - Internal APIs

```go
// Initialization (called by analytics-service)
POST   /api/v1/internal/sessions
  Request: {
    sessionId: string,
    namespaceId: string,
    datasetId: string,
    datasetInfo: {
      bucketName: string,
      datasetPrefix: string,
      fileTypes: string[],
      ...
    },
    podSize: {
      memory: string,  // e.g., "4Gi"
      cpu: string      // e.g., "2000m"
    },
  }
  Response: {
    sessionId: string,
    podId: string,
    status: "processing" | "ready" | "error",
    gizmosqlEndpoint: string,  // e.g., "gizmosql-abc:31337"
    errorMessage: string  // if error
  }

// Status Polling (called by analytics-service)
GET    /api/v1/internal/sessions/:sessionId/status
  Response: {
    sessionId: string,
    podStatus: "processing" | "ready" | "error" | "stopped",
    gizmosqlEndpoint: string,
    podId: string,
    errorMessage: string,  // if error
    lastUpdated: string
  }

// Batch Status Report (Pattern B - future)
POST   /api/v1/internal/sessions/status/batch
  Request: {
    sessions: [
      {
        sessionId: string,
        podStatus: string,
        gizmosqlEndpoint: string,
        errorMessage: string,
        lastUpdated: string
      }
    ]
  }
  Response: { success: true }

// Cleanup (called by analytics-service)
DELETE /api/v1/internal/sessions/:sessionId
  Response: { success: true }
```

### analytics-engine (Ray) - Public APIs (for GUI)

```go
// Query Execution
POST   /api/v1/sessions/:sessionId/query
  Request: { sql: string }
  Response: {
    columns: string[],
    rows: any[][],
    rowCount: number,
    executionTime: number
  }

// Schema
GET    /api/v1/sessions/:sessionId/schema/:tableName
  Response: {
    tableName: string,
    columns: [
      {
        name: string,
        type: string,
        nullable: boolean
      }
    ]
  }
```

## Updated Component Responsibilities

### analytics-service (AgentStudio)

**Responsibilities:**
- ✅ Session CRUD operations (database)
- ✅ Session-to-endpoint mapping
- ✅ Deployment routing (uses existing routing service)
- ✅ Periodic status polling from analytics-engine
- ✅ User action handling (launch, stop sessions)
- ✅ Returns full query URLs to frontend
- ✅ Source of truth for session state

**Does NOT:**
- ❌ Direct Kubernetes API access
- ❌ Pod orchestration
- ❌ Query execution
- ❌ Flight SQL client

**Database Schema:**
```typescript
AnalyticsSession {
  id: string
  namespaceId: string
  datasetId: string
  status: "pending" | "initializing" | "processing" | "ready" | "error" | "stopped"
  deploymentId: string  // Ray deployment ID
  proxyEndpoint: string  // analytics-engine endpoint
  queryUrl: string  // Full URL for queries
  schemaUrl: string  // Full URL for schema
  gizmosqlEndpoint: string  // GizmoSQL service endpoint (from proxy)
  podId: string  // Pod ID (from proxy)
  errorMessage?: string
  metadata: {
    datasetInfo: {...},
    podSize: {...},
    processingStartedAt: string,
    readyAt: string,
    ...
  }
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
}
```

### analytics-engine (Ray)

**Responsibilities:**
- ✅ Pod orchestration (GizmoSQL deployment with init container)
- ✅ LanceDB processing (via init container)
- ✅ Flight SQL client (Go native)
- ✅ Query execution
- ✅ Status reporting (exposes polling endpoint)
- ✅ Pod lifecycle management
- ✅ Local session cache (in-memory or Redis)

**Does NOT:**
- ❌ Database access (except maybe operation logs)
- ❌ Session state persistence (analytics-service is source of truth)
- ❌ Callbacks to analytics-service (passive agent)

**Local State (In-Memory/Cache):**
```go
type SessionState struct {
    SessionID        string
    NamespaceID      string
    DatasetID        string
    PodID            string
    PodName          string
    GizmoSQLEndpoint string
    Status           string  // "processing" | "ready" | "error" | "stopped"
    ErrorMessage     string
    CreatedAt        time.Time
    LastUpdated      time.Time
}
```

## Deployment Routing Integration

```typescript
// analytics-service (AgentStudio)
async launchAnalytics(namespaceId: string, datasetId: string): Promise<AnalyticsSession> {
  // 1. Get dataset metadata
  const dataset = await configClient.getDataset(namespaceId, datasetId);
  
  if (!dataset.bucketName) {
    throw new Error('Dataset must have a bucket assigned');
  }
  
  // 2. Get bucket routing to determine Ray deployment
  const routing = await DeploymentService.getBucketRouting(
    namespaceId,
    dataset.bucketName
  );
  
  if (!routing.deployments || routing.deployments.length === 0) {
    throw new Error(`No deployment assigned to bucket ${dataset.bucketName}`);
  }
  
  // 3. Select primary deployment (or use routing strategy)
  const primaryDeployment = routing.deployments.find(d => d.role === 'primary') 
    || routing.deployments[0];
  
  // 4. Build analytics-engine endpoint
  const proxyEndpoint = this.buildProxyEndpoint(primaryDeployment.deployment_id);
  
  // 5. Build query URLs
  const queryUrl = `${proxyEndpoint}/api/v1/sessions/{sessionId}/query`;
  const schemaUrl = `${proxyEndpoint}/api/v1/sessions/{sessionId}/schema/dataset`;
  
  // 6. Create session in DB
  const session = await this.createSession({
    namespaceId,
    datasetId,
    status: 'initializing',
    deploymentId: primaryDeployment.deployment_id,
    proxyEndpoint,
    queryUrl: queryUrl.replace('{sessionId}', '${sessionId}'), // Template
    schemaUrl: schemaUrl.replace('{sessionId}', '${sessionId}'),
    metadata: {
      datasetInfo: {
        bucketName: dataset.bucketName,
        datasetPrefix: `datasets/${datasetId}`,
        // ... other dataset info
      },
      podSize: {
        memory: '4Gi',
        cpu: '2000m'
      }
    }
  });
  
  // 7. Call analytics-engine to initialize
  try {
    const initResponse = await this.httpClient.post(
      `${proxyEndpoint}/api/v1/internal/sessions`,
      {
        sessionId: session.id,
        namespaceId,
        datasetId,
        datasetInfo: session.metadata.datasetInfo,
        podSize: session.metadata.podSize
      }
    );
    
    // 8. Update session with pod info
    await this.updateSession(session.id, {
      podId: initResponse.podId,
      gizmosqlEndpoint: initResponse.gizmosqlEndpoint,
      status: initResponse.status
    });
    
    // 9. Start polling for status updates
    this.startSessionPolling(session.id);
    
    return session;
  } catch (error) {
    await this.updateSession(session.id, {
      status: 'error',
      errorMessage: error.message
    });
    throw error;
  }
}

private buildProxyEndpoint(deploymentId: string): string {
  // Format: http://{deployment-id}-apigateway
  // For internal K8s: http://{deployment-id}-apigateway.{namespace}.svc.cluster.local
  const namespace = deploymentId; // deployment ID is typically the namespace
  return `http://${deploymentId}-apigateway.${namespace}.svc.cluster.local`;
}
```

## GizmoSQL Pod Design (Updated - Init Container)

```yaml
# Created by analytics-engine
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gizmosql-{sessionId}
spec:
  replicas: 1
  template:
    spec:
      serviceAccountName: analytics-processor
      initContainers:
      - name: lancedb-processor
        image: docker.repo.eng.netapp.com/user/$(USER)/lancedb-processor:latest
        env:
        - name: SESSION_ID
          value: {sessionId}
        - name: DATASET_ID
          value: {datasetId}
        - name: NAMESPACE_ID
          value: {namespaceId}
        - name: LOCAL_OUTPUT_PATH
          value: /data
        - name: S3_ENDPOINT
          value: http://{deployment}-apigateway:80
        volumeMounts:
        - name: lancedb-data
          mountPath: /data
        resources:
          requests:
            memory: 2Gi
            cpu: 1000m
          limits:
            memory: 8Gi
            cpu: 4000m
      containers:
      - name: gizmosql
        image: gizmodata/gizmosql:latest
        env:
        - name: INIT_SQL_COMMANDS
          value: |
            INSTALL lance FROM community;
            LOAD lance;
            CREATE VIEW dataset AS 
            SELECT * FROM '/data/lancedb-table/dataset.lance';
        volumeMounts:
        - name: lancedb-data
          mountPath: /data
          readOnly: true
        ports:
        - containerPort: 31337
        resources:
          requests:
            memory: 2Gi
            cpu: 1000m
          limits:
            memory: 4Gi
            cpu: 2000m
      volumes:
      - name: lancedb-data
        emptyDir: {}
```

## Gateway Configuration

### AgentStudio Gateway

```go
// src/nemo/apigateway-service/main.go
setupServiceProxy(r, "/analytics", "ANALYTICS_SERVICE_URL", "analytics-service")
// ANALYTICS_SERVICE_URL = http://analytics-service.nemo.svc.cluster.local:4000
```

Routes: `http://nemo-gateway/analytics/*` → `analytics-service` (AgentStudio)

### Ray API Gateway

```typescript
// src/ray/apigateway/src/server/Server.ts
private analyticsProxyUrl: string;

constructor() {
  this.analyticsProxyUrl = process.env.ANALYTICS_PROXY_URL 
    || 'http://analytics-engine:5000';
}

private handleAnalyticsProxy(req: Request, res: Response): void {
  const path = req.path.replace(/^\/analytics/, '') || '/';
  const targetUrl = `${this.analyticsProxyUrl}${path}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
  
  // Proxy to analytics-engine
  this.proxyRequest(req, res, targetUrl);
}
```

Routes: `http://{deployment}-apigateway/analytics/*` → `analytics-engine` (Ray)

## State Reconciliation

### analytics-service Reconciliation

```typescript
// Periodic reconciliation (every 5 minutes)
async reconcileSessions() {
  const activeSessions = await this.getActiveSessions();
  
  for (const session of activeSessions) {
    if (!session.proxyEndpoint) continue;
    
    try {
      // Poll analytics-engine for current status
      const status = await this.httpClient.get(
        `${session.proxyEndpoint}/api/v1/internal/sessions/${session.id}/status`
      );
      
      // Update if status changed
      if (status.podStatus !== session.status) {
        await this.updateSession(session.id, {
          status: status.podStatus,
          gizmosqlEndpoint: status.gizmosqlEndpoint,
          errorMessage: status.errorMessage,
          podId: status.podId
        });
      }
    } catch (error) {
      // If proxy is unreachable, mark session as error
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        await this.updateSession(session.id, {
          status: 'error',
          errorMessage: `Analytics proxy unreachable: ${error.message}`
        });
      }
    }
  }
}
```

### analytics-engine Reconciliation

```go
// Verify pods match expected sessions
func (p *AnalyticsProxy) reconcilePods() {
    // Get all pods managed by analytics-engine
    pods, err := p.k8sClient.ListPods("gizmosql-*")
    if err != nil {
        log.Errorf("Failed to list pods: %v", err)
        return
    }
    
    // Get all known sessions
    knownSessions := p.getAllSessions()
    knownPodIDs := make(map[string]bool)
    for _, session := range knownSessions {
        knownPodIDs[session.PodID] = true
    }
    
    // Find orphaned pods (exist in K8s but not in our cache)
    for _, pod := range pods {
        if !knownPodIDs[pod.Name] {
            log.Warnf("Found orphaned pod: %s", pod.Name)
            // Optionally delete orphaned pods
            // p.k8sClient.DeletePod(pod.Name)
        }
    }
    
    // Update session statuses based on pod status
    for _, session := range knownSessions {
        podStatus := p.getPodStatus(session.PodID)
        if podStatus.Status != session.Status {
            session.Status = podStatus.Status
            session.ErrorMessage = podStatus.Error
            p.updateSession(session)
        }
    }
}
```

## Error Handling

### Pod Creation Failure

```go
// analytics-engine
func (p *AnalyticsProxy) createSession(req CreateSessionRequest) error {
    // Create deployment
    pod, err := p.createGizmoSQLPod(req)
    if err != nil {
        // Store error in session state
        p.sessions[req.SessionID] = &SessionState{
            SessionID:    req.SessionID,
            Status:       "error",
            ErrorMessage: fmt.Sprintf("Pod creation failed: %v", err),
        }
        return err
    }
    // ... success path
}
```

### Query Execution Failure

```go
// analytics-engine
func (p *AnalyticsProxy) executeQuery(sessionId string, sql string) (*QueryResult, error) {
    session, exists := p.sessions[sessionId]
    if !exists {
        return nil, ErrSessionNotFound
    }
    
    if session.Status != "ready" {
        return nil, fmt.Errorf("session not ready: %s", session.Status)
    }
    
    // Execute query via Flight SQL
    result, err := p.flightSQLClient.Execute(session.GizmoSQLEndpoint, sql)
    if err != nil {
        // Check if pod is still healthy
        podStatus := p.getPodStatus(session.PodID)
        if podStatus.Status != "ready" {
            // Update session status
            session.Status = podStatus.Status
            session.ErrorMessage = podStatus.Error
        }
        return nil, err
    }
    
    return result, nil
}
```

## Security Considerations

### Service-to-Service Authentication

**Option 1: Kubernetes Service Account Tokens**
```go
// analytics-engine calls analytics-service
token, err := ioutil.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
// Include in Authorization header
```

**Option 2: Shared Secret**
```go
// Environment variable
authToken := os.Getenv("ANALYTICS_SERVICE_AUTH_TOKEN")
```

**Option 3: mTLS** (Future)
- Mutual TLS between services
- Certificate-based authentication

### Network Policies

```yaml
# `nemo` namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: analytics-service-policy
spec:
  podSelector:
    matchLabels:
      app: analytics-service
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: nemo
    - podSelector:
        matchLabels:
          app: gateway
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          name: database
    - namespaceSelector:
        matchLabels:
          name: ray-*  # Allow calls to Ray deployments
```

## Implementation Phases

### Phase 1: Core Services (Week 1-2)
- [ ] Create analytics-service in the AgentStudio stack (`nemo` namespace) (session management)
- [ ] Create analytics-engine in Ray (pod orchestration)
- [ ] Implement deployment routing integration
- [ ] Implement status polling mechanism
- [ ] Update GizmoSQL deployment to use init container

### Phase 2: Gateway & Integration (Week 2-3)
- [ ] Update AgentStudio Gateway routing
- [ ] Update Ray API Gateway routing
- [ ] Update frontend to use queryUrl from session
- [ ] Implement state reconciliation
- [ ] Add error handling

### Phase 3: Production Hardening (Week 3-4)
- [ ] Add authentication/authorization
- [ ] Add health checks and monitoring
- [ ] Add metrics and logging
- [ ] Load testing
- [ ] Documentation

### Phase 4: Enhancements (Future)
- [ ] Implement push-based status updates (Pattern B)
- [ ] Add query result caching
- [ ] Add connection pooling
- [ ] Add distributed tracing

## Testing Strategy

### Unit Tests
- analytics-service: Session management, routing logic
- analytics-engine: Pod orchestration, Flight SQL client

### Integration Tests
- End-to-end session launch
- Status polling
- Query execution
- Error scenarios
- Pod failure handling

### Load Tests
- Multiple concurrent sessions
- Query performance
- Polling overhead
- Gateway throughput

## Migration Path

1. **Phase 1**: Deploy analytics-engine alongside existing service
2. **Phase 2**: Move pod orchestration to analytics-engine
3. **Phase 3**: Move session management to AgentStudio analytics-service
4. **Phase 4**: Update gateways and frontend
5. **Phase 5**: Deprecate old analytics-service in Ray

## Summary

### Key Design Decisions

1. ✅ **Deployment Routing**: Use existing `DeploymentService.getBucketRouting()`
2. ✅ **Status Updates**: analytics-service polls analytics-engine (no callbacks)
3. ✅ **Frontend URLs**: analytics-service returns full query URLs with session ID
4. ✅ **State Management**: analytics-service is source of truth, proxy reconciles
5. ✅ **Gateway Routing**: AgentStudio → analytics-service, Ray → analytics-engine
6. ✅ **LanceDB Processing**: Init container in GizmoSQL pod (no separate job)

### Architecture Benefits

- Clear separation of concerns
- Scalable and maintainable
- Language-optimized (Go for Flight SQL)
- Follows existing patterns (sysmanager-like status reporting)
- Resilient to failures (polling + reconciliation)

The design is **production-ready** and addresses all critical gaps with the updated approach.


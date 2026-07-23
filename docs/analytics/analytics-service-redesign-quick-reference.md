# Analytics Service Redesign - Quick Reference

## Design Decisions (Based on Feedback)

### 1. Deployment Routing ✅
- **Solution**: Use `DeploymentService.getBucketRouting()` to determine Ray deployment
- **Implementation**: analytics-service queries routing service based on dataset's bucket
- **Storage**: Store `deploymentId` and `proxyEndpoint` in session metadata

### 2. Status Updates ✅ (NO CALLBACKS)
- **Pattern**: analytics-service **polls** analytics-engine (analytics-engine never callbacks)
- **Poll Interval**: 5 seconds for active sessions
- **Future Enhancement**: Push-based batch updates (like sysmanager pattern)
- **Implementation**: 
  ```typescript
  // analytics-service polls
  GET /api/v1/internal/sessions/:sessionId/status
  ```

### 3. Frontend URLs ✅
- **Format**: analytics-service returns **full URLs with session ID**
- **Example**: 
  ```json
  {
    "queryUrl": "http://ray-us-east-1-apigateway/analytics/api/v1/sessions/{sessionId}/query",
    "schemaUrl": "http://ray-us-east-1-apigateway/analytics/api/v1/sessions/{sessionId}/schema/dataset"
  }
  ```
- **Usage**: Frontend uses these URLs directly - no URL construction needed

### 4. State Management ✅
- **Source of Truth**: analytics-service (database)
- **Agent**: analytics-engine (reconciles pod status from K8s)
- **User Actions**: 
  - User deletes → analytics-service marks "stopping" → calls proxy → proxy deletes pod → service updates "stopped"
- **Pod Failures**: 
  - Pod crashes → proxy detects → next poll returns error → service updates DB

### 5. Gateway Routing ✅
- **AgentStudio Gateway**: `/analytics` → analytics-service (`nemo` namespace)
- **Ray API Gateway**: `/analytics` → analytics-engine (Ray namespace)

### 6. LanceDB Processing ✅
- **No Separate Job**: LanceDB job is deprecated
- **Init Container**: LanceDB processor runs as init container in GizmoSQL pod
- **Flow**: Init container processes → writes to `/data` → GizmoSQL reads from `/data`

## Service Responsibilities

### analytics-service (AgentStudio, TypeScript)
- ✅ Session CRUD (database)
- ✅ Deployment routing
- ✅ Status polling
- ✅ Returns full query URLs
- ❌ No K8s API access
- ❌ No pod orchestration
- ❌ No Flight SQL client

### analytics-engine (Ray, Go)
- ✅ Pod orchestration (GizmoSQL with init container)
- ✅ Flight SQL client
- ✅ Query execution
- ✅ Status reporting (polling endpoint)
- ❌ No database access
- ❌ No callbacks to analytics-service

## API Endpoints

### analytics-service (AgentStudio)
```
POST   /api/v1/namespaces/:ns/datasets/:ds/analytics/launch
GET    /api/v1/namespaces/:ns/analytics/:sessionId
DELETE /api/v1/namespaces/:ns/analytics/:sessionId
```

### analytics-engine (Ray) - Internal
```
POST   /api/v1/internal/sessions          # Initialize session
GET    /api/v1/internal/sessions/:id/status  # Status polling
DELETE /api/v1/internal/sessions/:id      # Cleanup
```

### analytics-engine (Ray) - Public
```
POST   /api/v1/sessions/:id/query        # Execute query
GET    /api/v1/sessions/:id/schema/:table  # Get schema
```

## Data Flow

### Session Launch
1. Frontend → AgentStudio Gateway → analytics-service
2. analytics-service → Gets routing → Calls analytics-engine
3. analytics-engine → Creates GizmoSQL pod (with init container)
4. analytics-service → Starts polling for status
5. analytics-service → Returns session with full URLs to frontend

### Query Execution
1. Frontend → Ray API Gateway → analytics-engine (using queryUrl from session)
2. analytics-engine → Executes via Flight SQL → Returns results

### Status Updates
1. analytics-service → Polls analytics-engine every 5 seconds
2. analytics-engine → Returns current pod status
3. analytics-service → Updates DB if status changed

## Key Files to Create/Update

### New Services
- `src/nemo/analytics-engine/` - Session management (TypeScript)
- `src/ray/analytics-engine/` - Pod orchestration + Flight SQL (Go)

### Gateway Updates
- `src/nemo/apigateway-service/main.go` - Route to analytics-service
- `src/ray/apigateway/src/server/Server.ts` - Route to analytics-engine

### Frontend Updates
- Use `queryUrl` and `schemaUrl` from session response directly

## Implementation Checklist

- [ ] Create analytics-service in AgentStudio
- [ ] Create analytics-engine in Ray
- [ ] Implement deployment routing
- [ ] Implement status polling
- [ ] Update GizmoSQL deployment (init container)
- [ ] Update gateways
- [ ] Update frontend to use queryUrl
- [ ] Add authentication
- [ ] Add monitoring


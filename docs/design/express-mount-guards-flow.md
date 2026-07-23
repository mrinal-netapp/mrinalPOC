# Express Mount and Guards Interactions Flow

Complete visual diagrams showing how Express.js routers are mounted and how the unified guard middleware processes requests.

---

## Diagram 1: Express App Bootstrap & Mount Structure

```mermaid
flowchart TD
    Start([Express App Start]) --> Init[Initialize Express app]
    Init --> Log[app.use requestLoggingMiddleware]
    Log --> JSON[app.use express.json]
    
    JSON --> Health{"/health, /ready<br/>BEFORE auth"}
    Health --> Setup["/api/v1/setup<br/>BEFORE auth<br/>(public)"]
    
    Setup --> Auth["🔒 app.use authMiddleware<br/>(createAuthMiddleware)"]
    Auth --> ProjRole[app.use projectRoleMiddleware<br/>enriches X-Project-Role]
    
    ProjRole --> Swagger["/swagger, /docs<br/>(Swagger UI)"]
    
    Swagger --> Routes["Router Mounting Phase"]
    
    Routes --> R1["/api/v1/projects"]
    Routes --> R2["/api/v1/projects/:projectId/..."]
    Routes --> R3["/api/v1/internal/..."]
    Routes --> R4["/api/v1/platform/..."]
    
    R1 --> Routers["Individual Routers<br/>(projectRoutes, dataSetRoutes, etc.)"]
    R2 --> Routers
    R3 --> Routers
    R4 --> Routers
    
    Routers --> ErrH["Error Handlers"]
    ErrH --> NotFound[notFoundHandler]
    NotFound --> ErrMW[errorHandlerMiddleware]
    
    ErrMW --> Listen[app.listen PORT]
    
    style Auth fill:#f96,stroke:#333,stroke-width:3px
    style Health fill:#9f9,stroke:#333
    style Setup fill:#9f9,stroke:#333
    style Routers fill:#bbf,stroke:#333
```

---

## Diagram 2: Router-Level Guard Application

```mermaid
flowchart TD
    subgraph "Individual Router (e.g., projectRoutes.ts)"
        RouterInit[const router = express.Router]
        
        RouterInit --> RouteMap["Route Definitions"]
        
        RouteMap --> R1["router.get<br/>'/api/v1/projects'<br/>guard POL.ctx"]
        RouteMap --> R2["router.post<br/>'/api/v1/projects'<br/>guard POL.ctx"]
        RouteMap --> R3["router.get<br/>'/api/v1/projects/:id/datasets'<br/>guard POL.viewerOrService"]
        RouteMap --> R4["router.post<br/>'/api/v1/projects/:id/datasets'<br/>guard POL.memberUser"]
        
        R1 --> GuardMW1["🛡️ guard middleware<br/>(POL.ctx)"]
        R2 --> GuardMW2["🛡️ guard middleware<br/>(POL.ctx)"]
        R3 --> GuardMW3["🛡️ guard middleware<br/>(POL.viewerOrService)"]
        R4 --> GuardMW4["🛡️ guard middleware<br/>(POL.memberUser)"]
        
        GuardMW1 --> Handler1[Handler: listProjects]
        GuardMW2 --> Handler2[Handler: createProject]
        GuardMW3 --> Handler3[Handler: getDatasets]
        GuardMW4 --> Handler4[Handler: createDataset]
    end
    
    RouterInit -.-> Export[export default router]
    Export -.-> Mount["Mounted in index.ts:<br/>app.use('/api/v1/projects', projectRoutes)"]
    
    style GuardMW1 fill:#f96,stroke:#333,stroke-width:2px
    style GuardMW2 fill:#f96,stroke:#333,stroke-width:2px
    style GuardMW3 fill:#f96,stroke:#333,stroke-width:2px
    style GuardMW4 fill:#f96,stroke:#333,stroke-width:2px
```

---

## Diagram 3: Unified Guard Decision Flow (Complete)

```mermaid
flowchart TD
    Req([Incoming Request]) --> Guard["🛡️ Unified Guard Middleware<br/>(per-route policy)"]
    
    Guard --> Lookup["Lookup Route Policy<br/>method + path → policy"]
    
    Lookup --> NotFound{Policy<br/>exists?}
    NotFound -->|No| Warn["⚠️ LOG WARNING<br/>unmapped route"]
    Warn --> DefaultPolicy["Default: user-required"]
    NotFound -->|Yes| HasPolicy[Has Policy]
    
    DefaultPolicy --> CheckPublic
    HasPolicy --> CheckPublic
    
    CheckPublic{policy.public?}
    CheckPublic -->|Yes| Allow1["✅ ALLOW<br/>(public lane)"]
    
    CheckPublic -->|No| DecodeJWT["Decode JWT from<br/>Authorization: Bearer"]
    
    DecodeJWT --> ParseClaims["base64url decode<br/>payload segment"]
    ParseClaims --> CheckUser{Has sub<br/>+ email?}
    
    CheckUser -->|Yes - User Token| UserLane["👤 USER LANE"]
    CheckUser -->|No| CheckService["Check X-Service-Caller<br/>header from mesh"]
    
    UserLane --> UserAllowed{policy.user?}
    UserAllowed -->|No| Reject1["❌ 403 Forbidden<br/>user_not_allowed"]
    UserAllowed -->|Yes| SetIdentity["Set req.user + headers:<br/>X-User-ID, X-User-Email,<br/>X-User-Name, X-Project-ID"]
    SetIdentity --> Allow2["✅ ALLOW<br/>(user lane)"]
    
    CheckService --> HasSPIFFE{X-Service-Caller<br/>present +<br/>spiffe://?}
    
    HasSPIFFE -->|Yes - Trusted Peer| ServiceLane["🔧 SERVICE LANE"]
    HasSPIFFE -->|No| Reject2["❌ 401 Unauthorized<br/>token_missing_or_invalid"]
    
    ServiceLane --> ServiceAllowed{policy.internalAllowed?}
    ServiceAllowed -->|No| AuditDeny["Audit: svc_lane_access<br/>decision=deny"]
    AuditDeny --> Reject3["❌ 403 Forbidden<br/>service_not_allowed"]
    
    ServiceAllowed -->|Yes| AuditAllow["Audit: svc_lane_access<br/>decision=allow"]
    AuditAllow --> Allow3["✅ ALLOW<br/>(service lane)"]
    
    Allow1 --> Handler[Route Handler]
    Allow2 --> Handler
    Allow3 --> Handler
    
    style Guard fill:#f96,stroke:#333,stroke-width:3px
    style Allow1 fill:#9f9,stroke:#333
    style Allow2 fill:#9f9,stroke:#333
    style Allow3 fill:#9f9,stroke:#333
    style Reject1 fill:#f99,stroke:#333
    style Reject2 fill:#f99,stroke:#333
    style Reject3 fill:#f99,stroke:#333
```

---

## Diagram 4: Policy Types & Route Examples

```mermaid
flowchart LR
    subgraph "Policy Types (POL object)"
        direction TB
        
        Public["public:<br/>{ public: true }<br/>/health, /ready"]
        
        Ctx["ctx:<br/>{ user: { kind: 'context' } }<br/>Any authenticated user"]
        
        CtxOrService["ctxOrService:<br/>{ user: { kind: 'context' },<br/>internalAllowed: true }<br/>User OR service"]
        
        Viewer["viewer:<br/>{ user: { kind: 'project',<br/>scope: 'viewer' } }<br/>Project viewer only"]
        
        ViewerOrService["viewerOrService:<br/>{ user: { kind: 'project',<br/>scope: 'viewer' },<br/>internalAllowed: true }<br/>Viewer OR service"]
        
        Member["member:<br/>{ user: { kind: 'project',<br/>scope: 'member' } }<br/>Project member only"]
        
        MemberOrService["memberOrService:<br/>{ user: { kind: 'project',<br/>scope: 'member' },<br/>internalAllowed: true }<br/>Member OR service"]
        
        Admin["admin:<br/>{ user: { kind: 'project',<br/>scope: 'admin' } }<br/>Project admin only"]
        
        AdminOrService["adminOrService:<br/>{ user: { kind: 'project',<br/>scope: 'admin' },<br/>internalAllowed: true }<br/>Admin OR service"]
        
        ServiceOnly["serviceOnly:<br/>{ internalAllowed: true }<br/>Service ONLY (no user)"]
        
        Platform["platform:<br/>{ user: { kind: 'roles',<br/>roles: ['platform-member'] } }<br/>Platform role required"]
    end
    
    subgraph "Example Routes"
        direction TB
        
        Route1["GET /health<br/>→ POL.public"]
        Route2["GET /api/v1/projects<br/>→ POL.ctx"]
        Route3["GET /api/v1/projects/:id/datasets<br/>→ POL.viewerOrService"]
        Route4["POST /api/v1/projects/:id/datasets<br/>→ POL.memberUser"]
        Route5["DELETE /api/v1/projects/:id<br/>→ POL.adminUser"]
        Route6["POST /api/v1/internal/workspaces<br/>→ POL.serviceOnly"]
        Route7["GET /api/v1/platform/mcp-servers<br/>→ POL.platform"]
    end
    
    Public -.-> Route1
    Ctx -.-> Route2
    ViewerOrService -.-> Route3
    Member -.-> Route4
    Admin -.-> Route5
    ServiceOnly -.-> Route6
    Platform -.-> Route7
    
    style Public fill:#9f9,stroke:#333
    style ServiceOnly fill:#bbf,stroke:#333
    style CtxOrService fill:#ff9,stroke:#333
    style ViewerOrService fill:#ff9,stroke:#333
    style MemberOrService fill:#ff9,stroke:#333
    style AdminOrService fill:#ff9,stroke:#333
```

---

## Diagram 5: Complete Request Flow (North-South vs East-West)

```mermaid
sequenceDiagram
    participant Browser
    participant Gateway as Edge Gateway<br/>(Istio)
    participant Sidecar as Service Sidecar<br/>(Envoy)
    participant Guard as Unified Guard<br/>Middleware
    participant Handler as Route Handler
    
    rect rgb(200, 255, 200)
        note right of Browser: NORTH-SOUTH (User Traffic)
        Browser->>Gateway: HTTPS + JWT<br/>Authorization: Bearer eyJ...
        Gateway->>Gateway: Istio RequestAuthentication<br/>validates JWT signature
        Gateway->>Sidecar: Forward with JWT
        Sidecar->>Sidecar: mTLS validation<br/>(user lane doesn't check)
        Sidecar->>Guard: req + JWT
        Guard->>Guard: Decode JWT payload<br/>(no signature check)
        Guard->>Guard: Check sub + email present
        Guard->>Guard: Verify policy.user = true
        Guard->>Guard: Set req.user + headers:<br/>X-User-ID, X-User-Email
        Guard->>Handler: ✅ ALLOW (user lane)
        Handler->>Handler: Access req.user
        Handler-->>Browser: 200 OK
    end
    
    rect rgb(200, 220, 255)
        note right of Browser: EAST-WEST (Service Traffic)
        participant Caller as Caller Service<br/>(workflow-engine)
        Caller->>Sidecar: HTTP (no JWT)<br/>mTLS cert
        Sidecar->>Sidecar: Istio AuthorizationPolicy<br/>checks SPIFFE allow-list
        Sidecar->>Sidecar: EnvoyFilter strips<br/>X-Service-Caller (if present)
        Sidecar->>Sidecar: EnvoyFilter injects<br/>X-Service-Caller: spiffe://...
        Sidecar->>Guard: req + X-Service-Caller
        Guard->>Guard: No JWT present
        Guard->>Guard: Read X-Service-Caller header
        Guard->>Guard: Verify spiffe:// shape
        Guard->>Guard: Verify policy.internalAllowed = true
        Guard->>Guard: Audit: svc_lane_access
        Guard->>Handler: ✅ ALLOW (service lane)
        Handler-->>Caller: 200 OK
    end
```

---

## Diagram 6: Middleware Stack Execution Order

```mermaid
flowchart LR
    Req([HTTP Request]) --> MW1["1. requestLoggingMiddleware"]
    
    MW1 --> MW2["2. express.json"]
    
    MW2 --> Skip1{Public route?}
    Skip1 -->|Yes /health| Handler1[Public Handler]
    
    Skip1 -->|No| MW3["3. authMiddleware"]
    
    MW3 --> MW4["4. projectRoleMiddleware"]
    
    MW4 --> Router["5. Express Router Match"]
    
    Router --> MW5["6. Guard Middleware"]
    
    MW5 --> Check{Allowed?}
    
    Check -->|No| Reject["401/403 Error"]
    
    Check -->|Yes| Handler2[Route Handler]
    
    Handler2 --> Success[Response]
    
    Handler1 --> Success
    
    Success --> ErrMW["7. errorHandlerMiddleware"]
    Reject --> ErrMW
    
    style MW3 fill:#f96,stroke:#333,stroke-width:2px
    style MW5 fill:#f96,stroke:#333,stroke-width:3px
    style Reject fill:#f99,stroke:#333
    style Success fill:#9f9,stroke:#333
```

---

## Diagram 7: Guard Policy Evaluation Logic (Code Structure)

```mermaid
flowchart TD
    subgraph "Guard Function Structure"
        direction TB
        
        Entry["guard(policy: RoutePolicy)"]
        Entry --> ReturnMW["return (req, res, next) => { ... }"]
        
        ReturnMW --> Step1["1. Check policy.public<br/>→ next() immediately"]
        
        Step1 --> Step2["2. Decode JWT<br/>base64url decode payload"]
        
        Step2 --> Step3["3. Check user lane<br/>if (sub && email)"]
        
        Step3 --> UserCheck{"policy.user<br/>allows?"}
        UserCheck -->|Yes| UserAllow["Set req.user + headers<br/>next()"]
        UserCheck -->|No| UserReject["403 user_not_allowed"]
        
        Step3 --> Step4["4. Check service lane<br/>X-Service-Caller header"]
        
        Step4 --> ServiceCheck{"policy.internalAllowed<br/>allows?"}
        ServiceCheck -->|Yes| ServiceAllow["Audit log<br/>next()"]
        ServiceCheck -->|No| ServiceReject["403 service_not_allowed"]
        
        Step4 --> Step5["5. Neither user nor service<br/>401 token_missing_or_invalid"]
    end
    
    subgraph "Policy Table (GLOBAL_RULES)"
        direction TB
        
        Table["Ordered array of rules:<br/>[<br/>  { re: /pattern/, methods: [], policy },<br/>  ...<br/>]"]
        
        Table --> Match["Find first match:<br/>method + path → policy"]
        
        Match --> Found{Found?}
        Found -->|Yes| UsePolicy[Use matched policy]
        Found -->|No| Fallback["⚠️ LOG WARNING<br/>Default: user-required"]
    end
    
    Entry -.uses.-> Table
    
    style Entry fill:#f96,stroke:#333,stroke-width:2px
    style Table fill:#bbf,stroke:#333
```

---

## Diagram 8: Multi-Route Guard Example (Workflow)

```mermaid
flowchart TD
    Browser([Browser/CLI]) --> Req1["GET /api/v1/projects"]
    Browser --> Req2["GET /api/v1/projects/abc/datasets"]
    Browser --> Req3["POST /api/v1/projects/abc/datasets"]
    
    Service([workflow-engine]) --> Req4["POST /api/v1/internal/workspaces"]
    
    Req1 --> Guard1["🛡️ guard(POL.ctx)<br/>(any authenticated user)"]
    Req2 --> Guard2["🛡️ guard(POL.viewerOrService)<br/>(viewer OR service)"]
    Req3 --> Guard3["🛡️ guard(POL.memberUser)<br/>(member only, no service)"]
    Req4 --> Guard4["🛡️ guard(POL.serviceOnly)<br/>(service only, no user)"]
    
    Guard1 --> Eval1{JWT with<br/>sub+email?}
    Eval1 -->|Yes| Allow1["✅ User: listProjects"]
    Eval1 -->|No| Reject1["❌ 401"]
    
    Guard2 --> Eval2{JWT with<br/>viewer scope?}
    Eval2 -->|Yes| Allow2["✅ User: getDatasets"]
    Eval2 -->|No| Eval2b{X-Service-Caller?}
    Eval2b -->|Yes| Allow2b["✅ Service: getDatasets"]
    Eval2b -->|No| Reject2["❌ 401"]
    
    Guard3 --> Eval3{JWT with<br/>member scope?}
    Eval3 -->|Yes| Allow3["✅ User: createDataset"]
    Eval3 -->|No| Reject3["❌ 403"]
    
    Guard4 --> Eval4{X-Service-Caller?}
    Eval4 -->|Yes| Allow4["✅ Service: createWorkspace"]
    Eval4 -->|No| Reject4["❌ 401"]
    
    style Guard1 fill:#f96,stroke:#333,stroke-width:2px
    style Guard2 fill:#f96,stroke:#333,stroke-width:2px
    style Guard3 fill:#f96,stroke:#333,stroke-width:2px
    style Guard4 fill:#f96,stroke:#333,stroke-width:2px
    
    style Allow1 fill:#9f9,stroke:#333
    style Allow2 fill:#9f9,stroke:#333
    style Allow2b fill:#9f9,stroke:#333
    style Allow3 fill:#9f9,stroke:#333
    style Allow4 fill:#9f9,stroke:#333
```

---

## Summary

### Key Concepts:

1. **Express Mount Hierarchy:**
   - Global middleware (logging, JSON parsing)
   - Public routes (health, setup) BEFORE auth
   - authMiddleware (JWT decode + validation)
   - projectRoleMiddleware (enrich role)
   - Router mounting with per-route guards

2. **Guard Middleware:**
   - Applied per-route (not globally)
   - Takes RoutePolicy as parameter
   - Returns Express middleware function
   - Evaluates public → user → service → deny

3. **Three Lanes:**
   - **Public:** No credentials required (/health, /ready)
   - **User:** JWT with sub + email (north-south)
   - **Service:** X-Service-Caller SPIFFE (east-west)

4. **Decode-Only:**
   - Guard never verifies JWT signature
   - Istio sidecar already validated at gateway/hop
   - Guard only base64url decodes payload
   - Trusts mesh-injected X-Service-Caller

5. **Policy Types:**
   - User-only: `{ user: { ... } }`
   - Service-only: `{ internalAllowed: true }`
   - Dual-lane: `{ user: { ... }, internalAllowed: true }`
   - Public: `{ public: true }`

6. **Execution Order:**
   - requestLoggingMiddleware
   - express.json
   - authMiddleware (if not health/setup)
   - projectRoleMiddleware
   - **Router matching**
   - **Per-route guard middleware** ← THIS IS THE KEY
   - Route handler
   - errorHandlerMiddleware

The guard is **not a global middleware** — it's applied individually to each route with the appropriate policy! 🎯

---
---

# Part 2: Complete Request Flows After PR #274

This section shows end-to-end flows through the entire stack (Istio mesh + application guards) AFTER PR #274 mesh hardening is merged.

Complete flow diagrams showing how requests are processed AFTER PR #274 mesh hardening is merged and enabled.

**Key Changes in PR #274:**
- ❌ Drops `agentstudio-workers` namespace exemption
- ✅ Adds per-pair service allow-list (explicit caller→target principals)
- ✅ Injects `X-Service-Caller` header via EnvoyFilter (verified SPIFFE)
- ✅ User JWT lane unchanged (still works)
- ✅ Path exemptions unchanged (health, setup, metrics)

---

## Scenario 1: Browser → API (North-South, User Lane)

**Status:** ✅ **NO CHANGE** - User traffic unaffected by PR #274

```mermaid
sequenceDiagram
    participant Browser
    participant Gateway as Edge Gateway<br/>(Istio Ingress)
    participant GatewaySidecar as Gateway Sidecar<br/>(Envoy)
    participant APISidecar as API Sidecar<br/>(Envoy + EnvoyFilter)
    participant Guard as Unified Guard
    participant Handler as Route Handler
    
    Note over Browser: User has JWT from Keycloak
    Browser->>Gateway: HTTPS Request<br/>Authorization: Bearer eyJ...
    
    rect rgb(255, 230, 230)
        Note over Gateway,GatewaySidecar: EDGE: Istio RequestAuthentication
        Gateway->>GatewaySidecar: Validate JWT signature
        GatewaySidecar->>GatewaySidecar: Check JWKS (public key)
        GatewaySidecar->>GatewaySidecar: Verify issuer, audience, expiry
        GatewaySidecar->>GatewaySidecar: ✅ Signature valid
    end
    
    GatewaySidecar->>APISidecar: Forward with JWT<br/>Authorization: Bearer eyJ...
    
    rect rgb(230, 255, 230)
        Note over APISidecar: MESH: AuthorizationPolicy (JWT lane)
        APISidecar->>APISidecar: requireJwt: true (services namespace)
        APISidecar->>APISidecar: Check: requestPrincipals: ["*"]
        APISidecar->>APISidecar: JWT present? YES
        APISidecar->>APISidecar: ✅ ALLOW (user lane)
    end
    
    rect rgb(230, 230, 255)
        Note over APISidecar: PR #274: X-Service-Caller Injection
        APISidecar->>APISidecar: EnvoyFilter: Strip X-Service-Caller<br/>(if client sent it)
        APISidecar->>APISidecar: downstreamSslConnection() present<br/>(mTLS from gateway)
        APISidecar->>APISidecar: Extract URI SAN from mTLS cert
        APISidecar->>APISidecar: Inject X-Service-Caller:<br/>spiffe://.../agentstudio-gateway-istio
        Note over APISidecar: Request now has BOTH JWT + X-Service-Caller
    end
    
    APISidecar->>Guard: HTTP Request + JWT + X-Service-Caller
    
    rect rgb(255, 250, 230)
        Note over Guard: Application Guard
        Guard->>Guard: policy.public? NO
        Guard->>Guard: Decode JWT payload (base64url)
        Guard->>Guard: Has sub + email? YES
        Guard->>Guard: policy.user allowed? YES
        Guard->>Guard: USER LANE wins (JWT takes precedence)
        Guard->>Guard: Set req.user + headers:<br/>X-User-ID, X-User-Email
        Guard->>Guard: X-Service-Caller present but ignored
        Guard->>Guard: ✅ ALLOW (user lane)
    end
    
    Guard->>Handler: Authorized request
    Handler->>Handler: Process (access req.user)
    Handler-->>Browser: 200 OK + response
```

**IMPORTANT CLARIFICATION:**

Even on the **user lane** (browser traffic), the `X-Service-Caller` header **IS injected** because:
- Gateway → Service hop is **mTLS** (both are in the mesh)
- EnvoyFilter sees `downstreamSslConnection()` present
- Injects `X-Service-Caller: spiffe://.../agentstudio-gateway-istio`

**The request has BOTH headers:**
- `Authorization: Bearer <JWT>` - User identity (sub, email, roles)
- `X-Service-Caller: spiffe://.../agentstudio-gateway-istio` - Gateway identity

**Guard behavior:**
- Checks JWT first → Has sub + email → **User lane wins**
- Sets `req.user` from JWT
- **Ignores `X-Service-Caller`** (user lane takes precedence)
- Result: User authenticated, gateway identity logged but not used for authz

**Why this is correct:**
- `X-Service-Caller` shows which service made the hop (gateway forwarding user request)
- User identity (JWT) is what matters for authorization
- Service identity (X-Service-Caller) is useful for audit logs, observability

**Key Points:**
- ✅ User JWT lane **unchanged** by PR #274
- ✅ Matches `requestPrincipals: ["*"]` rule (JWT present)
- ✅ X-Service-Caller **IS injected** (gateway→service = mTLS hop)
- ✅ Application guard sees **BOTH** JWT + X-Service-Caller
- ✅ **User lane wins** - JWT takes precedence, X-Service-Caller ignored for authz
- 📊 X-Service-Caller useful for audit logs (which service forwarded the request)

---

## Scenario 2: Worker → API (East-West, Service Lane) - AFTER PR #274

**Status:** 🔄 **MAJOR CHANGE** - Namespace exemption removed, explicit allow-list required

### **2a. Allowed Worker (in allow-list) ✅**

```mermaid
sequenceDiagram
    participant Worker as workers-dataset<br/>(SA: workers-dataset)
    participant WorkerSidecar as Worker Sidecar<br/>(Envoy)
    participant APISidecar as API Sidecar<br/>(Envoy + EnvoyFilter)
    participant Guard as Unified Guard
    participant Handler as Route Handler
    
    Note over Worker: Service-to-service call<br/>NO JWT (token-less)
    Worker->>WorkerSidecar: HTTP Request<br/>(no Authorization header)
    
    WorkerSidecar->>APISidecar: mTLS connection<br/>Client cert: SPIFFE ID
    
    rect rgb(255, 200, 200)
        Note over APISidecar: MESH: AuthorizationPolicy (NEW per-pair allow-list)
        APISidecar->>APISidecar: NO namespace exemption<br/>(agentstudio-workers DROPPED)
        APISidecar->>APISidecar: Check allow-services-to-config-service
        APISidecar->>APISidecar: Caller SPIFFE:<br/>cluster.local/ns/agentstudio-workers/sa/workers-dataset
        APISidecar->>APISidecar: In principals list? YES ✅
        APISidecar->>APISidecar: ✅ ALLOW (explicit allow-list)
    end
    
    rect rgb(200, 230, 255)
        Note over APISidecar: PR #274: X-Service-Caller Injection
        APISidecar->>APISidecar: EnvoyFilter: Strip X-Service-Caller<br/>(remove any client value)
        APISidecar->>APISidecar: downstreamSslConnection() present
        APISidecar->>APISidecar: Extract URI SAN from mTLS cert
        APISidecar->>APISidecar: Inject X-Service-Caller:<br/>spiffe://cluster.local/ns/agentstudio-workers/sa/workers-dataset
    end
    
    APISidecar->>Guard: HTTP Request<br/>X-Service-Caller: spiffe://...
    
    rect rgb(255, 250, 230)
        Note over Guard: Application Guard
        Guard->>Guard: policy.public? NO
        Guard->>Guard: Decode JWT? NONE (no Authorization header)
        Guard->>Guard: Has sub + email? NO
        Guard->>Guard: Check X-Service-Caller header
        Guard->>Guard: Has spiffe://? YES
        Guard->>Guard: policy.internalAllowed? YES<br/>(e.g., POL.viewerOrService)
        Guard->>Guard: Audit: svc_lane_access decision=allow
        Guard->>Guard: ✅ ALLOW (service lane)
    end
    
    Guard->>Handler: Authorized request (service caller)
    Handler->>Handler: Process (no req.user, service call)
    Handler-->>Worker: 200 OK + response
```

**Key Changes:**
- ❌ **NO namespace exemption** (workers namespace exemption DROPPED)
- ✅ **Explicit allow-list check** (worker SA must be in principals list)
- ✅ **X-Service-Caller injected** (verified SPIFFE from mTLS cert)
- ✅ **Application guard** reads X-Service-Caller, allows if `internalAllowed: true`

---

### **2b. Non-Allowed Worker (NOT in allow-list) ❌**

```mermaid
sequenceDiagram
    participant Worker as storage-manager<br/>(SA: storage-manager)
    participant WorkerSidecar as Worker Sidecar<br/>(Envoy)
    participant APISidecar as workflow-engine Sidecar<br/>(Envoy)
    
    Note over Worker: Attempting service call<br/>NO JWT (token-less)
    Worker->>WorkerSidecar: HTTP Request
    
    WorkerSidecar->>APISidecar: mTLS connection<br/>Client cert: SPIFFE ID
    
    rect rgb(255, 200, 200)
        Note over APISidecar: MESH: AuthorizationPolicy (DENY)
        APISidecar->>APISidecar: NO namespace exemption<br/>(agentstudio-workers DROPPED)
        APISidecar->>APISidecar: Check allow-services-to-workflow-engine
        APISidecar->>APISidecar: Caller SPIFFE:<br/>cluster.local/ns/agentstudio-workers/sa/storage-manager
        APISidecar->>APISidecar: In principals list? NO ❌
        APISidecar->>APISidecar: ❌ DENY (403 RBAC)
    end
    
    APISidecar-->>Worker: 403 Forbidden<br/>RBAC: access denied
    
    Note over Worker: Request BLOCKED at mesh layer<br/>Never reaches application
```

**Key Changes:**
- ❌ **Caller NOT in allow-list** → 403 RBAC at mesh layer
- ❌ **Request never reaches application** (blocked by Istio)
- ✅ **Zero-trust enforcement** (only known flows allowed)

---

## Scenario 3: Health Probe → API (Path Exemption)

**Status:** ✅ **NO CHANGE** - Path exemptions still work

```mermaid
sequenceDiagram
    participant Kubelet as Kubelet<br/>(Node Agent)
    participant APISidecar as API Sidecar<br/>(Envoy)
    participant App as Application
    
    Note over Kubelet: Liveness/readiness probe<br/>NO JWT, NO mTLS
    Kubelet->>APISidecar: HTTP GET /health
    
    rect rgb(230, 255, 230)
        Note over APISidecar: MESH: AuthorizationPolicy (Path Exemption)
        APISidecar->>APISidecar: requireJwt: true (services namespace)
        APISidecar->>APISidecar: Check exemptions.paths
        APISidecar->>APISidecar: Path = /health? YES
        APISidecar->>APISidecar: ✅ ALLOW (path exemption)
    end
    
    APISidecar->>App: HTTP GET /health<br/>(no JWT, no X-Service-Caller)
    
    rect rgb(255, 250, 230)
        Note over App: Application (NO guard check)
        App->>App: Health endpoint mounted<br/>BEFORE authMiddleware
        App->>App: Return 200 OK
    end
    
    App-->>Kubelet: 200 OK {"status":"healthy"}
```

**Key Points:**
- ✅ Path exemption **unchanged** by PR #274
- ✅ `/health` always accessible (no JWT, no mTLS needed)
- ✅ Application handles health check before auth middleware

---

## Scenario 4: Edge Gateway → Service (Internal Hop)

**Status:** ✅ **WORKS** - Edge namespace still exempted

```mermaid
sequenceDiagram
    participant Gateway as Edge Gateway<br/>(Istio Ingress)
    participant GatewaySidecar as Gateway Sidecar<br/>(Envoy)
    participant APISidecar as API Sidecar<br/>(Envoy)
    participant App as Application
    
    Note over Gateway: Gateway forwards browser request<br/>JWT already validated at edge
    Gateway->>GatewaySidecar: Forward request + JWT
    
    GatewaySidecar->>APISidecar: mTLS connection<br/>SPIFFE: cluster.local/ns/agentstudio-edge/sa/agentstudio-gateway-istio
    
    rect rgb(230, 255, 230)
        Note over APISidecar: MESH: AuthorizationPolicy
        APISidecar->>APISidecar: Check exemptions.namespaces
        APISidecar->>APISidecar: Source namespace = agentstudio-edge? YES
        APISidecar->>APISidecar: ✅ ALLOW (namespace exemption)
        Note over APISidecar: Edge exemption NOT dropped<br/>(only workers exemption dropped)
    end
    
    APISidecar->>App: HTTP Request + JWT
    App->>App: Guard validates JWT<br/>(user lane)
    App-->>Gateway: 200 OK + response
```

**Key Points:**
- ✅ `agentstudio-edge` namespace exemption **still exists**
- ✅ Gateway can forward requests without JWT on the gateway pod itself
- ✅ User JWT forwarded from browser, validated by application

---

## Comparison Table: Before vs After PR #274

| Scenario | Traffic Type | Before PR #274 | After PR #274 | Change |
|----------|--------------|----------------|---------------|--------|
| **Browser → API** | North-South (User) | ✅ JWT required | ✅ JWT required | ✅ No change |
| **Worker → API (in allow-list)** | East-West (Service) | ✅ Namespace exemption | ✅ Explicit allow-list | 🔄 Tightened (zero-trust) |
| **Worker → API (NOT in allow-list)** | East-West (Service) | ✅ Namespace exemption (ALL workers allowed) | ❌ 403 RBAC (DENIED) | 🔄 Major change (security hardening) |
| **Health Probe → API** | Infrastructure | ✅ Path exemption | ✅ Path exemption | ✅ No change |
| **Edge Gateway → API** | North-South (Proxy) | ✅ Namespace exemption | ✅ Namespace exemption | ✅ No change |
| **Monitoring → API** | Infrastructure | ✅ Namespace exemption | ✅ Namespace exemption | ✅ No change |

---

## Authorization Policy Flow: Before vs After

### **Before PR #274 (Permissive)**

```mermaid
flowchart TD
    Request([Incoming Request]) --> Check1{Has JWT?}
    
    Check1 -->|Yes| UserLane["✅ ALLOW<br/>(user lane)"]
    
    Check1 -->|No| Check2{Source namespace<br/>exempted?}
    
    Check2 -->|Yes<br/>agentstudio-workers| WorkerExempt["✅ ALLOW<br/>(namespace exemption)"]
    Check2 -->|Yes<br/>agentstudio-edge| EdgeExempt["✅ ALLOW<br/>(namespace exemption)"]
    Check2 -->|Yes<br/>monitoring| MonitorExempt["✅ ALLOW<br/>(namespace exemption)"]
    
    Check2 -->|No| Check3{Path exempted?}
    
    Check3 -->|Yes<br/>/health, /ready| PathExempt["✅ ALLOW<br/>(path exemption)"]
    
    Check3 -->|No| Deny["❌ DENY<br/>(no JWT, no exemption)"]
    
    style WorkerExempt fill:#ff9,stroke:#333
    style UserLane fill:#9f9,stroke:#333
    style PathExempt fill:#9f9,stroke:#333
    style Deny fill:#f99,stroke:#333
```

**Problem:** ANY worker pod can call ANY service (blanket trust)

---

### **After PR #274 (Zero-Trust)**

```mermaid
flowchart TD
    Request([Incoming Request]) --> Check1{Has JWT?}
    
    Check1 -->|Yes| UserLane["✅ ALLOW<br/>(user lane)"]
    
    Check1 -->|No| Check2{Source namespace<br/>exempted?}
    
    Check2 -->|Yes<br/>agentstudio-edge| EdgeExempt["✅ ALLOW<br/>(edge gateway)"]
    Check2 -->|Yes<br/>monitoring| MonitorExempt["✅ ALLOW<br/>(monitoring)"]
    Check2 -->|No<br/>agentstudio-workers| Check4["Check allow-list<br/>(namespace exemption DROPPED)"]
    
    Check2 -->|No| Check3{Path exempted?}
    
    Check3 -->|Yes<br/>/health, /ready| PathExempt["✅ ALLOW<br/>(path exemption)"]
    
    Check3 -->|No| Check5["Check allow-list"]
    
    Check4 --> AllowList{Caller SPIFFE<br/>in principals?}
    Check5 --> AllowList
    
    AllowList -->|Yes| ServiceAllow["✅ ALLOW<br/>(explicit allow-list)"]
    AllowList -->|No| Deny["❌ DENY 403 RBAC<br/>(not in allow-list)"]
    
    style UserLane fill:#9f9,stroke:#333
    style ServiceAllow fill:#9f9,stroke:#333
    style PathExempt fill:#9f9,stroke:#333
    style Deny fill:#f99,stroke:#333
    style Check4 fill:#ff9,stroke:#333
```

**Security:** Only explicitly allow-listed caller→target pairs succeed

---

## X-Service-Caller Injection Flow (PR #274)

```mermaid
flowchart LR
    Request([Service Request]) --> Filter[EnvoyFilter SIDECAR_INBOUND]
    
    Filter --> Strip[1. Strip X-Service-Caller]
    
    Strip --> CheckSSL{mTLS?}
    
    CheckSSL -->|No| NoInject[No injection]
    
    CheckSSL -->|Yes| Extract[2. Extract URI SAN]
    
    Extract --> Verify[3. Verify SPIFFE shape]
    
    Verify --> Inject[4. Inject X-Service-Caller]
    
    Inject --> App[To Application]
    NoInject --> App
    
    App --> Guard[Application Guard]
    
    Guard --> Check{internalAllowed?}
    
    Check -->|Yes + header| Allow[✅ ALLOW]
    Check -->|No| Deny[❌ 403]
    
    style Strip fill:#f96,stroke:#333,stroke-width:2px
    style Inject fill:#9f9,stroke:#333
    style Allow fill:#9f9,stroke:#333
    style Deny fill:#f99,stroke:#333
```

---

## Summary: What PR #274 Changes

### **✅ User Traffic (North-South):**
- **NO CHANGE** - JWT validation unchanged
- Users still authenticate with Keycloak tokens
- Application guard still decodes JWT and checks permissions

### **🔄 Service Traffic (East-West):**
- **MAJOR CHANGE** - Workers namespace exemption DROPPED
- Workers must be explicitly allow-listed per target service
- X-Service-Caller header injected with verified SPIFFE
- Application guard reads X-Service-Caller for service lane

### **✅ Infrastructure Traffic:**
- **NO CHANGE** - Path exemptions still work
- Health probes, metrics, setup endpoints unchanged
- Edge gateway, monitoring namespace exemptions unchanged

### **🔒 Security Improvement:**
- **Before:** ANY worker → ANY service (blanket trust)
- **After:** ONLY allow-listed caller→target pairs (zero-trust)
- **Result:** Smaller attack surface, clear service dependency graph

---

## Rollout Checklist

**Before enabling `meshServiceAuthz.enabled: true`:**

1. ✅ Verify all production flows in allow-list
2. ✅ Test in dev with `--set meshServiceAuthz.enabled=true`
3. ✅ Monitor for 403 RBAC errors (missing allow-list entries)
4. ✅ Validate X-Service-Caller injection working (check logs)
5. ✅ Confirm unified guards deployed (config-service, workflow-engine)
6. ✅ Verify no unexpected service-to-service calls failing

**Safe rollout:**
- Merge with `enabled: false` (no behavioral change)
- Enable in dev/staging first
- Validate all flows work
- Enable in production with monitoring
- Rollback: flip `enabled: false` if issues found

---

**The flows show PR #274 achieves zero-trust mesh security while preserving all legitimate user and infrastructure traffic patterns.** 🎯

# PR #274: Mesh Service Authorization Hardening - Visual Diagrams

## 1. Before vs After: Security Posture

```mermaid
flowchart TB
    subgraph before["❌ BEFORE PR #274 - Blanket Trust"]
        A1[Any Service Pod]
        A2[workflow-engine]
        A3[config-service]
        A4[bifrost]
        A5[storage-manager]
        A6[Compromised Pod]
        
        A1 -.->|"delegatedAuth: ['*']<br/>ALLOWED"| A2
        A1 -.->|ALLOWED| A3
        A1 -.->|ALLOWED| A4
        A6 -.->|"🚨 ATTACK<br/>ALLOWED"| A2
        A5 -.->|"🚨 Unrestricted<br/>ALLOWED"| A2
    end
    
    subgraph after["✅ AFTER PR #274 - Zero Trust"]
        B1[workflow-engine]
        B2[config-service]
        B3[bifrost]
        B4[eval-worker]
        B5[storage-manager]
        B6[Compromised Pod]
        
        B1 -->|"✅ Allow-listed"| B2
        B2 -->|"✅ Allow-listed"| B1
        B4 -->|"✅ Allow-listed"| B3
        B5 -.->|"❌ 403 RBAC<br/>NOT in allow-list"| B1
        B6 -.->|"❌ 403 RBAC<br/>BLOCKED"| B1
    end
    
    style A6 fill:#f88,stroke:#f00,stroke-width:3px
    style B6 fill:#f88,stroke:#f00,stroke-width:3px
    style A2 fill:#faa,stroke:#f00
    style B1 fill:#afa,stroke:#0f0
```

---

## 2. X-Service-Caller Injection Flow

```mermaid
sequenceDiagram
    autonumber
    participant WE as workflow-engine Pod
    participant WE_Proxy as WE Sidecar (Envoy)
    participant CS_Proxy as CS Sidecar (Envoy)
    participant Filter as EnvoyFilter<br/>(PR #274)
    participant CS as config-service App
    
    Note over WE: Service-to-service call<br/>(no JWT, no SA token)
    
    WE->>WE_Proxy: POST /api/v1/projects/123/datasets/456/status
    Note over WE_Proxy: Client mTLS cert:<br/>spiffe://cluster.local/ns/services/sa/workflow-engine
    
    WE_Proxy->>CS_Proxy: mTLS handshake
    Note over CS_Proxy: Verifies mTLS cert<br/>Extracts SPIFFE identity
    
    CS_Proxy->>Filter: SIDECAR_INBOUND<br/>Priority: 10
    Note over Filter: 1. Strip client X-Service-Caller<br/>(if attacker injected it)
    Note over Filter: 2. Extract verified SPIFFE:<br/>spiffe://…/sa/workflow-engine
    
    Filter->>Filter: Inject header:<br/>X-Service-Caller: spiffe://…/sa/workflow-engine
    
    Filter->>CS: Forward request with<br/>X-Service-Caller header
    Note over CS: App guard trusts header<br/>(cryptographically verified)
    
    CS->>CS: Route to service lane<br/>(no scope check needed)
    CS-->>WE: 200 OK
```

---

## 3. Authorization Layers (Defense-in-Depth)

```mermaid
flowchart TD
    Start([Service-to-Service Request]) --> L1
    
    subgraph L1["Layer 1: Istio mTLS"]
        M1[Verify client mTLS certificate]
        M2{Valid SPIFFE?}
        M1 --> M2
        M2 -->|No| R1[❌ Connection Refused]
    end
    
    M2 -->|Yes| L2
    
    subgraph L2["Layer 2: AuthorizationPolicy<br/>(PR #274 Allow-List)"]
        A1{Caller→Target<br/>in allow-list?}
        A1 -->|No| R2[❌ 403 RBAC]
    end
    
    A1 -->|Yes| L3
    
    subgraph L3["Layer 3: EnvoyFilter<br/>(X-Service-Caller Injection)"]
        E1[Strip client X-Service-Caller]
        E2[Extract verified SPIFFE]
        E3[Inject X-Service-Caller header]
        E1 --> E2 --> E3
    end
    
    E3 --> L4
    
    subgraph L4["Layer 4: Application Guard<br/>(PR #268/#272)"]
        G1{X-Service-Caller<br/>present?}
        G1 -->|No| R3[❌ 401 token_missing]
        G1 -->|Yes| G2[Route to service lane]
        G2 --> G3{policy.internalAllowed?}
        G3 -->|No| R4[❌ 403 service_not_allowed]
    end
    
    G3 -->|Yes| L5
    
    subgraph L5["Layer 5: Handler Logic"]
        H1[Business rules]
        H2[Database operations]
        H1 --> H2
    end
    
    H2 --> Success([✅ 200 OK])
    
    style R1 fill:#f88,stroke:#f00,stroke-width:2px
    style R2 fill:#f88,stroke:#f00,stroke-width:2px
    style R3 fill:#f88,stroke:#f00,stroke-width:2px
    style R4 fill:#f88,stroke:#f00,stroke-width:2px
    style Success fill:#afa,stroke:#0f0,stroke-width:2px
```

---

## 4. Allow-List Matrix (Service Graph)

```mermaid
flowchart LR
    subgraph Services["Core Services"]
        CS[config-service]
        WE[workflow-engine]
        BF[bifrost]
        AG[agent-service-maf]
    end
    
    subgraph Workers["Worker Tier"]
        EW[eval-worker]
        CW[connector-worker]
        KW[kb-worker]
        DW[dataset-worker]
    end
    
    subgraph Retrieval["Retrieval Layer"]
        KB[kb-retrieval-service]
    end
    
    %% Config-service accepts from
    WE -->|✅ Allow-listed| CS
    AG -->|✅ Allow-listed| CS
    EW -->|✅ Allow-listed| CS
    CW -->|✅ Allow-listed| CS
    KW -->|✅ Allow-listed| CS
    KB -->|✅ Allow-listed| CS
    
    %% Workflow-engine accepts from
    CS -->|✅ Allow-listed| WE
    
    %% Bifrost accepts from
    EW -->|✅ Allow-listed| BF
    KW -->|✅ Allow-listed| BF
    KB -->|✅ Allow-listed| BF
    WE -->|✅ Allow-listed| BF
    
    %% Non-allow-listed (blocked)
    AG -.->|❌ 403 RBAC| WE
    DW -.->|❌ 403 RBAC| WE
    
    style CS fill:#e1f5ff,stroke:#0066cc
    style WE fill:#e1f5ff,stroke:#0066cc
    style BF fill:#e1f5ff,stroke:#0066cc
    style AG fill:#fff4e1,stroke:#ff9900
```

---

## 5. Attack Prevention: Header Spoofing

```mermaid
sequenceDiagram
    autonumber
    participant ATK as 🚨 Attacker Pod
    participant Proxy as Target Sidecar
    participant Filter as EnvoyFilter<br/>(Strip + Inject)
    participant App as Target App
    
    Note over ATK: Try to impersonate<br/>workflow-engine
    
    ATK->>Proxy: Request with injected header:<br/>X-Service-Caller: spiffe://…/sa/workflow-engine
    Note over ATK: Attacker's actual SPIFFE:<br/>spiffe://…/sa/attacker-pod
    
    Proxy->>Proxy: Verify mTLS cert
    Note over Proxy: Real SPIFFE:<br/>spiffe://…/sa/attacker-pod
    
    Proxy->>Filter: Pass request
    
    rect rgb(255, 200, 200)
        Note over Filter: 🛡️ STRIP malicious header
        Filter->>Filter: Remove client X-Service-Caller
    end
    
    rect rgb(200, 255, 200)
        Note over Filter: ✅ INJECT verified identity
        Filter->>Filter: X-Service-Caller:<br/>spiffe://…/sa/attacker-pod
    end
    
    Filter->>App: Forward with REAL identity
    
    App->>App: Check allow-list policy
    Note over App: attacker-pod NOT allowed
    
    App-->>ATK: ❌ 403 service_not_allowed
    
    Note over ATK: Attack FAILED<br/>Cannot forge identity
```

---

## 6. Attack Prevention: Lateral Movement

```mermaid
flowchart LR
    Start([🚨 storage-manager<br/>Compromised])
    
    subgraph Before["❌ Before PR #274"]
        direction TB
        B1[delegatedAuth: '*']
        B2[✅ ALLOWED]
        B3[🚨 Can trigger workflows]
        B4[🚨 Delete datasets]
        B5[🚨 Escalate privileges]
        B1 --> B2 --> B3 --> B4 --> B5
    end
    
    subgraph After["✅ After PR #274"]
        direction TB
        C1{Check allow-list}
        C2[storage-manager → WE<br/>NOT in matrix]
        C3[❌ 403 RBAC at mesh]
        C4[✅ Attack CONTAINED]
        C1 --> C2 --> C3 --> C4
    end
    
    Start --> Before
    Start --> After
    
    style Start fill:#f88,stroke:#f00,stroke-width:3px
    style B3 fill:#fcc,stroke:#f00
    style B4 fill:#fcc,stroke:#f00
    style B5 fill:#fcc,stroke:#f00
    style C4 fill:#cfc,stroke:#0f0,stroke-width:2px
```

---

## 7. Complete Service-to-Service Flow (PR #274 + #268)

```mermaid
sequenceDiagram
    autonumber
    participant WE as workflow-engine
    participant WE_Proxy as WE Sidecar
    participant Mesh as Istio Control Plane
    participant CS_Proxy as CS Sidecar
    participant Filter as EnvoyFilter
    participant Guard as unifiedGuard
    participant CS as config-service Handler
    
    Note over WE: Activity: gateway-setup<br/>needs to call CS
    
    WE->>WE_Proxy: POST /internal/projects/123/gateway-setup<br/>(no JWT, no SA token)
    
    WE_Proxy->>Mesh: mTLS handshake
    Note over Mesh: Verify SPIFFE:<br/>spiffe://…/sa/workflow-engine
    
    Mesh->>CS_Proxy: Check AuthorizationPolicy
    Note over CS_Proxy: workflow-engine → config-service<br/>✅ In allow-list
    
    CS_Proxy->>Filter: Apply SIDECAR_INBOUND
    Filter->>Filter: Strip client headers
    Filter->>Filter: Inject X-Service-Caller:<br/>spiffe://…/sa/workflow-engine
    
    Filter->>Guard: Forward request
    
    Guard->>Guard: Detect X-Service-Caller
    Guard->>Guard: Route to SERVICE LANE
    Guard->>Guard: Check policy.internalAllowed
    Note over Guard: No scope check on service lane
    
    Guard->>CS: Pass to handler
    Note over CS: Business logic:<br/>Create Bifrost gateway
    
    CS-->>WE: 201 Created
    
    rect rgb(200, 255, 200)
        Note over WE,CS: ✅ Zero credentials exchanged<br/>✅ mTLS only<br/>✅ Explicit allow-list<br/>✅ Verified identity
    end
```

---

## 8. Toggle States & Migration Path

```mermaid
stateDiagram-v2
    [*] --> LegacyMode: Initial State
    
    state LegacyMode {
        [*] --> BlanketTrust: delegatedAuth: ['*']
        BlanketTrust --> NoEnvoyFilter
        NoEnvoyFilter --> SATokenAuth: Services use SA tokens
    }
    
    LegacyMode --> TransitionSafe: Deploy PR #274<br/>meshServiceAuthz.enabled=false
    
    state TransitionSafe {
        [*] --> AllowListDefined: AuthorizationPolicy created
        AllowListDefined --> FilterInstalled: EnvoyFilter deployed
        FilterInstalled --> GuardsOff: UNIFIED_GUARD_SMOKE=false
        note right of GuardsOff: Safe merge state<br/>No behavior change
    }
    
    TransitionSafe --> HardenedMode: Enable in same release
    
    state HardenedMode {
        [*] --> MeshEnabled: meshServiceAuthz.enabled=true
        MeshEnabled --> GuardsOn: UNIFIED_GUARD_SMOKE=true
        GuardsOn --> ZeroTrust: Only allow-listed pairs
        note right of ZeroTrust: Production hardened<br/>Defense-in-depth
    }
    
    HardenedMode --> TransitionSafe: Rollback if needed
    TransitionSafe --> LegacyMode: Emergency rollback
    
    style LegacyMode fill:#fcc
    style TransitionSafe fill:#ffc
    style HardenedMode fill:#cfc
```

---

## 9. Security Properties Summary

| Property | Without PR #274 | With PR #274 |
|----------|-----------------|--------------|
| **Service Identity** | ⚠️ SA tokens (forgeable) | ✅ mTLS SPIFFE (crypto-verified) |
| **Access Control** | 🚨 Any→Any (blanket trust) | ✅ Explicit allow-list matrix |
| **Lateral Movement** | 🚨 Full platform access | ✅ Limited to allowed pairs |
| **Header Spoofing** | 🚨 Client can inject | ✅ Stripped + mesh-injected |
| **Compromised Pod Blast Radius** | 🚨 Unrestricted | ✅ Contained by allow-list |
| **Defense Layers** | ⚠️ Single (app guard) | ✅ Multi-layer (mesh + app) |
| **Namespace Trust** | 🚨 Blanket worker exemption | ✅ Per-SA granular rules |
| **Attack Surface** | 🚨 N×N (all pairs) | ✅ ~15 explicit pairs |

---

## 10. Key Takeaways

### Before PR #274 (Insecure)
```
┌─────────────────────────────────────────┐
│  ANY POD → ANY SERVICE                  │
│  ══════════════════════                 │
│  • Blanket trust                        │
│  • No lateral movement protection       │
│  • Header spoofing possible             │
│  • Compromised pod = full access        │
└─────────────────────────────────────────┘
```

### After PR #274 (Hardened)
```
┌─────────────────────────────────────────┐
│  EXPLICIT ALLOW-LIST ONLY               │
│  ═══════════════════════                │
│  • Zero-trust model                     │
│  • Per-pair authorization               │
│  • Crypto-verified identity             │
│  • Attack containment                   │
│  • Multi-layer defense                  │
└─────────────────────────────────────────┘
```

### The Core Innovation
```
🔒 PR #274 = "Trust No One by Default"

   Mesh validates WHO you are (mTLS SPIFFE)
      ↓
   AuthorizationPolicy validates WHAT you can call
      ↓
   EnvoyFilter injects verified identity
      ↓
   App Guard validates WHY you're calling
      ↓
   Handler executes business logic
```

---

**Created:** 2026-07-01  
**Purpose:** Visual explanation of PR #274 mesh security hardening  
**Related PRs:** #268 (config-service guard), #272 (workflow-engine guard), #274 (mesh)

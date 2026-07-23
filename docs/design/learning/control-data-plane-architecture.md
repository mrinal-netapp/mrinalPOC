# AgentStudio architecture — control plane vs data plane

A whole-platform architecture view organized around a **control plane / data
plane** split, with the service mesh drawn as an explicit layer:

- **Keycloak sits in the control plane** — it issues identity (OIDC tokens / RPT
  with per-project `permissions[]`) but is not in the hot request path.
- **The service mesh is the data plane** — an Envoy sidecar on every pod carries
  the actual north–south and east–west traffic and enforces STRICT mTLS. The
  mesh's *own* control plane (`istiod`) lives in the control plane and just
  configures those sidecars.

Companion docs: [single-guard-mesh-identity.md](../single-guard-mesh-identity.md),
[authn-authz-e2e-flow.md](../authn-authz-e2e-flow.md),
[keycloak-per-project-authorization.md](../keycloak-per-project-authorization.md),
[platform-hld.md](../platform-hld.md).

> Plane assignment is by **role**, not by namespace: "control plane" = decides /
> configures / orchestrates; "data plane" = serves traffic and moves/processes
> data. `config-service` and `workflow-engine` expose request-path APIs but are
> placed in the control plane because they are the platform's source of truth and
> orchestrator. Each box is annotated with its deployment namespace/tier.

## Legend

| Color | Meaning |
| --- | --- |
| Blue | Control plane (manage / configure / orchestrate) |
| Green | Data plane (serve traffic / move + process data) |
| Purple | Service mesh (istiod + Envoy sidecars) |
| Orange | Data stores |
| Grey | External actors / systems |

## 1. Full system — control plane vs data plane

All workloads are sidecar-injected (`ISTIO_APP_NAMESPACES`) and run STRICT mTLS.
`istiod` issues SPIFFE identities and pushes policy to the sidecar on every pod
(shown once, from `istiod` to the edge gateway, to keep the graph readable).

```mermaid
flowchart TB
    User["Users / Browser"]
    Ext["External LLM and embedding providers<br/>OpenAI · Anthropic · Cohere · Voyage"]
    Src["External data sources<br/>S3 · Postgres · MySQL · ONTAP · GCNV · Redash"]

    subgraph MESHCP["Service-mesh control plane (istio-system)"]
        direction TB
        Istiod["istiod<br/>SPIFFE identity · config push"]
        Policies["Mesh policies<br/>PeerAuthentication STRICT<br/>AuthorizationPolicy · RequestAuthentication<br/>EnvoyFilter (X-Service-Caller)"]
    end

    subgraph CTRL["AGENTSTUDIO CONTROL PLANE — manage · configure · orchestrate"]
        direction TB
        KC["Keycloak<br/>OIDC · RPT · per-project authz<br/>agentstudio-identity"]
        Config["config-service<br/>entity source of truth · unifiedGuard<br/>agentstudio-services"]
        WE["workflow-engine<br/>orchestrator API<br/>agentstudio-services"]
        Temporal["Temporal<br/>durable orchestration<br/>agentstudio-platform"]
        Lake["Lakekeeper<br/>Iceberg catalog<br/>agentstudio-platform"]
        SM["storage-manager<br/>PVC · StorageClass · mounts<br/>agentstudio-workers"]
        PG[("PostgreSQL<br/>metadata · workflow history<br/>database")]
        Obs["Observability<br/>Prometheus · Grafana · Phoenix<br/>monitoring"]
    end

    subgraph DATA["AGENTSTUDIO DATA PLANE — serve traffic · move and process data (Envoy sidecar on every pod)"]
        direction TB
        subgraph EDGE["North-south entry (agentstudio-edge / console)"]
            direction TB
            GW["Istio edge Gateway<br/>validate RPT · inject X-User-*"]
            AGW["apigateway-service<br/>routing / proxy"]
            GUI["gui / agent-studio-ui"]
        end
        subgraph AIRT["AI runtime (services / llm-gateway)"]
            direction TB
            Agent["agent-service (Agno)"]
            KBR["kb-retrieval-service"]
            Bifrost["Bifrost LLM gateway"]
            TEI["TEI (MiniLM)"]
            MCP["MCP tool servers"]
        end
        subgraph WRK["Activity workers (agentstudio-workers)"]
            direction TB
            CW["connector-worker"]
            DSP["dataset-processor"]
            KBP["kb-processor"]
            EW["eval-worker"]
        end
        subgraph ANWS["Analytics and workspaces"]
            direction TB
            AE["analytics-engine<br/>Arrow Flight SQL"]
            Jup["JupyterLab workspace pods"]
        end
        subgraph STG["Storage data path (agentstudio-workers)"]
            direction TB
            S3GW["S3 Gateway (VersityGW)"]
            NFS[("Shared NFS · LanceDB · Iceberg<br/>/mnt/pvcs/default-nemo")]
            ONTAP[("ONTAP volumes (read-only)")]
        end
    end

    User -->|"HTTPS + RPT"| GW
    GW --> AGW
    AGW --> GUI
    AGW --> Config
    AGW --> WE
    AGW --> Agent
    AGW --> AE

    Config --> PG
    Config --> Lake
    Config --> KC
    KC --> PG
    WE --> Temporal
    Temporal --> CW
    Temporal --> DSP
    Temporal --> KBP
    Temporal --> EW
    Temporal --> PG
    Lake --> PG
    Lake -->|"S3 API (catalog only)"| S3GW
    SM --> Config
    SM -->|"create PVC / StorageClass"| NFS

    CW -->|"acquire"| Src
    CW --> NFS
    CW -->|"read-only"| ONTAP
    CW --> Config
    DSP --> NFS
    DSP --> Lake
    KBP --> NFS
    KBP -->|"/v1/embeddings"| Bifrost

    Agent --> Bifrost
    Agent --> KBR
    Agent --> MCP
    Agent --> Config
    Agent -.->|"OTLP / Phoenix"| Obs
    KBR --> NFS
    KBR --> Bifrost
    Bifrost --> TEI
    Bifrost -->|"hosted models"| Ext

    AE --> NFS
    Jup --> NFS
    S3GW --> NFS

    Policies -.-> Istiod
    Istiod -.->|"SPIFFE id + policy to the sidecar on every pod"| GW

    classDef ctrl fill:#dbeafe,stroke:#1e40af,color:#0b1f44;
    classDef data fill:#dcfce7,stroke:#166534,color:#06301a;
    classDef mesh fill:#ede9fe,stroke:#6d28d9,color:#2e1065;
    classDef store fill:#fef3c7,stroke:#b45309,color:#451a03;
    classDef ext fill:#f1f5f9,stroke:#475569,color:#0f172a;

    class KC,Config,WE,Temporal,Lake,SM,Obs ctrl;
    class PG,NFS,ONTAP store;
    class GW,AGW,GUI,Agent,KBR,Bifrost,TEI,MCP,CW,DSP,KBP,EW,AE,Jup,S3GW data;
    class Istiod,Policies mesh;
    class User,Ext,Src ext;
```

### Control plane (blue)

| Component | Role | Namespace |
| --- | --- | --- |
| **Keycloak** | OIDC, RPT issuance, per-project authorization | `agentstudio-identity` |
| **config-service** | Entity source of truth; `unifiedGuard` two-lane authz | `agentstudio-services` |
| **workflow-engine** | Orchestrator API; starts Temporal workflows | `agentstudio-services` |
| **Temporal** | Durable workflow orchestration | `agentstudio-platform` |
| **Lakekeeper** | Apache Iceberg catalog | `agentstudio-platform` |
| **storage-manager** | PVC / StorageClass / volume-mount controller | `agentstudio-workers` |
| **PostgreSQL** | Metadata + workflow history | `database` |
| **Observability** | Prometheus, Grafana, Phoenix | `monitoring` |
| **istiod + mesh policies** | SPIFFE identity, mTLS + authz config push | `istio-system` |

### Data plane (green)

| Component | Role | Namespace |
| --- | --- | --- |
| **Istio edge Gateway** | North–south entry; validates RPT, injects `X-User-*` | `agentstudio-edge` |
| **apigateway-service / gui** | App routing/proxy and web UI | `agentstudio-services` / `agentstudio-console` |
| **agent-service** | Agno agents, RAG, MCP tool calls, guardrails | `agentstudio-services` |
| **kb-retrieval-service** | Vector / FTS / hybrid KB search | `agentstudio-services` |
| **Bifrost / TEI / MCP** | LLM + embedding gateway, in-cluster MiniLM, tool servers | `agentstudio-llm-gateway` / `agentstudio-services` |
| **connector / dataset / kb / eval workers** | Temporal activity executors | `agentstudio-workers` |
| **analytics-engine / JupyterLab** | Arrow Flight SQL + interactive workspaces | `agentstudio-services` / dynamic |
| **S3 Gateway + shared NFS + ONTAP** | POSIX-first data path; S3 API for catalog only | `agentstudio-workers` |

## 2. Service mesh & identity — north–south vs east–west

This makes the split concrete: **Keycloak (control plane)** issues the user
identity, **istiod (control plane)** issues workload identity, and the **Envoy
sidecars (data plane)** enforce both. Two lanes — the user lane (RPT, per-project
scope) and the service lane (tokenless mTLS + `X-Service-Caller`) — match
`unifiedGuard` in `config-service`.

```mermaid
flowchart LR
    U["Browser / user"]

    subgraph CP["CONTROL PLANE"]
        direction TB
        KC["Keycloak<br/>issues OIDC / RPT<br/>carries per-project permissions"]
        Istiod["istiod<br/>issues SPIFFE identity<br/>pushes mTLS + authz policy"]
    end

    subgraph DP["DATA PLANE — Envoy sidecars enforce"]
        direction TB
        GW["Edge Gateway + sidecar<br/>verify RPT (RequestAuthentication)<br/>inject X-User-*"]
        subgraph PodA["config-service pod"]
            direction TB
            SCa["Envoy sidecar<br/>verify JWT signature · mTLS"]
            Aapp["app + unifiedGuard<br/>user lane: decode RPT scope<br/>service lane: trust X-Service-Caller"]
            SCa --> Aapp
        end
        subgraph PodB["workflow-engine / worker pod"]
            direction TB
            SCb["Envoy sidecar<br/>EnvoyFilter injects X-Service-Caller"]
            Bapp["app (decode-only guard)"]
            SCb --> Bapp
        end
    end

    KC -.->|"token signing keys"| GW
    KC -.->|"token signing keys"| SCa
    Istiod -.->|"SPIFFE + policy"| GW
    Istiod -.->|"SPIFFE + policy"| SCa
    Istiod -.->|"SPIFFE + policy"| SCb

    U -->|"north-south: Bearer RPT"| GW
    GW -->|"mTLS · X-User-* · RPT"| SCa
    Aapp -->|"east-west: tokenless · STRICT mTLS · SPIFFE"| SCb

    classDef ctrl fill:#dbeafe,stroke:#1e40af,color:#0b1f44;
    classDef data fill:#dcfce7,stroke:#166534,color:#06301a;
    classDef side fill:#ede9fe,stroke:#6d28d9,color:#2e1065;
    classDef ext fill:#f1f5f9,stroke:#475569,color:#0f172a;
    class KC,Istiod ctrl;
    class GW,Aapp,Bapp data;
    class SCa,SCb side;
    class U ext;
```

### Two lanes (matches `unifiedGuard`)

| Lane | Carrier | Who enforces | App-side check |
| --- | --- | --- | --- |
| **North–south (user)** | Keycloak RPT on `Authorization: Bearer` (+ `X-User-*`) | edge gateway validates RPT; sidecar verifies signature | `unifiedGuard` user lane decodes RPT `permissions[]` for per-project scope |
| **East–west (service)** | Tokenless STRICT mTLS, SPIFFE identity | sidecar mTLS; EnvoyFilter injects `X-Service-Caller` | `unifiedGuard` service lane trusts `X-Service-Caller` when `internalAllowed` |

Decode-only guard: the app never verifies a JWT signature — the Istio sidecar's
`RequestAuthentication` does that at every hop, and `unifiedGuard` base64-decodes
the forwarded token only to read the per-project scope.

## Mesh namespaces

All sidecar-injected and STRICT-mTLS (`ISTIO_APP_NAMESPACES`, `mk/common.mk`):
`agentstudio-edge`, `agentstudio-console`, `agentstudio-services`,
`agentstudio-workers`, `agentstudio-llm-gateway`, `agentstudio-platform`,
`agentstudio-identity`, `monitoring`, `database`.

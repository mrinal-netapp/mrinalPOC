# Project Nemo / Agent Studio — Technical Writeup
## NetApp | Senior Software Engineer, Platform Team (Mar 2026 – present)

---

## Honesty Anchors (Read First)

- Green-field project in **internal/private preview** — not GA, does not yet have production-scale customer traffic
- Own the **security architecture, initial platform pipeline, multi-cloud deployability**; teammates own other modules (lineage, connectors, etc.)
- "Coming next" items (SMB, Snowflake, Databricks, A2A, ACL propagation, PII protection, cost dashboards) are **roadmap**, not shipped
- Quantitative claims (10,000+ jobs/day, 2000+ work units, 99.9%) are **architecture targets and design-point numbers**, not measured production traffic — frame as such
- **Verify:** confirm the **start date (Mar 2026)** and that **primary ownership of the security architecture + project-init workflow** matches your actual scope (you told me security architecture + the initial platform pipeline were yours; lineage/connectors were teammates').

---

## Value Proposition

### One Line

> "AI is easy to prototype but hard to operationalize — enterprise data is fragmented, and ~80% of it lives in NFS/SMB while most AI platforms assume object storage. Project Nemo lets customers build, deploy, govern, and operate AI agents directly on their enterprise data wherever it lives — on-prem, AWS, Azure, GCP — without moving or duplicating it."

### The Problem It Solves

```
Enterprise AI adoption today:

  Customer has: years of institutional knowledge in documents,
               databases, file systems across on-prem + multi-cloud

  Customer wants: AI agents that answer questions, automate workflows,
                 unlock value from that data

  The blocker:
    80% of enterprise unstructured data lives in NFS / SMB
    Most AI platforms assume object storage
    
    To adopt those platforms, customer must:
      1. Move data → ETL pipelines, copies, sync
      2. Rebuild permissions → new access control model
      3. Create governance from scratch → new audit trail
      4. Maintain all of the above forever
    
    Result: 12-18 months of platform engineering
            before any business team gets value

  Project Nemo eliminates that entirely.
```

### The 4 Barriers Eliminated

```
┌──────────────────────────────────────────────────────────────┐
│ BARRIER 1: No data movement                                  │
│   Agents work directly on NFS, SMB, object stores,          │
│   databases, SaaS — no copies, no ETL pipelines             │
│   Data stays where it is. Always.                            │
├──────────────────────────────────────────────────────────────┤
│ BARRIER 2: No rebuilding                                     │
│   Build once, run across on-prem / AWS / Azure / GCP        │
│   Same platform, same governance model everywhere            │
├──────────────────────────────────────────────────────────────┤
│ BARRIER 3: No lock-in                                        │
│   Choice of models (OpenAI / Azure / AWS / Anthropic /       │
│   Google), frameworks, MCP tools, vector DBs, clouds        │
│   Truly multi-cloud, truly open                              │
├──────────────────────────────────────────────────────────────┤
│ BARRIER 4: No security rework                                │
│   Source permissions and lineage stay attached to data       │
│   Agents operate inside governance boundaries customers      │
│   already trust — nothing to rebuild                         │
└──────────────────────────────────────────────────────────────┘
```

### Strategic Framing

> "This moves NetApp from **managing** enterprise data to **activating** it for AI. NetApp already has deep roots in enterprise storage — ONTAP, FSxN, ANF, GCNV. Project Nemo turns that storage estate into a first-class AI platform without customers having to move anything."

---

## Target Customers

```
Primary: Regulated enterprises
  Financial services, healthcare, defense, legal

  Why: Data sovereignty is a compliance requirement
       (HIPAA, SOX, FedRAMP, GDPR)
       "Send our documents to OpenAI" is a hard no
       from legal before the conversation starts

Secondary: Platform / infra teams at large tech companies
  Want to give internal product teams a governed,
  multi-tenant AI platform — instead of every team
  reinventing LLM integration with no cost isolation,
  no audit trail, no security controls

How to say it:
  "The target customer is a mid-to-large enterprise in a
   regulated industry — a bank, hospital system, or defense
   contractor — with years of institutional knowledge locked
   in documents and databases, a mandate to adopt AI, but
   cannot move that data to a public SaaS product.
   Agent Studio deploys inside their own Kubernetes cluster,
   connects to their existing storage (ONTAP, S3, SQL),
   and gives teams a self-service interface to build AI agents
   over their own data. The LLM call can point at a self-hosted
   model so nothing ever leaves their network."
```

---

## System Architecture — Three Layers

```
        ┌───────────────────────────────────────────────────────┐
        │   CLIENTS  (outside the cluster)                      │
        │   Browser · CLI · External APIs                       │
        └─────────────────────┬─────────────────────────────────┘
                              │ HTTPS
═══════════════════════ cluster boundary ═══════════════════════
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              LAYER 1 — INGRESS EDGE                          │
│                                                              │
│          ┌─────────────────────────┐                         │
│          │   Istio Gateway         │  ← terminates TLS       │
│          │   (Envoy · Gateway API) │    enforces mTLS STRICT │
│          └─────────────────────────┘    SPIFFE/X.509 per pod │
└──────────────────────────────────────────────────────────────┘
                              │
                              │  east-west = mTLS STRICT
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              LAYER 2 — CONTROL PLANE                         │
│                                                              │
│  ┌────────────────┐  trigger  ┌───────────────────────────┐  │
│  │ Config-Service │ ────────► │    Workflow-Engine (Go)   │  │
│  │  (Node.js)     │ ◄──────── │                           │  │
│  │                │  metadata │  Temporal client          │  │
│  │  credentials   │           │  scatter/gather           │  │
│  │  datasets       │           │  workflow definitions     │  │
│  │  models/agents │           └─────────────┬─────────────┘  │
│  └────────────────┘                         │ dispatch        │
│         ▲  │ fetch                          ▼                 │
│         │  │ agent cfg           ┌──────────────────────┐    │
│         │  │                     │   Temporal Server    │    │
│  ┌──────┴──┴─────────┐           │   (event history,   │    │
│  │  Agent-Service    │           │    task queues)      │    │
│  │  (Python)         │           └──────────────────────┘    │
│  │                   │  vector                               │
│  │  orchestrates LLM │ ──────► ┌──────────────────────┐     │
│  │  RAG injection    │ ◄─chunks─│  KB-Retrieval (Rust) │     │
│  │  tool calls       │          └──────────────────────┘     │
│  └───────────────────┘                                       │
│         │ LLM call via virtual key                           │
│         ▼                                                    │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  Bifrost   │  │  Lakekeeper  │  │      Keycloak        │ │
│  │ LLM Gateway│  │ (Iceberg cat)│  │       (IAM)          │ │
│  └────────────┘  └──────────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────┐
│              LAYER 3 — COMPUTE PLANE (Temporal workers)      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Connector   │  │   Dataset    │  │   KB-Processor   │   │
│  │  Worker      │  │  Processor   │  │   (Python)       │   │
│  │  (Python)    │  │  (Python)    │  │                  │   │
│  │              │  │              │  │  chunk docs      │   │
│  │  DB connect  │  │  file ingest │  │  embeddings      │   │
│  │  S3 sync     │  │  PII detect  │  │  vector index    │   │
│  │  schema disc │  │  Iceberg cat │  │                  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘   │
│         └─────────────────┴──────────────────┘               │
│                            │                                 │
│               ┌────────────────────────┐                     │
│               │      Shared Storage    │                     │
│               │  NFS PVC               │ ← workers: POSIX    │
│               │  /mnt/pvcs/default-nemo│   open() / shutil   │
│               │                        │                     │
│               │  VersityGW (S3 API)    │ ← browser: presigned│
│               │  s3.{apex}.com         │   SigV4 PUT         │
│               └────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

### The One-Sentence Walkthrough

> "North-south: browser → Istio gateway → Config-Service or Agent-Service. East-west: Agent-Service → KB-Retrieval → Bifrost → LLM. Async: Config-Service → Workflow-Engine → Temporal → workers → NFS."

---

## My Contributions

### 1. Security Architecture (Primary Ownership)

The "no security rework" differentiator is real because of this layer.

```
MULTI-TENANT ISOLATION — THREE LEVELS

Level 1: Keycloak RBAC
  Every user belongs to a project with a role:
    owner  → full control
    member → read/write within project
    viewer → read only

  Enforced via JWT claims on every request:

  User login → Keycloak → JWT
       │
       ▼
  Kubernetes Gateway → Sidecar validates JWT signature
       │
       ▼
  Context Guard: extracts claims → req.user (typed)
       │
       ▼
  Scope Guard: checks token scopes (read/write/admin)
       │
       ▼
  RBAC Guard: checks Keycloak role for this project
       │
       ▼
  Service handles request with full user context

Level 2: Config-Service project_id filtering
  Every DB query is project-scoped:
    SELECT * FROM agents WHERE project_id = ? AND id = ?
  No cross-project data leakage possible at the query layer

Level 3: Kubernetes namespace isolation
  Worker pods scoped per project
  Credentials materialized only into pods belonging to that project
  A compromised worker pod has no path to another project's secrets
```

```
PROJECT-SCOPED VIRTUAL KEYS (Bifrost)

Problem: LLM API keys are expensive and shared
         If one project leaks a key, all projects are exposed
         No per-project cost visibility or rate limiting

Solution: Bifrost LLM Gateway + virtual keys

  Real key: sk-openai-prod-...  (stored securely, never exposed)
  Virtual key: sk-proj-A-...    (scoped to project A)
  Virtual key: sk-proj-B-...    (scoped to project B)

  Agent-Service uses virtual key for LLM calls:
    POST /chat/completions
    Authorization: Bearer sk-proj-A-...
    
  Bifrost:
    validates virtual key → maps to real key
    enforces project rate limits
    tracks per-project token usage (cost isolation)
    forwards to real LLM provider

  Benefits:
    real key never leaves the cluster
    project A cannot exhaust project B's quota
    cost attribution is per-project, not aggregate
    rotate real key → update in one place, all virtual keys work
```

```
SECURE CREDENTIAL HANDLING

Enterprise systems require credentials:
  - S3 access keys (for ONTAP/FSxN connectors)
  - DB passwords (MySQL, Postgres connectors)
  - API keys (external MCP tools)
  - LLM API keys (OpenAI, Azure, Anthropic)

Design:
  credentials written via Config-Service API
  stored in PostgreSQL (encrypted at rest)
  REDACTED on all read responses ("***")
  materialized into Kubernetes Secrets per-project
  injected into worker pods as env vars only when needed
  
  credentials table:
    customerId | projectId | name    | value (encrypted) | type
    never returned in API responses — write-only from user perspective
```

### 2. Project Initialization Workflow

The most critical flow — sets up the entire per-project isolation boundary.

```
User creates Project
       │
       ▼
Config-Service → PostgreSQL (status = initializing)
       │
       ▼
Triggers ProjectInitWorkflow via Workflow-Engine → Temporal

Activities run in order (RetryPolicy: 3 attempts, backoff 2.0, 10-min timeout):

  1. RegisterProjectResource     → Keycloak resource        (CRITICAL)
  2. GrantInitialAdmin           → owner = project admin    (CRITICAL — runs
                                    first so failed init      first for safety)
                                    is still visible/
                                    manageable by owner
  3. PersistKeycloakResourceId   → PostgreSQL               (best-effort: warn+continue)
  4. SetupProjectLLMGateway      → Bifrost team + vkey      (CRITICAL)
  5. LookupWarehouse             → Lakekeeper "nemo"        (CRITICAL)
  6. UpdateProjectMetadata       → store warehouse id        (non-critical: warn+continue)
  7. CreateNamespace             → Lakekeeper namespace      (CRITICAL)
  8. CreateProjectServiceAccount → Keycloak svc account     (CRITICAL)
  9. GrantMembers (if invitees)  → parallel per role         (CRITICAL)
       │
       ▼
ReportProjectInitStatus → Config-Service (status = ready | failed)
  runs on BOTH success AND failure
  outcome visible in product, not just Temporal history
```

**Why Keycloak runs first (steps 1-2):**
> "The creator becomes a project admin before any failure-prone infra step. A mid-init failure never strands an orphaned project the owner can't see, retry, or delete."

**Why no saga rollback in init:**
> "Temporal retries each activity 3× with backoff. The two non-critical steps warn and continue. Teardown lives in a separate ProjectDeleteWorkflow — init deliberately avoids compensating deletes that would strip the owner's admin before they can investigate."

### 3. Initial Platform Pipeline & Multi-Cloud Deployability

```
Kubernetes-native deployment via Helm charts (tiered install order):

Tier 1: Database       → PostgreSQL, Redis
Tier 2: Identity       → Keycloak (OIDC)
Tier 3: Orchestration  → Temporal
Tier 4: Storage        → VersityGW (S3 Gateway), Lakekeeper
Tier 5: LLM Gateway    → Bifrost
Tier 6: Workers        → connector-worker, dataset-processor, kb-processor
Tier 7: Services       → Config, Workflow Engine, Agent, KB Retrieval
Tier 8: Console        → React UI
Tier 9: Observability  → Prometheus, Phoenix, OTEL Collector, Grafana

Running on AKS today.
Code written to deploy across AWS / Azure / GCP marketplaces
— same Helm charts, cloud-specific storage class and ingress config.

Multi-cloud abstraction:
  Storage: NFS PVC via Azure NetApp Files (ANF) on Azure
           → FSxN on AWS, GCNV on GCP (same POSIX interface)
  S3 API: VersityGW provides consistent S3 interface over NFS
          regardless of which cloud the NFS volume is on
  Auth: Keycloak is cloud-agnostic OIDC provider
        → no lock-in to Azure AD or AWS Cognito
```

---

## Key Flows

### Flow 1: Document Upload

```
Browser                Config-Service         VersityGW         NFS PVC
  │                         │                     │                │
  │ ① POST /datasets        │                     │                │
  │ ─────────────────────► │                     │                │
  │                         │ signs SigV4         │                │
  │ ② presigned URL ◄─────  │ presigned URL        │                │
  │                         │                     │                │
  │ ③ PUT file bytes        │                     │                │
  │ ──────────────────────────────────────────► │                │
  │                         │                     │ write          │
  │                         │                     │ ────────────► │
  │ ④ POST /import          │                     │                │
  │ ─────────────────────► │                     │                │
  │                         │                     │                │
  │                    triggers DatasetImport      │                │
  │                    Workflow → Temporal         │                │
  │                    → dataset-processor         │                │
  │                         │                     │                │
  │                    dataset-processor reads via POSIX open()    │
  │                    (not via S3 — no HTTP overhead on hot path) │
  │                         │                                      │
  │ ⑤ status: ready ◄─────  │                                      │
```

**Why presigned URL (not proxy through Config-Service):**
> "Config-Service signs a presigned URL — browser uploads directly to VersityGW. Config-Service never proxies file bytes. No memory spike, no timeout risk, no single-service bottleneck."

**Why workers read via POSIX not S3:**
> "Workers have the NFS PVC mounted. POSIX open() is filesystem speed — no HTTP overhead, no SigV4 signing on the hot path. VersityGW is only needed for external clients like the browser that can't mount NFS."

---

### Flow 2: RAG Inference

```
User: "What are my T&E reimbursement limits?"
  │
  ▼
Browser → POST /chat {agentId, query}
  │
  ▼
Agent-Service (Python)
  │
  ├── ① fetch agent config from Config-Service (LRU cached)
  │      returns: model info, virtual key (sk-proj-X-...)
  │
  ├── ② vector search via KB-Retrieval-Service (Rust)
  │      hybrid search: vector similarity + full-text search
  │      returns: top-K relevant chunks from LanceDB
  │
  ├── ③ build prompt:
  │      system:  agent instructions
  │      context: retrieved chunks ← RAG injection
  │      user:    "T&E limits?"
  │
  ├── ④ POST to Bifrost LLM Gateway
  │      Authorization: Bearer sk-proj-X-...
  │      Bifrost validates virtual key → maps to real key
  │      enforces project rate limits → forwards to OpenAI
  │
  └── ⑤ stream response back to browser
         "T&E limit is $500/day for hotels, $75 for meals..."
         + source citations: "T&E Policy Doc pg 3"
```

**The RAG flow — why it matters:**
> "Without RAG, the LLM answers from training data — generic, potentially wrong, no source citations. With RAG, every answer is grounded in the customer's actual documents — specific, verifiable, auditable."

---

### Flow 3: Knowledge Base Creation (KB Processing)

```
User triggers KB indexing
  │
  ▼
Config-Service → Workflow-Engine → Temporal
  │
  ▼
KnowledgeBaseCreationWorkflow:

  Step 1: FetchProjectCredentialsActivity
    → get embedding model credentials for this project

  Step 2: CreateWorkPlanActivity (on kb-processor)
    → list documents from S3 (knowledgebases/{kb_id}/)
    → split into file sets (≤100 files / ≤5MB per set)
    → return WorkPlan: N work units

  Step 3: ScatterGather Fan-Out (up to 2000 parallel activities)
    ProcessKBDocuments per work unit:
      a. pull documents from S3 (PDF/DOCX/TXT/MD)
      b. chunk (sliding window / sentence / fixed)
         chunk_size and overlap configurable per KB
      c. generate embeddings
         → OpenAI text-embedding-3-small
         → Azure OpenAI (per project credentials)
      d. write vectors to LanceDB (shared RWX PVC)
      e. heartbeat to Temporal every 60s (prevent timeout)
      f. POST progress to Workflow-Engine every 5s (real-time UI)

  Step 4: MergeKBResults
    → aggregate results from all work units
    → write kb_processing_results.json to S3
    → update KB status: "ready" in PostgreSQL

HPA autoscaling:
  Prometheus scrapes Temporal queue backlog metrics
  prometheus-adapter exposes: temporal_queue_backlog_kb
  HPA scales kb-processor: 1 → 5 pods based on queue depth
  MaxConcurrentActivities = 3 per pod
```

---

### Flow 4: Authentication

```
User login → Keycloak (OIDC)
  Returns: JWT (access token + refresh token)
  │
  ▼
Request hits Kubernetes Gateway
  Sidecar validates JWT signature (asymmetric key from Keycloak JWKS)
  │
  ▼
Context Guard
  extracts claims → req.user (typed: userId, projectId, roles)
  │
  ▼
Scope Guard
  checks token scopes: read / write / admin
  │
  ▼
RBAC Guard
  checks Keycloak role mapping for this project:
    owner / member / viewer
  │
  ▼
Service handles request with full user context
  all DB queries automatically project-scoped
```

---

### Flow 5: MCP Server Lifecycle

```
MCP (Model Context Protocol) = standard for connecting agents to tools

Three deployment types:

remote (user-hosted):
  User provides URL of already-running server
  Config-Service validates reachability + discovers tools
  No pod provisioned — zero infra overhead

managed (Agent Studio-provisioned):
  User picks from catalog: web_search_mcp, memory_mcp, ontap_mcp...
  MCPRuntimeManager:
    → splits env vars: secrets → K8s Secret, non-secrets → ConfigMap
    → credential secrets materialized into mcp-runtime-cred-{serverId}
    → creates Deployment + Service in agentstudio-services namespace
    → polls pod readiness
    → registers with Bifrost: server_name = {projectId}_{serverName}

platform (shared):
  Same as managed but bootstrapped once, shared across all projects
  PlatformMCPBootstrap provisions on startup

Agent calls tools:
  Agent-Service → MCPManager.connect_all()
  → resolves MCP server via Bifrost's aggregated /mcp endpoint
  → attaches per-call identity via MCP _meta (userId, projectId)
    (never the JWT — MCP doesn't carry auth tokens)
  → Bifrost routes to managed pod or external URL

On idle/delete:
  Deployment + Secrets torn down (managed/platform only)
```

---

## Temporal — Why It's Core to This Architecture

```
Temporal = durable workflow execution engine

Why not just async jobs or cron?

  Document indexing scenario:
    2000 work units, each generating embeddings
    Takes hours for large datasets
    Pod can crash, node can be preempted, network can fail

  Without Temporal:
    worker crashes at unit 1847 → lose all progress
    restart → reprocess 1847 units from scratch
    
  With Temporal:
    every activity is tracked in Temporal event history
    worker crashes → Temporal detects via heartbeat timeout
    reschedules activity on next available pod
    resumes at unit 1848 — exactly where it left off

Key Temporal concepts used:

  Workflow:  the durable coordinator (KnowledgeBaseCreationWorkflow)
             defines the sequence of activities
             state persisted in PostgreSQL-backed Temporal server
             
  Activity:  the actual unit of work (ProcessKBDocuments)
             runs on a worker pod
             retried automatically on failure
             heartbeat prevents zombie detection
             
  Task Queue: how Temporal routes activities to workers
              kb-processing queue → kb-processor pods
              dataset-processing queue → dataset-processor pods
              
  Scatter/Gather: fan-out N activities in parallel
                  wait for all to complete
                  aggregate results
                  → 2000 parallel embedding jobs
```

**Career through-line:**
> "At Goldman I hand-rolled durable execution — idempotency via Ansible, checkpointing via etcd, retries via K8s backoffLimit. At NetApp I use Temporal, which productizes exactly those same patterns — checkpointing via event history, retries via activity retry policy, idempotency via workflow IDs. Understanding the fundamentals first made adopting Temporal intuitive."

---

## Data Architecture

| Store | Purpose | Key Detail |
|---|---|---|
| **PostgreSQL** | All metadata — 50+ tables, JSONB columns | project-scoped, TypeORM, config-service owns it |
| **Redis** | Caching, pub/sub for progress events | LRU cache for agent config in agent-service |
| **Temporal** | Durable workflow execution state | activities, retry state, heartbeats |
| **VersityGW** | S3-compatible API over NFS | raw files, Parquet, processing outputs |
| **Lakekeeper** | Apache Iceberg REST catalog | table snapshots, schema evolution |
| **LanceDB** | Vector + full-text hybrid search | KB embeddings, shared RWX PVC across pods |

### Key DB Tables (Config-Service owns)

```
projects            → tenant root (home dir, Keycloak resource, Bifrost vkey)
project_members     → which users, which roles
credentials         → write-only enterprise secrets, scoped per project
data_sources        → connector configs (DB, S3, NAS, API)
data_sets           → ingested datasets and processing status
knowledge_bases     → vector KBs (embedding model, chunk strategy, status)
agents              → model, KB ids, instructions, guardrails
agent_teams         → multi-agent team definitions, versioned
mcp_servers         → registered MCP tools + runtime status
reference_edges     → lineage: "entity X references entity Y"
config_versions     → audit trail / change history
```

---

## Observability Stack

```
Services / Workers
  │  structured JSON logs → stdout
  │  Prometheus /metrics (port 9090)
  │  OTLP traces gRPC (port 4317)
  ▼
OTEL Collector
  receivers:  otlp (gRPC + HTTP)
  processors: batch, memory_limiter
  exporters:
    ├── Phoenix  (LLM trace backend, 30-day retention)
    │            OpenInference semantic conventions
    │            → every LLM call: tokens, latency, model, prompt, response
    │
    ├── Prometheus → metrics + HPA custom metrics
    │               via prometheus-adapter
    │
    └── Grafana  → RED metrics, queue depth, worker throughput

Three pillars:
  Logs    → structured JSON, log aggregator
  Metrics → Prometheus + ServiceMonitor CRDs (auto-discovery)
  Traces  → Phoenix (LLM-specific), OTLP pipeline
```

**Phoenix for LLM tracing:**
> "Standard distributed tracing (Jaeger/Zipkin) doesn't understand LLM semantics — you can't see prompts, token counts, or model parameters in a generic trace. Phoenix uses OpenInference conventions so every LLM call is observable as a structured trace with the full prompt, retrieved context, model response, and token cost."

---

## Kubernetes Namespace Layout

```
agentstudio-services:
  Config-Service (Node.js)
  Workflow-Engine (Go)
  Agent-Service (Python)
  KB-Retrieval-Service (Rust)
  Analytics-Service

agentstudio-workers:
  connector-worker (Python)
  dataset-processor (Python)
  kb-processor (Python)
  MCP managed pods (dynamic, per-project)

agentstudio-platform:
  Keycloak
  Temporal Server
  VersityGW (S3 Gateway)
  Lakekeeper (Iceberg catalog)
  Bifrost (LLM Gateway)
  PostgreSQL
  Redis
  LanceDB

monitoring:
  Prometheus
  Grafana
  Phoenix (LLM tracing)
  OTEL Collector
```

---

## Tech Stack Summary

| Layer | Technology | Why |
|---|---|---|
| **Frontend** | React, FluentUI, TypeScript | Low-code visual experience |
| **Config / API** | Node.js / TypeScript | Metadata, CRUD, workflow triggers |
| **Orchestration engine** | Go | High-throughput Temporal client |
| **AI / inference** | Python | Agent orchestration, RAG, embeddings |
| **Vector retrieval** | Rust (KB-Retrieval) | Low-latency hot path, memory efficiency |
| **Workflow** | Temporal | Durable multi-step flows, fault tolerance |
| **Container** | Kubernetes | Orchestration, HPA, namespace isolation |
| **Service mesh** | Istio | mTLS STRICT, SPIFFE/X.509 identity per pod |
| **Auth** | Keycloak (OIDC/OAuth2) | JWT, per-project RBAC, cloud-agnostic |
| **LLM gateway** | Bifrost | Virtual keys, cost isolation, rate limiting |
| **Databases** | PostgreSQL, Redis | Metadata, caching |
| **Vector DB** | LanceDB | Vector + FTS hybrid search |
| **File storage** | VersityGW + NFS PVC | S3 API over NFS — no data movement |
| **Catalog** | Lakekeeper (Iceberg) | Dataset metadata, schema evolution |
| **Observability** | Prometheus, Grafana, Phoenix, OTEL | RED metrics, LLM tracing |
| **Deploy** | Helm charts (tiered) | Multi-cloud deployability |

---

## Interview Framing

### How to Open (60 seconds)

> "At NetApp I'm on the platform team for Project Nemo — now called Agent Studio. It's a Kubernetes-native AI platform for enterprises that need to build AI agents over their own private data without moving it or reworking their security model.
>
> The core problem we're solving is that about 80% of enterprise unstructured data lives in NFS and SMB environments, but most AI platforms assume object storage — so customers have to move data, rebuild permissions, and create governance from scratch. We eliminate that. Agents work directly on ONTAP, FSxN, NFS, S3-compatible stores, and SQL databases wherever they already live — on-prem, AWS, Azure, GCP.
>
> My ownership is the security architecture — the multi-tenant isolation layer that makes 'no security rework' real: per-project RBAC via Keycloak OIDC, project-scoped virtual keys for LLM access through our Bifrost gateway for cost isolation, secure credential handling, and the project initialization workflow that sets up the full isolation boundary. I also set up the initial platform pipeline and contributed to the multi-cloud deployability via Helm."

### Your Angle

> "I own the security architecture that makes 'no security rework' real — permission-aware, multi-tenant isolation with per-project virtual keys for cost isolation and rate limiting. Enterprises trust us with their data because the security boundary is set up correctly from day one."

---

## STAR Story — Security Architecture

> "At NetApp I own the security architecture for Agent Studio — our multi-tenant AI platform. The challenge is that multiple enterprise teams run isolated AI projects on the same cluster, with their own credentials, their own LLM quota, and their own data — and none of them can see each other's anything.
>
> I designed and built three isolation layers that enforce this. First, Keycloak OIDC with per-project RBAC — every request carries a JWT, validated at the gateway, role-checked against the project before any service touches it. Second, project-scoped virtual keys in Bifrost, our LLM gateway — each project gets its own virtual key that maps to the real API key internally, so Bifrost enforces per-project rate limits and cost isolation without exposing the real key anywhere. Third, credentials are write-only — stored encrypted, materialized into Kubernetes Secrets scoped per project, injected only into worker pods that need them.
>
> I also designed the project initialization workflow in Temporal — it runs Keycloak authorization first, before any failure-prone infra step, so a mid-init failure never strands a project the owner can't access or delete. The full isolation boundary — Keycloak resource, Bifrost virtual key, Lakekeeper namespace — is set up atomically with retry guarantees."

---

## Cheat Sheet for Follow-up Questions

| Question | Answer |
|---|---|
| "What is RAG?" | "Retrieval-Augmented Generation — before calling the LLM, vector-search your knowledge base for relevant chunks, inject them into the prompt as context. LLM answers from your actual documents, not training data." |
| "What is Temporal?" | "Durable workflow engine — activities retry automatically on failure, workflow state persists across crashes. Like hand-rolled checkpointing + retries, productized." |
| "What is mTLS / Istio?" | "Every pod in the mesh has a SPIFFE X.509 identity. All east-west traffic is mutually authenticated and encrypted. A compromised pod can't impersonate another service." |
| "What is Bifrost?" | "LLM gateway — project-scoped virtual keys map to real API keys internally. Enforces per-project rate limits, tracks per-project token usage, never exposes real keys." |
| "What is VersityGW?" | "S3-compatible API over NFS. Workers read via POSIX (fast). Browser can't mount NFS so it uploads via S3 presigned URL — same physical storage, two access patterns." |
| "What is LanceDB?" | "Vector database for KB embeddings. Supports hybrid search — vector similarity + full-text search combined. Stored on RWX NFS PVC so multiple retrieval pods share the same index." |
| "How is multi-tenancy enforced?" | "Three layers: Keycloak RBAC on every request, project_id filter on every DB query, K8s namespace isolation for worker pods and credentials." |
| "How does the platform scale?" | "HPA on Temporal queue backlog metrics — kb-processor scales 1→5 pods based on actual pending work, not CPU. MaxConcurrentActivities=3 per pod for fine-grained concurrency." |
| "Is it in production?" | "Internal/private preview. Green-field — GA roadmap in progress. Scale numbers are architecture design points, not measured traffic." |
| "What's coming next?" | "SMB support, Snowflake/Databricks connectors, A2A agent collaboration, ACL propagation from source to KB, PII protection, cost dashboards." |
| "Why not use LangChain/LlamaIndex?" | "We use them internally as libraries. The platform adds what they don't provide: multi-tenancy, per-project cost isolation, enterprise auth, Temporal-based fault tolerance, and native NetApp storage connectivity." |
| "Why Keycloak over cloud-native IAM?" | "Cloud-agnostic — same auth layer on AWS, Azure, GCP, on-prem. No lock-in to Azure AD or AWS Cognito. Customers deploying on-prem don't have a cloud IAM provider." |

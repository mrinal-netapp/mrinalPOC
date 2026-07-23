# AgentStudio Architecture Diagrams

Mermaid source for platform architecture diagrams. For prose context see [HLD.md](HLD.md) and [design/platform-hld.md](design/platform-hld.md).

> **Gateway rename.** Diagrams below label the LLM gateway as **Bifrost** (formerly LiteLLM). The transport SDK Agno uses to reach Bifrost is still named `agno.models.litellm.LiteLLM`, but it is not a separate gateway — see [bifrost-migration.md](design/bifrost-migration.md). All embedding traffic (built-in MiniLM via in-cluster TEI, and remote OpenAI / Cohere / Voyage / etc.) also flows through Bifrost; see [unified-embedding-models.md](design/unified-embedding-models.md).

## 1. Overall System Architecture

All services run in a single Kubernetes deployment. Storage is POSIX-first: every data plane pod mounts the shared NFS PVC. The S3 Gateway is retained only for Iceberg/Lakekeeper catalog operations.

```mermaid
graph TB
    subgraph Clients
        Users["Users and Applications"]
        IcebergClients["Iceberg clients (S3 API)"]
    end

    subgraph Horizontals
        Gateway[apigateway-service]
        GUI[gui]
        Keycloak[Keycloak]
    end

    subgraph CoreServices [Core Services]
        ConfigService[config-service]
        WorkflowEngine[workflow-engine]
        WorkspaceMgr[workspace-manager]
        StorageMgr[storage-manager]
        AnalyticsEngine[analytics-engine]
    end

    subgraph AIServices [AI Services]
        AgentService[agent-service]
        KBRetrieval[kb-retrieval-service]
        Bifrost[Bifrost]
        MCPServers["MCP tool servers"]
    end

    subgraph WorkflowLayer [Workflow Layer]
        Temporal[Temporal]
        ConnectorWorker[connector-worker]
        DatasetProcessor[dataset-processor]
        KBProcessor[kb-processor]
    end

    subgraph DataLayer [Data Layer]
        Postgres[(PostgreSQL)]
        SharedFS["Shared NFS Filesystem\n(/mnt/pvcs/default-nemo)"]
        S3Gateway["S3 Gateway (VersityGW)"]
        Lakekeeper[Lakekeeper]
    end

    Users --> Gateway
    IcebergClients --> S3Gateway

    Gateway --> ConfigService
    Gateway --> WorkflowEngine
    Gateway --> WorkspaceMgr
    Gateway --> AgentService
    Gateway --> AnalyticsEngine
    Gateway --> Keycloak

    ConfigService --> Postgres
    ConfigService --> Lakekeeper

    WorkflowEngine --> Temporal
    Temporal --> ConnectorWorker
    Temporal --> DatasetProcessor
    Temporal --> KBProcessor

    ConnectorWorker --> SharedFS
    DatasetProcessor --> SharedFS
    KBProcessor --> SharedFS

    AgentService --> Bifrost
    AgentService --> KBRetrieval
    AgentService --> MCPServers

    KBRetrieval --> SharedFS
    AnalyticsEngine --> SharedFS
    StorageMgr --> Lakekeeper

    S3Gateway --> SharedFS
    Lakekeeper --> Postgres
```

## 2. Service Interaction Overview

Simplified view of how services call each other.

```mermaid
graph LR
    subgraph EntryPoints [Entry Points]
        Gateway[apigateway-service]
        GUI[gui]
    end

    subgraph Metadata [Metadata and State]
        Config[config-service]
        Lakekeeper[Lakekeeper]
        Postgres[(PostgreSQL)]
    end

    subgraph Orchestration
        WFEngine[workflow-engine]
        Temporal[Temporal]
        Workers["Python workers"]
    end

    subgraph AI
        Agent[agent-service]
        KBRetrieval[kb-retrieval-service]
        Bifrost[Bifrost]
    end

    subgraph Storage
        StorageMgr[storage-manager]
        SharedFS["Shared NFS"]
    end

    GUI --> Gateway
    Gateway --> Config
    Gateway --> WFEngine
    Gateway --> Agent

    Config --> Postgres
    Config --> Lakekeeper

    WFEngine --> Temporal
    Temporal --> Workers
    Workers --> SharedFS
    Workers --> Config

    Agent --> Bifrost
    Agent --> KBRetrieval
    KBRetrieval --> SharedFS

    StorageMgr --> Config
    StorageMgr --> Lakekeeper
```

## 3. Storage and I/O Model

The platform uses POSIX-first I/O. All data plane pods mount the shared NFS PVC at `/mnt/pvcs/default-nemo`. VersityGW exposes this as an S3-compatible API only for Iceberg/Lakekeeper.

```mermaid
graph TB
    subgraph DataPlane [Data Plane Pods]
        Workers["Python workers\n(connector, dataset, kb)"]
        KBRetrieval[kb-retrieval-service]
        Analytics[analytics-engine]
        Jupyter["JupyterLab workspaces"]
    end

    subgraph StorageServices [Storage Services]
        StorageMgr[storage-manager]
        S3GW["S3 Gateway (VersityGW)"]
    end

    subgraph Filesystem [Filesystem Layer]
        SharedPVC["Shared NFS PVC\n(/mnt/pvcs/default-nemo)\nread-write"]
        OntapPVCs["ONTAP Volume PVCs\n(/mnt/volumes/{id})\nread-only"]
    end

    subgraph CatalogPath [Catalog Path]
        Lakekeeper["Lakekeeper\n(Iceberg catalog)"]
    end

    Workers -->|"POSIX read/write"| SharedPVC
    KBRetrieval -->|"POSIX read (LanceDB)"| SharedPVC
    Analytics -->|"POSIX read (LanceDB)"| SharedPVC
    Jupyter -->|"POSIX read/write"| SharedPVC
    Workers -->|"POSIX read (zero-copy)"| OntapPVCs

    Lakekeeper -->|"S3 API (metadata only)"| S3GW
    S3GW -->|"POSIX backend"| SharedPVC

    StorageMgr -->|"Create PVC, StorageClass"| SharedPVC
    StorageMgr -->|"Create PV for ONTAP"| OntapPVCs
```

## 4. Request Flow: Data Acquisition

How data flows from an external source into the platform.

```mermaid
sequenceDiagram
    participant User
    participant GUI as gui
    participant Gateway as apigateway-service
    participant Config as config-service
    participant WFEngine as workflow-engine
    participant Temporal as Temporal
    participant Worker as connector-worker
    participant NFS as Shared NFS

    User->>GUI: Create connector + dataset
    GUI->>Gateway: POST /config/api/v1/connectors
    Gateway->>Config: Create connector
    Config-->>Gateway: Connector created

    User->>GUI: Start acquisition
    GUI->>Gateway: POST /workflow/api/v1/executions
    Gateway->>WFEngine: Start acquisition workflow
    WFEngine->>Temporal: Start DataAcquisition workflow
    Temporal->>Worker: Dispatch to data-acquisition queue

    Worker->>Worker: Connect to external source
    Worker->>NFS: Write acquired data (POSIX)
    Worker->>Config: Update dataset status
    Config-->>Worker: OK

    Worker-->>Temporal: Activity complete
    Temporal-->>WFEngine: Workflow complete
```

## 5. Request Flow: KB Creation and RAG Query

How a knowledge base is built and queried.

```mermaid
sequenceDiagram
    participant User
    participant Gateway as apigateway-service
    participant Config as config-service
    participant WFEngine as workflow-engine
    participant Temporal as Temporal
    participant KBProc as kb-processor
    participant NFS as Shared NFS
    participant KBRetrieval as kb-retrieval-service
    participant Agent as agent-service
    participant Bifrost as Bifrost

    Note over User,Bifrost: KB Creation
    User->>Gateway: Create KB
    Gateway->>Config: Create KB entity
    Config->>WFEngine: Trigger KB creation workflow
    WFEngine->>Temporal: Start KBCreation workflow
    Temporal->>KBProc: Dispatch to kb-processing queue
    KBProc->>NFS: Read source documents (POSIX)
    KBProc->>KBProc: Extract, chunk, embed
    KBProc->>NFS: Write LanceDB index (POSIX)
    KBProc->>Config: Update KB status

    Note over User,Bifrost: RAG Query
    User->>Gateway: Chat with agent
    Gateway->>Agent: Agent request
    Agent->>KBRetrieval: Search KB (vector + FTS)
    KBRetrieval->>NFS: Read LanceDB index (POSIX)
    NFS-->>KBRetrieval: Search results
    KBRetrieval-->>Agent: Ranked passages
    Agent->>Bifrost: LLM request with RAG context
    Bifrost-->>Agent: LLM response
    Agent-->>Gateway: Agent response
    Gateway-->>User: Response
```

## 6. Request Flow: Connector Acquisition (Streaming Pipeline)

How the streaming acquisition pipeline pulls data from an S3-compatible object store. Database and volume acquisition use simpler single-activity paths (see [connectors.md](design/connectors.md)).

```mermaid
sequenceDiagram
    participant User
    participant Gateway as apigateway-service
    participant Config as config-service
    participant WFEngine as workflow-engine
    participant Temporal as Temporal
    participant CW as connector-worker
    participant Redis as Redis Streams
    participant NFS as Shared NFS
    participant Import as DatasetImportWorkflow

    User->>Gateway: Start acquisition
    Gateway->>WFEngine: Start DataAcquisitionWorkflow
    WFEngine->>Temporal: Start workflow

    Temporal->>CW: DiscoverSourceItems
    CW->>CW: List source (S3 pagination)
    CW->>Redis: Push discovered items to stream

    loop N concurrent batches
        Temporal->>CW: AcquireBatch
        CW->>Redis: Read batch from stream
        CW->>CW: Download from source
        CW->>NFS: Write files (POSIX)
        CW-->>Temporal: Batch complete
    end

    Temporal->>CW: FinalizeAcquisition
    CW->>NFS: Write filelist.json
    CW-->>Temporal: FileListKey

    Temporal->>Import: Start child workflow (FileListKey)
    Note over Import: Scatter-gather import
    Import-->>Temporal: Import complete
    Temporal->>Config: Update dataset status
```

## 7. Request Flow: Pipeline Execution (DAG)

How a pipeline runs nodes in topological order, including agent blocks and human-in-the-loop.

```mermaid
sequenceDiagram
    participant User
    participant Gateway as apigateway-service
    participant Config as config-service
    participant WFEngine as workflow-engine
    participant Temporal as Temporal
    participant Agent as agent-service
    participant Bifrost as Bifrost

    User->>Gateway: Execute pipeline
    Gateway->>WFEngine: ExecutePipeline
    WFEngine->>Config: Fetch pipeline definition (DAG)
    Config-->>WFEngine: Pipeline graph (nodes + edges)
    WFEngine->>Temporal: Start PipelineWorkflow

    Note over Temporal: Topological sort of DAG nodes

    loop For each node (in dependency order)
        alt Data / transform node
            Temporal->>Temporal: ExecuteStepActivity on task queue
        else Agent node
            Temporal->>Agent: POST /invoke/async
            Agent->>Bifrost: LLM request
            Bifrost-->>Agent: Response
            Agent-->>Temporal: taskId
            Temporal->>Agent: Poll GET /tasks/{taskId}
            Agent-->>Temporal: Completed + output
        else Human-in-the-loop node
            Temporal->>Config: Update status (waiting_for_approval)
            Note over Temporal: Workflow pauses (up to 7 days)
            User->>Gateway: POST /resume (approvedIds)
            Gateway->>WFEngine: Signal workflow
            WFEngine->>Temporal: Send hil_resume signal
        end
        Temporal->>Config: Persist stepResult
    end

    Temporal->>Config: Update execution status (completed)
    Temporal-->>WFEngine: Execution result
```

## 8. Request Flow: Dataset Import (Scatter-Gather)

How acquired or uploaded data is processed into a dataset with stats and PII detection.

```mermaid
sequenceDiagram
    participant Trigger as Acquisition or Upload
    participant WFEngine as workflow-engine
    participant Temporal as Temporal
    participant DP as dataset-processor
    participant NFS as Shared NFS
    participant Config as config-service
    participant Catalog as Lakekeeper

    Trigger->>WFEngine: Start DatasetImportWorkflow
    WFEngine->>Temporal: Start workflow (FileListKey)

    Temporal->>DP: CreateWorkPlanActivity
    DP->>NFS: Read filelist.json or list directory
    DP-->>Temporal: Work plan (N units)

    par Scatter (N parallel activities)
        Temporal->>DP: ProcessUnit (unit 1)
        DP->>NFS: Read source file (POSIX)
        DP->>DP: Parse, compute stats, PII scan
        DP->>NFS: Write processed output (POSIX)
        DP-->>Temporal: Unit result
    and
        Temporal->>DP: ProcessUnit (unit 2..N)
        DP-->>Temporal: Unit results
    end

    Temporal->>DP: MergeResultsActivity
    DP->>NFS: Read all unit outputs
    DP->>DP: Merge stats, build Iceberg table
    DP->>NFS: Write final dataset
    DP-->>Temporal: Merge result

    Temporal->>Config: Update dataset status (created)
    Temporal->>Catalog: Register Iceberg table (if structured)
```

## 9. Request Flow: Project Initialization

How a new project is set up.

```mermaid
sequenceDiagram
    participant User
    participant Gateway as apigateway-service
    participant Config as config-service
    participant WFEngine as workflow-engine
    participant Temporal as Temporal
    participant StorageMgr as storage-manager
    participant Keycloak as Keycloak
    participant Catalog as Lakekeeper

    User->>Gateway: Create project
    Gateway->>Config: POST /projects
    Config->>Config: Create project entity
    Config-->>Gateway: Project created (status: new)

    Config->>WFEngine: Start ProjectInitWorkflow
    WFEngine->>Temporal: Start workflow

    Temporal->>Config: Create default storage root
    Temporal->>Keycloak: Create service account
    Temporal->>Catalog: Create warehouse + namespace
    Temporal->>StorageMgr: Provision default PVC
    Temporal->>Config: Update project status (ready)
```

## 10. Agent Invocation (Single Agent)

How a single agent processes a user message: config lookup, RAG retrieval, LLM call via Bifrost, MCP tool execution, session memory, and tracing.

```mermaid
sequenceDiagram
    participant User
    participant Gateway as apigateway-service
    participant Agent as agent-service (Agno)
    participant Config as config-service
    participant Bifrost as Bifrost gateway
    participant LLM as LLM Provider
    participant KBR as kb-retrieval-service
    participant NFS as Shared NFS
    participant MCP as MCP Tool Servers
    participant Redis as Redis (sessions)
    participant Phoenix as Phoenix (tracing)

    User->>Gateway: POST /agents/{id}/invoke
    Gateway->>Agent: Forward request

    Agent->>Config: Fetch agent config (cached)
    Config-->>Agent: systemPrompt, modelId, KBs, MCP servers, guardrails

    Agent->>Redis: Load session history (if sessionId)
    Redis-->>Agent: Prior messages

    opt Agent has knowledgeBaseIds (RAG)
        Agent->>KBR: Search KBs (query, topK, searchMode)
        KBR->>NFS: Read LanceDB indexes (POSIX)
        NFS-->>KBR: Vector/FTS results
        KBR-->>Agent: Ranked passages
        Agent->>Agent: Inject retrieved context into prompt
    end

    Agent->>Bifrost: Chat completion (model, messages, tools)
    Bifrost->>LLM: Forward to provider (OpenAI, Anthropic, etc.)
    LLM-->>Bifrost: Response (or tool_calls)

    loop Tool-call iterations (up to maxIterations)
        Bifrost-->>Agent: tool_calls
        Agent->>MCP: Execute tool (e.g. ontap.resize_volume)
        MCP-->>Agent: Tool result
        Agent->>Bifrost: Continue with tool results
        Bifrost->>LLM: Next turn
        LLM-->>Bifrost: Response
    end

    Bifrost-->>Agent: Final response

    Agent->>Redis: Save updated session history
    Agent->>Phoenix: Export OTLP spans (async, via BatchSpanProcessor)
    Agent-->>Gateway: Response (+ parsedOutput if outcomeSchema)
    Gateway-->>User: Agent response
```

## 11. Agent Team Invocation

How an agent team (manager + member agents) handles a request. The manager agent coordinates member agents using one of three orchestration modes: **coordinate** (manager delegates and synthesizes), **route** (manager picks one member), or **collaborate** (members work in sequence). Teams can nest (a team member can itself be a team).

```mermaid
sequenceDiagram
    participant User
    participant Gateway as apigateway-service
    participant Agent as agent-service
    participant Config as config-service
    participant TF as TeamFactory
    participant Manager as Manager Agent (Agno Team)
    participant Bifrost as Bifrost gateway
    participant LLM as LLM Provider
    participant M1 as Member Agent 1
    participant M2 as Member Agent 2
    participant MCP as MCP Tool Servers
    participant KBR as kb-retrieval-service
    participant Phoenix as Phoenix (tracing)

    User->>Gateway: POST /agent-teams/{id}/invoke
    Gateway->>Agent: Forward request

    Agent->>Config: Fetch team config (cached)
    Config-->>Agent: manager model, orchestration mode, members list

    Agent->>TF: create_from_config(team_config)
    TF->>Config: Fetch each member agent config
    Config-->>TF: Member configs (agent or sub-team)
    TF-->>Agent: Agno Team instance (manager + members)

    Agent->>Manager: team.arun(message)

    Manager->>Bifrost: Manager reasoning (which members to invoke)
    Bifrost->>LLM: Chat completion
    LLM-->>Bifrost: Delegation plan

    alt Coordinate mode
        par Delegate to members
            Manager->>M1: Delegated sub-task
            M1->>Bifrost: Member LLM call
            M1->>MCP: Tool calls (if configured)
            M1->>KBR: KB search (if configured)
            M1-->>Manager: Member 1 result
        and
            Manager->>M2: Delegated sub-task
            M2->>Bifrost: Member LLM call
            M2-->>Manager: Member 2 result
        end
        Manager->>Bifrost: Synthesize member results
        LLM-->>Manager: Final answer
    else Route mode
        Manager->>M1: Route to best member
        M1->>Bifrost: Full task
        M1-->>Manager: Result
    else Collaborate mode
        Manager->>M1: Step 1
        M1-->>Manager: Intermediate result
        Manager->>M2: Step 2 (with M1 output)
        M2-->>Manager: Final result
    end

    Agent->>Phoenix: Export spans (team + all member spans nested)
    Manager-->>Agent: Team response
    Agent-->>Gateway: Response
    Gateway-->>User: Team response
```

## 12. Agent Service Internal Architecture

Component-level view of agent-service showing how the pieces fit together.

```mermaid
graph TB
    subgraph AgentServicePod [agent-service]
        API["FastAPI endpoints\n/invoke, /invoke/stream,\n/invoke/async, /agent-teams/*"]
        AF["AgentFactory\n(Agno Agent builder)"]
        TF["TeamFactory\n(Agno Team builder)"]
        MR["ModelResolver\n(Bifrost model catalog)"]
        KBClient["KBRetrievalClient\n(RAG retriever)"]
        MCPPool["MCPConnectionPool\n(tool server connections)"]
        SS["SessionStore\n(conversation memory)"]
        CC["AgentConfigCache\n(config-service cache)"]
        Tracing["Phoenix Tracing\n(OTLP + OpenInference Agno)"]
        TaskMgr["TaskManager\n(async invoke tracking)"]
    end

    subgraph External [External Dependencies]
        ConfigSvc[config-service]
        BifrostSvc[Bifrost gateway]
        KBRSvc[kb-retrieval-service]
        MCPSvcs["MCP tool servers"]
        RedisExt[(Redis)]
        PhoenixExt["Phoenix\n(monitoring namespace)"]
    end

    API --> AF
    API --> TF
    API --> TaskMgr

    AF --> MR
    AF --> KBClient
    AF --> MCPPool
    TF --> AF
    TF --> CC

    CC --> ConfigSvc
    MR --> BifrostSvc
    KBClient --> KBRSvc
    MCPPool --> MCPSvcs
    SS --> RedisExt
    Tracing --> PhoenixExt
```

## 13. Memory Management (Conversation Memory & Context)

How conversation memory flows from the UI form to runtime buffer trimming. The
locked schema lives in `memoryContext` (jsonb) on `agents` and `agent_teams`;
config-service derives the legacy `memoryType` + `memoryConfig` columns on save
for agent-service back-compat; MAF reads `memoryContext` directly at bundle
load and constructs the right buffer.

### 13.1 Schema, Storage & Source-of-Truth

```mermaid
graph TB
    subgraph UI ["agent-studio-ui (form layer)"]
        Form["Conversation memory dialog\n(retentionMethod, messageHistoryEnabled,\nmessageHistoryLimit, summaryTokenLimitEnabled,\nsummaryTokenLimit)"]
        Mapper["agents-api-mapper.ts\nbuildMemoryContextFromForm()"]
    end

    subgraph CS ["config-service"]
        ValAgent["agentValidator.ts\nmessage_window_limit isInt(1..200)\nsummary_token_limit (0 or >=64)\nsummary_refresh_every_turns (0..50)\ntype enum"]
        ValTeam["agentTeamValidator.ts\n(same rules, create+update)"]
        Norm["MemoryContextDerivation.ts\nnormalizeMemoryContextInput()\n— accepts new+legacy shapes\n— validates type enum\n— defaults enabled=true"]
        Derive["deriveLegacyFromContext()\n— builds memoryType + memoryConfig\n  for agent-service back-compat"]
        Routes["agentRoutes.ts / agentTeamRoutes.ts\nbuildMemoryFieldsFromBody()\n— null clears all 3 columns\n— undefined skips update"]
    end

    subgraph DB ["agents / agent_teams (postgres)"]
        ColCtx["memory_context jsonb\n(source of truth)"]
        ColType["memoryType varchar\n(legacy mirror)"]
        ColConf["memoryConfig jsonb\n(legacy mirror)"]
    end

    subgraph MAF ["agent-service-maf"]
        Resolve["remote_adapter.resolve_memory()\nTier 1: memoryContext (new)\nTier 2: memoryType + memoryConfig\nTier 3: 20-msg sliding window"]
        Lift["team_loader.build_team_bundle_from_agent()\nlifts agent.memoryContext\nonto synthetic team blob"]
        Section["validators.MemorySection\n(max_history_length,\n max_tokens_per_session,\n buffer_type, summary_*, …)"]
        Factory["memory_buffer.create_memory_buffer()"]
    end

    Form --> Mapper
    Mapper -- "POST/PUT { memoryContext: {...} }" --> Routes
    Routes --> ValAgent
    Routes --> ValTeam
    Routes --> Norm
    Norm --> Derive
    Routes -- "save 3 columns atomically" --> ColCtx
    Routes --> ColType
    Routes --> ColConf

    Resolve -. "reads" .-> ColCtx
    Resolve -. "fallback reads" .-> ColType
    Resolve -. "fallback reads" .-> ColConf
    Lift --> Resolve
    Resolve --> Section
    Section --> Factory

    classDef sot fill:#bbe1fa,stroke:#0f4c75,color:#0f4c75
    classDef legacy fill:#ffd6d6,stroke:#a64545,color:#5a1a1a
    class ColCtx sot
    class ColType,ColConf legacy
```

**Locked defaults** (constants kept in both `MemoryContextDerivation.ts` and
`remote_adapter._DEFAULT_*`):

- `message_window_limit` → 20 messages
- `summary_token_limit` → 2000 tokens
- `summary_refresh_every_turns` → 0 (always summarize on overflow)
- `enabled` → true when absent (a missing field must NOT silently disable memory)
- `type` → `'window'` when enabled and unset; `'none'` when explicitly disabled

### 13.2 Runtime Flow per Invocation

```mermaid
sequenceDiagram
    participant Client
    participant MAF as agent-service-maf
    participant Registry as LazyTeamRegistry
    participant Loader as team_loader
    participant Bundle as TeamBundle
    participant SM as SessionManager
    participant Buffer as MemoryBuffer<br/>(SlidingWindow / Summary)
    participant Redis
    participant Gateway as Bifrost
    participant Summarizer as Summary LLM<br/>(only for SummaryBuffer)

    Client->>MAF: POST /projects/{pid}/agents/{aid}/invoke<br/>{ message, sessionId }

    Note over Registry: First call for this team_id<br/>(cache miss)
    MAF->>Registry: get_or_load_agent(pid, aid)
    Registry->>Loader: build_team_bundle_from_agent()
    Note over Loader: Lift agent's memoryContext<br/>onto synthetic team blob
    Loader->>Loader: resolve_memory(team_blob)<br/>tier 1 → 2 → 3
    Loader->>Loader: translate_memory_context()<br/>→ MemorySection (snake_case)
    Loader->>Loader: create_memory_buffer(<br/>  buffer_type='sliding_window'<br/>  | 'summary',<br/>  max_messages, max_tokens,<br/>  summary_refresh_every_turns,<br/>  adaptive_summarize_threshold)
    Loader-->>Bundle: bundle.memory_buffer + bundle.session_manager

    MAF->>SM: load_or_create_session(sessionId)
    SM->>Redis: GET agent_session:{...}
    Redis-->>SM: zlib + JSON blob
    SM-->>MAF: Session(messages=[...])

    MAF->>MAF: messages.append(user_msg)
    MAF->>Buffer: apply(session)

    alt SlidingWindowBuffer
        Note over Buffer: Token cap wins over msg cap (locked tiebreaker)<br/>Pop oldest until session fits<br/>Most recent message never dropped
    else SummaryBuffer (overflow & summarize)
        Buffer->>Buffer: _overflow_ratio(messages)
        alt below adaptive_summarize_threshold<br/>OR cadence gate active
            Note over Buffer: Cheap path — trim only,<br/>no LLM call
        else
            Buffer->>Summarizer: summarize_fn(older_messages)
            Summarizer-->>Buffer: summary text
            Note over Buffer: messages = [summary_system_msg,<br/>                ...kept_recent]<br/>Record checkpoint in metadata
        end
    end

    Buffer-->>MAF: session.messages trimmed in place
    MAF->>Redis: SET agent_session:{...} (compressed)

    MAF->>Gateway: chat completion (trimmed messages)
    Gateway-->>MAF: assistant response

    MAF->>MAF: messages.append(assistant_msg)
    MAF->>Buffer: apply(session) ← second trim cycle
    MAF->>Redis: SET agent_session:{...}

    MAF-->>Client: response + metadata<br/>(durationMs, usage, citations)
```

### 13.3 Why Two Trim Cycles Per Turn

Each invocation triggers `apply(session)` twice — once after appending the
incoming user message, once after appending the assistant response. This
preserves durability: if the LLM call dies between the two saves the user's
message is already persisted, and the conversation can be resumed without
having to re-send. For `summary_buffer` it also means the summary LLM call
fires at most once per turn (the second `apply` is usually a no-op because the
session is already at the limit).

### 13.4 Type → Buffer Mapping

| `memoryContext.type` (UI / API) | MAF `buffer_type` | Class | Trim behavior |
|---|---|---|---|
| `none` (or `enabled: false`) | n/a | — | History never sent to model |
| `window` | `sliding_window` | `SlidingWindowBuffer` | Drop oldest messages above cap; token cap wins over message cap when both set |
| `summary` | `summary` | `SummaryBuffer` (min verbatim tail) | Summarize older into one system message; default summary_token_limit = 2000 |
| `summary_buffer` | `summary` | `SummaryBuffer` (configurable tail) | Same engine but verbatim tail = `message_window_limit` (default 20) |

### 13.5 Defensive Properties Pinned by Tests

| Property | Test (config-service / MAF) |
|---|---|
| `{ type: 'window' }` alone accepted, `enabled` defaults to true | `MemoryContextDerivation.unit.test.ts: normalize: missing enabled does NOT silently disable memory` |
| Garbage `type` string never persisted | `normalize: garbage type returns undefined` + `garbage type with explicit enabled drops the bad type` |
| `summary_token_limit: "0"` (string) passes validator | `validators.unit.test.ts: summary_token_limit string-"0" and "64" pass` |
| `message_window_limit: 0` rejected at API edge | `message_window_limit rejects 0 (UI/API alignment)` |
| Tier-3 fallback emits 20-message default | `resolve_memory: tier 3 default when nothing present` |
| Single-agent invoke lifts agent's `memoryContext` onto synthetic team blob | `test_config_service_migration.test_get_or_load_agent_lifts_memory_context_onto_synthetic_team` |
| SummaryBuffer preserves the summary message when post-summary trim runs | `test_memory_buffer.test_post_summary_still_over_limit_drops_oldest_verbatim` |

---

## 14. Workspace Lifecycle

How workspaces are created and accessed.

```mermaid
sequenceDiagram
    participant User
    participant GUI as gui
    participant Gateway as apigateway-service
    participant Config as config-service
    participant WS as workspace-manager
    participant K8s as Kubernetes
    participant Pod as Workspace Pod

    User->>GUI: Create workspace
    GUI->>Gateway: POST /config/api/v1/workspaces
    Gateway->>Config: Create workspace (status: new)
    Config-->>Gateway: Workspace created
    Gateway-->>GUI: Workspace ID

    Note over WS: Polls for new workspaces
    WS->>Config: GET /workspaces?status=new
    Config-->>WS: Workspace list

    WS->>K8s: Create Pod, Service, PVC
    K8s-->>WS: Resources created
    WS->>Config: Update status (running)

    User->>Gateway: Access ws-{id}.{endpoint}
    Gateway->>Pod: Proxy request
    Pod-->>Gateway: Response
    Gateway-->>User: Workspace UI
```

## 15. Deployment Phases

The platform deploys in four phases, each idempotent.

```mermaid
flowchart LR
    subgraph Phase1 [Phase 1: Foundation]
        GatewayAPI["Gateway API CRDs"]
        PostgreSQL[(PostgreSQL)]
    end

    subgraph Phase2 [Phase 2: Identity]
        KC[Keycloak]
    end

    subgraph Phase3 [Phase 3: Platform Deps]
        Redis[Redis]
        Temporal[Temporal]
        LK[Lakekeeper]
        Bifrost[Bifrost]
        S3GW["S3 Gateway\n+ bootstrap hooks"]
    end

    subgraph Phase4 [Phase 4: App Services]
        AllServices["All application services\n(GUI, Gateway, Config,\nWorkflow, Agents, Workers,\nAnalytics, KB Retrieval,\nStorage Mgr, Workspace Mgr)"]
    end

    Phase1 --> Phase2
    Phase2 --> Phase3
    Phase3 --> Phase4
```

## Key Components Summary

### Application Services
- **apigateway-service** (Go): Routes requests, proxies S3 and workspaces, handles auth
- **config-service** (TypeScript): CRUD for all entities, catalog integration, backed by PostgreSQL
- **workflow-engine** (Go): Stateless orchestrator, starts Temporal workflows
- **agent-service** (Python): LLM agents with RAG, MCP tools, guardrails
- **kb-retrieval-service** (Rust): Vector, FTS, and hybrid search over LanceDB on shared filesystem
- **analytics-engine** (Go): Arrow Flight SQL query execution over LanceDB tables
- **storage-manager** (TypeScript): PVC lifecycle, dynamic provisioning, volume mounts
- **workspace-manager** (TypeScript): Orchestrates K8s resources for isolated workspaces
- **gui** (React / FluentUI): Web-based project, data, pipeline, and agent management

### Workers (Python, on Temporal task queues)
- **connector-worker**: Data acquisition from S3, databases, ONTAP, GCNV, Redash
- **dataset-processor**: Import, column stats, PII detection
- **kb-processor**: Document extraction, chunking, embedding, LanceDB index creation

### Infrastructure
- **PostgreSQL**: Metadata, entity state, workflow history
- **Temporal**: Durable workflow orchestration
- **Lakekeeper**: Apache Iceberg catalog for structured data
- **Bifrost**: Unified LLM provider gateway
- **S3 Gateway (VersityGW)**: S3 compatibility layer over NFS (Iceberg/Lakekeeper only)
- **Keycloak**: OIDC authentication and authorization
- **Redis**: Caching
- **Shared NFS Filesystem**: Primary data store, POSIX-first I/O for all data plane pods

# AgentStudio — Sequence Diagrams

> All mermaid `sequenceDiagram` blocks from the architecture deep dive, extracted for quick reference.

## 1. Document Upload Flow

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant CS as Config-Service
    participant WE as Workflow-Engine
    participant TP as Temporal
    participant DP as Dataset-Processor
    participant VGW as VersityGW (S3)
    participant NFS as NFS PVC

    B->>CS: POST /datasets {name, kind: unstructured}
    CS-->>B: {datasetId: "dsetk7m2p9xq"}

    B->>CS: PATCH /manifests/{id}/files {fileNames: ["T&E.pdf","Travel.pdf"]}
    Note over CS: Signs PutObject with SigV4<br/>key = nemo-s3gateway-credentials<br/>expiry = 3600s
    CS-->>B: {preSignedUrls: ["https://s3.apex.com/..."]}

    B->>VGW: PUT https://s3.apex.com/{bucket}/{key} (file bytes)
    Note over VGW: Validates SigV4 signature<br/>using same credentials
    VGW->>NFS: write /mnt/pvcs/default-nemo/{key}
    VGW-->>B: 200 OK

    B->>CS: POST /datasets/{id}/import
    CS->>WE: trigger DatasetImportWorkflow
    WE->>TP: start workflow (durable)
    TP-->>WE: workflowId

    TP->>DP: dispatch CreateWorkPlanActivity
    Note over DP: list_data_files() via POSIX<br/>partition into work units
    DP-->>TP: WorkPlan {fileSets, totalFiles}

    TP->>DP: dispatch ProcessDatasetFiles (scatter/gather)
    Note over DP: reads files via POSIX open()<br/>PII detection<br/>register in Iceberg catalog
    DP->>CS: PATCH /datasets/{id}/status = "ready"
```

---

## 2. Knowledge Base Creation

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant CS as Config-Service
    participant WE as Workflow-Engine
    participant TP as Temporal
    participant KBP as KB-Processor
    participant VDB as Vector DB
    participant NFS as NFS PVC

    B->>CS: POST /knowledgebases {datasetId, embeddingModel, chunkStrategy}
    CS-->>B: {kbId: "kb-xyz"}

    CS->>WE: trigger KBImportWorkflow
    WE->>TP: start workflow (durable)

    TP->>KBP: dispatch CreateWorkPlanActivity
    Note over KBP: lists files under dataset path<br/>via POSIX mount
    KBP-->>TP: WorkPlan {fileSets}

    TP->>KBP: dispatch ProcessKBDocuments (scatter/gather)
    KBP->>NFS: open() each Thrive PDF
    Note over KBP: chunk documents<br/>(paragraph / sentence strategy)<br/>activity.heartbeat() every batch
    KBP->>KBP: generate embeddings<br/>(embedding model selected by user)
    KBP->>VDB: write vectors + chunk text + metadata
    KBP-->>TP: {vectorsCreated: 1842, status: success}

    TP->>CS: update KB status = "ready"
    CS-->>B: KB ready (polling / websocket)
```

---

## 3. Agent Creation

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant CS as Config-Service
    participant PG as PostgreSQL

    B->>CS: POST /agents
    Note over B: {<br/>  name: "Thrive Assistant",<br/>  model: "gpt-4o",<br/>  kbIds: ["kb-xyz"],<br/>  goal: "Answer Thrive policy questions",<br/>  instructions: "Use KB as source of truth..."<br/>}

    CS->>PG: INSERT agent record
    Note over PG: stores:<br/>• model ref<br/>• KB ref<br/>• system instructions<br/>• goal
    CS-->>B: {agentId: "ag-abc", status: "draft"}

    B->>CS: PATCH /agents/ag-abc {status: "active"}
    CS-->>B: Agent ready
```

---

## 4. Inference Phase (RAG Query)

```mermaid
sequenceDiagram
    autonumber
    participant E as Employee (Browser)
    participant AS as Agent-Service
    participant CS as Config-Service
    participant KB as KB-Retrieval-Service
    participant VDB as Vector DB
    participant BF as Bifrost (LLM Gateway)
    participant LLM as LLM (GPT-4o)

    E->>AS: POST /chat {agentId, query: "What are T&E reimbursement limits?"}

    AS->>CS: GET /agents/ag-abc (LRU+TTL cache hit after first request)
    CS-->>AS: {model: gpt-4o, kbIds: [kb-xyz], instructions: "...", goal: "..."}

    AS->>KB: POST /search {kbId: kb-xyz, query: "T&E reimbursement limits", topK: 5}
    KB->>VDB: vector similarity search
    VDB-->>KB: top-5 vectors + chunk text
    KB-->>AS: chunks: ["T&E limit $500/day hotels", "Meal per diem $75", "Approval >$1000"...]

    Note over AS: Build prompt:<br/>system = agent instructions<br/>context = retrieved KB chunks  ← RAG<br/>user = employee question

    AS->>BF: POST /chat/completions {model, messages, project_virtual_key}
    Note over BF: routes using project-scoped<br/>virtual key → rate limit<br/>+ cost isolation per project
    BF->>LLM: forward prompt
    LLM-->>BF: "T&E limit is $500/day for hotels,<br/>$75 for meals. Manager approval<br/>required above $1000..."
    BF-->>AS: streamed response

    AS-->>E: stream answer + source citations<br/>"Source: T&E Policy Doc, pg 3"
```

---

## 5. JWT Auth Flow

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant KC as Keycloak
    participant CS as Config-Service
    participant JWKS as Keycloak JWKS Endpoint

    B->>KC: POST /realms/nemo/protocol/openid-connect/token<br/>{username, password}
    KC-->>B: {access_token: "eyJ...", expires_in: 300}
    Note over B: JWT contains:<br/>• sub (user ID)<br/>• email<br/>• preferred_username<br/>• agentstudio.project_id

    B->>CS: GET /api/v1/projects/{id}/datasets<br/>Authorization: Bearer eyJ...

    Note over CS: createAuthMiddleware runs:
    CS->>CS: jwt.decode(token) → extract kid, iss
    CS->>JWKS: GET /realms/nemo/protocol/openid-connect/certs<br/>(cached 1 hour, single client instance)
    JWKS-->>CS: {keys: [{kid, n, e, alg: RS256}]}
    CS->>CS: jwt.verify(token, publicKey, {algorithms: RS256})
    Note over CS: validates:<br/>• RS256 signature ✓<br/>• issuer = /realms/nemo ✓<br/>• expiry ✓

    CS->>CS: req.user = {sub, email, project_id}
    CS->>CS: inject x-user-id, x-user-email headers

    CS-->>B: 200 {datasets: [...]}
```

---

## 6. Keycloak Resource Authorization

```mermaid
sequenceDiagram
    autonumber
    participant WE as Workflow-Engine
    participant KC as Keycloak Admin API
    participant CS as Config-Service
    participant PG as PostgreSQL

    Note over WE: ProjectInitWorkflow Step 5+6+7

    WE->>KC: POST /admin/realms/nemo/authz/resource-server/resource<br/>{name: "project:{projectId}", type: "project"}
    KC-->>WE: {id: "resource-uuid-xyz"}

    WE->>CS: PATCH /internal/projects/{id}/keycloak-resource<br/>{resourceId: "resource-uuid-xyz"}
    CS->>PG: store keycloakResourceId on project record

    WE->>KC: POST /admin/realms/nemo/authz/resource-server/permission<br/>{resource: "resource-uuid-xyz",<br/> user: creatorUserId,<br/> scopes: ["admin"]}
    KC-->>WE: permission granted

    Note over KC: Now enforced on every request:<br/>user must have permission<br/>on project resource to access it
```

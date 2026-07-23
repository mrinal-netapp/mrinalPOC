# Facet concept and dataset/entity state (revised)

## Design principles

- **Single responsibility**: Entity status = core lifecycle (import/creation). Facets = optional, named enhancements with their own state and jobs.
- **Open/closed**: New facet types (e.g. Usage) added without changing entity schemas; new entities (KB, Agent) reuse the same Facet model.
- **Clear semantics**: User-facing labels (Processing / Ready / Errored) for both entity and facet state. Facet population jobs are tracked per facet, not on the entity.
- **Modular and isolated**: Facet API and storage are generic; facet-type-specific logic (what to run, where to store artifacts) lives in workflows/processors and optional facet metadata (summary) in Facet.summary.

---

## 1. Facet concept (generalized)

### 1.1 Definition

A **Facet** is a named, optional enhancement for an entity. It has:

- **Identity**: Which entity (type + id) and which facet type (e.g. `pii`, `usage`).
- **State**: `in_progress` | `ready` | `errored` (lifecycle of that enhancement).
- **Job tracking**: `jobId` when a facet-population job is running; cleared when done.
- **Error**: `errorMessage` when state is `errored`.
- **Summary**: Optional facet-type-specific JSON (e.g. PII: filesWithPii, totalFiles) for list/detail UI and APIs.
- **Timestamps**: `lastUpdated` (and optionally `createdAt`) for display and ordering.

Examples:

- **Dataset + PII facet**: User enables "look for PII" during import → import job also populates PII facet; or user runs "Reprocess PII" → only PII facet population job runs, tracked on Facet(dataset, pii).
- **Dataset + Usage facet** (future): A separate job computes usage patterns; state and summary live on Facet(dataset, usage).
- **KB / Agent**: Same table; e.g. Facet(kb, pii), Facet(agent, usage).

### 1.2 Data model

**New entity: Facet** (config-service)

- **Table**: `facets` (or `entity_facets`).
- **Columns**:
  - `id`: PK (e.g. uuid or composite surrogate).
  - `projectId`: string (for scoping and auth).
  - `entityType`: enum `'dataset' | 'knowledge_base' | 'agent'` (extensible).
  - `entityId`: string (FK to entity's id in its table).
  - `facetType`: string, e.g. `'pii'`, `'usage'` (registry or constrained enum).
  - `state`: enum `'in_progress' | 'ready' | 'errored'`.
  - `jobId`: string, nullable (workflow/job execution id when state is in_progress).
  - `errorMessage`: text, nullable.
  - `summary`: jsonb, nullable (facet-type-specific summary for UI).
  - `lastUpdated`: timestamp (set on every state/summary update).
  - `createdAt`: timestamp (optional).
- **Unique constraint**: `(projectId, entityType, entityId, facetType)` so each entity has at most one row per facet type.
- **Indexes**: By (entityType, entityId) for "list facets for entity"; by (projectId, entityType) for project-scoped queries.

No foreign keys to `data_sets` / `knowledge_bases` if we want to keep Facet in a separate bounded context; otherwise optional FKs for integrity. Same API works either way.

### 1.3 Facet state lifecycle

- **in_progress**: A facet population job is running (`jobId` set). Entity status is unchanged.
- **ready**: Facet has been populated successfully. `jobId` cleared, `errorMessage` cleared, `summary` may be set.
- **errored**: Last population attempt failed. `jobId` cleared, `errorMessage` set; `summary` may be from a previous successful run.

Transitions: (none/ready/errored) → in_progress (when job starts); in_progress → ready or errored (when job completes).

---

## 2. API design (config-service)

### 2.1 Generic facet endpoints (recommended)

- **List facets for an entity**  
  `GET /api/v1/projects/:projectId/:entityType/:entityId/facets`  
  Returns `{ facets: Facet[] }`. Entity-type can be `datasets`, `knowledge_bases`, `agents` (or singular); resolve entityId in that context.

- **Get one facet**  
  `GET /api/v1/projects/:projectId/:entityType/:entityId/facets/:facetType`  
  Returns 200 with facet or 404.

- **Update facet state** (used by processors/workflows)  
  `PUT /api/v1/projects/:projectId/:entityType/:entityId/facets/:facetType`  
  Body: `{ state, jobId?, errorMessage?, summary? }`. Validates state; clears `jobId` when state is ready/errored. Sets `lastUpdated`. Idempotent.

- **Trigger facet population**  
  `POST /api/v1/projects/:projectId/:entityType/:entityId/facets/:facetType/run`  
  For datasets + PII: validates entity exists and is in a runnable state (e.g. dataset ready/errored); creates/updates Facet(dataset, pii) with state=in_progress, jobId=workflowId; starts the existing "reprocess PII only" workflow (or a dedicated facet-population workflow). Returns 202 with workflowId.  
  Same pattern later for Usage or other facet types and for KB/Agent.

Alternatively, keep entity-specific URLs for v1 and delegate internally to a shared FacetService:

- **Dataset PII (current)**  
  - `POST .../datasets/:id/actions/reprocess-pii` → becomes a thin wrapper that ensures Facet(dataset, pii) exists, sets state=in_progress, jobId=workflowId, then starts the same import job with reprocessPiiOnly=true.  
  - Processor on completion calls `PUT .../datasets/:id/facets/pii` with state and optional summary/errorMessage (and clears jobId).

Both styles can coexist: entity-specific actions for backward compatibility and a generic Facet API for new features and UI.

### 2.2 Dataset GET response (shaping for GUI)

- Include **facets** in dataset payload: e.g. `dataset.facets = [ { facetType: 'pii', state, jobId?, errorMessage?, summary?, lastUpdated } ]`.  
- Backfill: for existing datasets with `piiSummary` / `enablePiiAnalysis`, create or derive a Facet(dataset, pii) with state=ready and summary from piiSummary so the UI can show "PII facet: Ready" without a separate round-trip.  
- Optionally keep `piiSummary` on Dataset for a transition period and sync from Facet(dataset, pii).summary; then deprecate.

---

## 3. Current implementation mapping

### 3.1 Dataset + PII as first facet

- **Facet type**: `pii`.
- **Entity**: entityType=dataset, entityId=dataset.id.
- **Import with "look for PII"**: Existing import job runs; at the end of the processor (full import path), when PII is enabled and summary is computed:
  - Call Facet API: ensure Facet(dataset, pii) exists; set state=ready, clear jobId, set summary from current pii summary. (No separate "facet job" for this path; the import job did the work.)
- **"Reprocess PII only"** (facet-only run):
  - **Config-service** (reprocess-pii route):
    - Do **not** change dataset status.
    - Ensure Facet(dataset, pii) exists; set state=in_progress, jobId=workflowId, clear errorMessage.
    - Start the same import workflow with reprocessPiiOnly=true (this is the "facet population job" for PII).
  - **Processor** (REPROCESS_PII_ONLY path):
    - On **success**: Call Facet API: set state=ready, clear jobId, set summary (and optionally still call existing update_dataset_pii_summary for backward compatibility during migration).
    - On **failure**: Call Facet API: set state=errored, errorMessage, clear jobId. Do **not** call update_dataset_status.
  - **Dataset status**: Unchanged (remains ready or errored).

- **Remove** from Dataset (over time): PII-specific job-tracking fields (e.g. piiJobId, piiErrorMessage) if they were added; keep enablePiiAnalysis / piiAnalysisImageOnly as **configuration** (user preference for import and for PII facet). PII **result** (state, summary, job) lives on Facet.

### 3.2 Processor (job-dataset-import)

- **Full import with PII**: At end, after writing pii_details.json and computing pii_summary, call Facet API to set Facet(dataset, pii) state=ready and summary (in addition to or instead of update_dataset_pii_summary).
- **REPROCESS_PII_ONLY**:
  - On success: Call Facet API only (state=ready, summary); do not call update_dataset_status. Optionally keep update_dataset_pii_summary for compatibility.
  - On failure: Call Facet API only (state=errored, errorMessage); do not call update_dataset_status.
- **Empty table** in reprocess_pii_only: Same as success — set facet state=ready (and clear jobId) via Facet API only.

### 3.3 Entity status labels (unchanged from prior plan)

- Use **Processing / Ready / Errored** in GUI (and optionally in API) for **entity** status (e.g. dataset status).
- Use the **same** labels for **facet** state in the UI: "PII facet: In progress" / "Ready" / "Failed" so the mental model is consistent.

---

## 4. Workflow / job semantics

- **Import job** (full): Entity status = Processing; on success entity → Ready (and catalog, etc.). If PII was requested, the same job populates PII facet → Facet(dataset, pii).state = ready (no separate facet jobId for this path).
- **Facet population job** (e.g. PII reprocess): Only runs the steps that populate that facet. Tracked by Facet(dataset, pii).jobId and .state. Entity status is not set to Processing; only the facet is in_progress → ready/errored.

So the "job we launch for pii-reprocess" is the **facet population job** for the PII facet; it is tracked on the Facet, and the facet's state is in progress / ready / errored.

---

## 5. GUI (concise)

- **Entity status**: One primary badge per entity (Dataset/KB): Processing | Ready | Errored (from entity.status).
- **Facets**: Shown per entity (e.g. Dataset detail page):
  - Section "Facets" or "Enhancements" listing each facet (e.g. PII, later Usage) with its own state: In progress / Ready / Failed.
  - When a facet is in progress, show "In progress" and optionally a link to the workflow (from facet.jobId).
  - When failed, show errorMessage and a "Retry" that calls the facet-run endpoint.
- **PII reprocess**: Copy should say that only the PII facet is being updated and the dataset remains ready (no "dataset status will change to creating").
- **List view**: Optionally show a compact facet indicator per entity (e.g. "PII: Ready" or "PII: In progress") without cluttering the main status.

---

## 6. Implementation order (recommended)

1. **Facet model and API (config-service)**
   - Add `Facet` entity and migration (or schema sync).
   - Implement FacetService (upsert by projectId, entityType, entityId, facetType; update state/jobId/errorMessage/summary).
   - Add routes: GET list, GET one, PUT state (for processor), POST run (for PII reprocess and future facet types). Optionally keep `POST .../datasets/:id/actions/reprocess-pii` as a wrapper that updates Facet and starts workflow.
   - From Dataset GET (and list), include `facets` (load Facet rows for that dataset) and/or backfill from existing piiSummary so UI can rely on Facet.

2. **Dataset reprocess-pii and processor**
   - Reprocess-pii: Stop setting dataset.status to creating; create/update Facet(dataset, pii) with state=in_progress, jobId=workflowId; start workflow.
   - Processor (REPROCESS_PII_ONLY): On success/failure call Facet API only; do not call update_dataset_status. On success, set facet state=ready and summary; on failure, state=errored and errorMessage.
   - Full import with PII: At end, set Facet(dataset, pii) to ready and summary (in addition to or instead of piiSummary on Dataset).

3. **Processor HTTP client**
   - Add a small client (or reuse config-service client) to call `PUT .../facets/:facetType` (or entity-scoped URL) with state/summary/errorMessage. Use same auth as existing config-service calls.

4. **GUI**
   - Dataset detail: Show "Facets" with PII facet state (In progress / Ready / Failed) and summary; "Reprocess PII" triggers facet-run and shows in-progress on the facet only.
   - List: Optionally show PII facet status. Use Processing/Ready/Errored for entity and same wording for facet state.
   - Remove misleading "dataset status will change to creating" in PII dialog.

5. **Optional: Entity status rename**
   - If desired, rename entity status enum to processing/ready/errored everywhere (dataset, KB) and use the same terms in API and UI (as in the previous plan). This is independent of Facet and can be done before or after Facet.

6. **Future**
   - New facet types (e.g. Usage): Add facetType, implement job that calls Facet API on completion; add "Run Usage facet" (or similar) in UI.
   - KB/Agent: Reuse same Facet table and API with entityType=knowledge_base or agent; add facet-run endpoints and UI when needed.

---

## 7. Summary

| Concept | Responsibility | State / tracking |
|--------|----------------|------------------|
| **Entity (Dataset, KB, Agent)** | Core lifecycle (import, creation) | status: Processing / Ready / Errored; jobId for main job only. |
| **Facet (e.g. PII, Usage)** | Optional, named enhancement | state: in_progress / ready / errored; jobId only while facet job runs; summary + errorMessage. |
| **Import with "look for PII"** | Full import + populate PII in same job | Entity → Ready; Facet(dataset, pii) → ready (no separate facet jobId). |
| **PII reprocess** | Facet population job only | Facet(dataset, pii) → in_progress (jobId set) → ready/errored; entity status unchanged. |

This keeps the design modular, isolates facet state and jobs from entity state, and makes it clear to users that "Reprocess PII" only updates the PII facet while the dataset stays ready.

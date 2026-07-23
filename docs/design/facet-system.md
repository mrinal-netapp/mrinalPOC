# Facet System Design

## Motivation

Entities in the platform (datasets, knowledge bases, agents, projects) accumulate derived metadata over time: PII scan results, embedding statistics, usage summaries, lineage graphs. These artifacts share common concerns:

- **Asynchronous production** — computed by background jobs (Temporal workflows), not inline with the create/update path.
- **Lifecycle tracking** — callers need to know whether a computation is pending, finished, or failed.
- **Idempotent updates** — concurrent or overlapping job runs must not corrupt data.
- **Uniform access** — the GUI needs a predictable REST pattern to read/poll facets regardless of type.

Rather than adding bespoke tables and endpoints for each new kind of metadata, the **Facet system** provides a single generic storage and lifecycle layer that any entity type and any facet type can use.

## Schema: `entity_facets`

```sql
CREATE TABLE entity_facets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId"   VARCHAR(255) NOT NULL,
  "entityType"  VARCHAR(50)  NOT NULL,   -- 'dataset' | 'knowledge_base' | 'agent' | 'project'
  "entityId"    VARCHAR(255) NOT NULL,
  "facetType"   VARCHAR(50)  NOT NULL,   -- e.g. 'pii', 'embedding', 'lineage'
  state         facet_state  NOT NULL DEFAULT 'in_progress',
  "jobId"       VARCHAR(255),            -- Temporal workflow execution ID
  "errorMessage" TEXT,
  summary       JSONB,                   -- facet-type-specific payload
  "lastUpdated" TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT entity_facets_unique
    UNIQUE ("projectId", "entityType", "entityId", "facetType")
);

CREATE INDEX idx_entity_facets_entity
  ON entity_facets ("entityType", "entityId");

CREATE INDEX idx_entity_facets_project_type
  ON entity_facets ("projectId", "entityType", "facetType");
```

### Column semantics

| Column | Purpose |
|---|---|
| `projectId` | Project scope; used for cleanup on project deletion |
| `entityType` | Kind of parent entity (`dataset`, `knowledge_base`, `agent`, `project`) |
| `entityId` | ID of the parent entity. For project-scoped facets, equals `projectId` |
| `facetType` | Discriminator within a given entity (e.g. `pii`, `lineage`) |
| `state` | Lifecycle state (see state machine below) |
| `jobId` | Correlates with the Temporal workflow execution that owns the current run |
| `errorMessage` | Human-readable failure reason when `state = 'errored'` |
| `summary` | JSONB payload whose shape is defined by the facet type |
| `lastUpdated` | Timestamp of last write (TypeORM `@UpdateDateColumn`) |

The `(projectId, entityType, entityId, facetType)` composite unique constraint ensures one facet row per entity per type. The `entityType` column is `varchar(50)`, not a Postgres enum, so new entity types can be added without migrations.

## State Machine

```
            ┌──────────────┐
     create │              │ startFacetJob
   ─────────► in_progress  ◄────────┐
            │  (jobId set) │        │
            └──────┬───────┘        │
                   │                │
         ┌─────────┼─────────┐      │
         │ success │         │ fail │
         ▼         │         ▼      │
   ┌──────────┐    │   ┌──────────┐ │
   │  ready   │    │   │ errored  │─┘ (retry)
   │ (summary │    │   │ (error   │
   │  filled) │    │   │  message)│
   └──────────┘    │   └──────────┘
         │         │
         └─────────┘
          re-run
```

**Transitions:**

| From | To | Trigger |
|---|---|---|
| (none) | `in_progress` | `startFacetJob` or `upsertFacet` |
| `in_progress` | `ready` | `updateFacetState(state='ready', summary={...})` |
| `in_progress` | `errored` | `updateFacetState(state='errored', errorMessage='...')` |
| `ready` / `errored` | `in_progress` | `startFacetJob` (new run) |

When a facet transitions to `ready`, the `jobId` is cleared and the `summary` payload is set. When it transitions to `errored`, the `jobId` is cleared but any prior `summary` from a previous successful run is preserved.

## FacetService API

All methods are static on `FacetService` (no class instance needed).

### Read methods

```typescript
// Get all facets for an entity
FacetService.listFacets(projectId, entityType, entityId): Promise<Facet[]>

// Batch-load facets for multiple entities (single SQL query)
FacetService.listFacetsBatch(projectId, entityType, entityIds): Promise<Map<string, Facet[]>>

// Get a single facet by type
FacetService.getFacet(projectId, entityType, entityId, facetType): Promise<Facet | null>
```

### Write methods

```typescript
// Simple create-or-update (last writer wins, no jobId guard)
FacetService.upsertFacet(projectId, entityType, entityId, facetType, {
  state, jobId?, errorMessage?, summary?
}): Promise<Facet>

// Guarded state transition with optional jobId validation
FacetService.updateFacetState(projectId, entityType, entityId, facetType, state, {
  jobId?, errorMessage?, summary?, expectedJobId?
}): Promise<Facet>

// Atomic start: only transitions if NOT already in_progress (Layer 1 guard)
FacetService.startFacetJob(projectId, entityType, entityId, facetType, jobId):
  Promise<{ started: boolean; facet: Facet }>

// Lazy backfill: INSERT ON CONFLICT DO NOTHING (for retroactive enrichment)
FacetService.lazyBackfill(projectId, entityType, entityId, facetType, summary):
  Promise<Facet | null>

// Cleanup all facets for a project (called on project deletion)
FacetService.deleteForProject(projectId): Promise<number>
```

### Concurrency guards

Three layers of protection prevent race conditions:

1. **Layer 1 — `startFacetJob`**: Atomic SQL `UPDATE ... WHERE state != 'in_progress'`. Prevents two concurrent jobs from both claiming ownership.

2. **Layer 2 — `upsertFacet`**: `INSERT ON CONFLICT DO NOTHING` followed by `SELECT + UPDATE`. Safe for concurrent creation; last writer wins for updates.

3. **Layer 3 — `updateFacetState` with `expectedJobId`**: If the caller provides `expectedJobId` and the facet is `in_progress` with a different `jobId`, a `ConflictError` is thrown. This prevents a stale job from overwriting a newer one.

## REST Endpoints

### Per-entity facet routes (pattern: datasets, knowledge bases)

```
GET  /api/v1/projects/:pid/datasets/:id/facets           → listFacets
GET  /api/v1/projects/:pid/datasets/:id/facets/:type      → getFacet
PUT  /api/v1/projects/:pid/datasets/:id/facets/:type      → updateFacetState
POST /api/v1/projects/:pid/datasets/:id/facets/:type/run  → startFacetJob
```

### Project-level facet routes

```
GET /api/v1/projects/:pid/facets/:type → getFacet (entityType='project', entityId=pid)
```

### Internal (workflow-engine) routes

```
PUT /api/v1/internal/reference-edges/lineage-facet/:pid → upsertFacet for lineage graph
```

## Existing Usages

| Entity Type | Facet Type | Producer | Summary Shape |
|---|---|---|---|
| `dataset` | `pii` | PII scan workflow | `{ totalFiles, filesScanned, piiDetected, riskLevel, ... }` |
| `dataset` | `embedding` | Embedding job | `{ totalChunks, model, dimensions, ... }` |
| `knowledge_base` | `indexing` | KB indexing workflow | `{ documentsIndexed, chunksCreated, ... }` |
| `project` | `lineage` | BuildLineageGraphActivity | `{ nodes, edges, counts, truncated }` |

## Extension Patterns

### Adding a new facet type for an existing entity

1. Define the `summary` JSON shape in documentation or types.
2. Use the existing REST routes — no code changes needed in FacetService or routes.
3. If the facet is produced by a background job, use `startFacetJob` → (work) → `updateFacetState('ready', { summary })`.
4. If the facet is produced synchronously, use `upsertFacet` directly.

### Adding a new entity type

1. Add the entity type string to `FacetEntityType` in `models/Facet.ts` (e.g. `'pipeline'`).
2. Add REST routes following the dataset pattern: `GET/PUT .../:id/facets/:facetType`.
3. No migration needed — `entityType` is `varchar(50)`.

### Cleanup

Always call `FacetService.deleteForProject(projectId)` in the project deletion handler to remove orphaned facet rows. For entity-level cleanup, filter by `(projectId, entityType, entityId)` as needed.

## Design Trade-offs

- **Single table vs. per-type tables**: The generic JSONB column sacrifices type safety at the database level but avoids schema proliferation. TypeScript types and runtime validation compensate.
- **No foreign keys**: `entityId` is not FK-constrained to any entity table. This is intentional — facets can outlive their parent entity briefly during deletion (cleaned up explicitly), and it avoids cross-table locking.
- **State enum in Postgres**: The `state` column uses a Postgres enum (`facet_state`), which requires a migration to add new states. This is acceptable since the three states (`in_progress`, `ready`, `errored`) cover all known use cases.

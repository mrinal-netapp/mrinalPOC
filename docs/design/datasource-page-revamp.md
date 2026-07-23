# DataSource Page Revamp: Unified Landing, Flat Volumes, and Batch Explorer Actions

## Status

**In Progress** | May 2026. Extends [connectors.md](connectors.md) and [connector-explorer.md](connector-explorer.md).

## Problem Statement

The current Data Sources landing page (`/projects/:id/datasources`) is a card-based hub that shows summary counts for connectors and volumes with "Manage" buttons that navigate to separate pages. This adds a click to every interaction and fragments what is conceptually a single view — the project's external data surface — across three routes.

Specific problems:

1. **Extra navigation hop**: Users click "Manage Connectors" or "Manage Volumes" every time. The cards show stale "recent" lists that provide no actionable information. Power users bookmark the sub-pages directly, making the landing page dead weight.

2. **Volume table expanded view is noise**: Each volume row expands to show endpoint, auth type, mount options, and timestamps. In practice, users rarely need this information inline — they either know it already or use the Edit dialog. The expand/collapse interaction adds visual clutter and a click target that competes with the action buttons.

3. **Single-volume ONTAP registration is tedious**: The connector explorer lets users browse ONTAP SVMs and volumes, but registering a volume requires: select volume → click "Register volume…" → navigate to volumes page → fill out form → submit → navigate back to explorer → repeat. For clusters with dozens of volumes, this is unusable.

4. **No batch actions from explorer**: The explorer is read-only beyond the single "Register volume…" button. There is no framework for "select multiple nodes, configure, and apply" — a pattern needed for volume registration today and dataset import tomorrow.

## Goals

- **Single-page experience**: Connectors and volumes on one page, each in a collapsible section, with all CRUD actions inline.
- **Flat volume table**: Remove the expanded detail row. Keep the table scannable.
- **Batch explorer actions**: A generic queue sidebar in the explorer dialog that supports multi-select, per-item configuration, and sequential apply. The first use case is ONTAP volume registration; the architecture supports future use cases (database dataset import, object store dataset import) without framework changes.
- **Preserve existing flows**: The ONTAP single-volume prefill via `location.state` continues to work. Non-ONTAP connectors keep their existing explorer behavior.

## Design Overview

The change has two parts.

**Part A** replaces the card-based landing page with a unified page. Two self-contained listing components (`ConnectorListing` and `VolumeListing`) are extracted from the existing page components and composed under Fluent UI `Accordion` sections. The volume table becomes flat (no expand/collapse). Routes are updated so `/datasources/volumes` and `/datasources/connectors` render the same unified page (preserving `location.state` for the ONTAP prefill flow).

**Part B** introduces a generic explorer action queue. A strategy interface (`ExplorerActionStrategy`) defines how to convert explorer nodes into queue items, validate them, render editable fields, and apply them. A hook (`useExplorerActionQueue`) manages queue state. A UI component (`ExplorerActionQueue`) renders the sidebar. The first concrete strategy (`OntapVolumeRegistrationStrategy`) implements ONTAP volume registration. Adding a new action domain (e.g., database dataset import) requires only a new strategy file and wiring it into the explorer dialog.

## Part A: Unified DataSource Page

### Current architecture

```
ProjectDataSources (card hub)
  ├── navigate → ProjectConnectors (tree + 20 hooks + 5 dialogs, ~1300 lines)
  └── navigate → ProjectBuckets (table + 15 hooks + 4 dialogs, ~500 lines)
                    └── BucketTable (expandable rows)
                          └── BucketDetails (endpoint, auth, mount opts, timestamps)
```

### New architecture

```
ProjectDataSources (unified page, accordion sections)
  ├── <Accordion> Connectors
  │     └── <ConnectorListing projectId onResourcesRegistered />
  │           (self-contained: tree, search, all dialogs/wizards/explorer)
  └── <Accordion> Volumes
        └── <VolumeListing projectId initialPrefill refreshKey />
              (self-contained: flat table, all dialogs/explorer/repair)
              └── BucketTable (flat, no expand)
```

### Component extraction strategy

The existing page components (`ProjectConnectors.tsx`, `ProjectBuckets.tsx`) are large but self-contained — they manage their own state, API calls, and dialogs. Rather than splitting them into many small pieces, we extract each as a single component that takes `projectId` as its primary prop. This keeps the refactor mechanical (move code, replace `useParams` with prop) and avoids introducing new state management patterns.

The original page files become thin wrappers (`useParams` → prop) for backward compatibility with any deep links.

### Cross-section communication

When the connector explorer's batch queue creates volumes, the volume listing needs to refresh. This is handled through the parent page:

1. `ConnectorListing` receives `onResourcesRegistered` callback
2. After batch apply completes, it calls the callback
3. `ProjectDataSources` increments a `volumeRefreshKey` counter
4. `VolumeListing` receives the new `refreshKey` and triggers a reload via `useEffect`

This avoids shared context or event buses — the data flow is explicit and unidirectional.

### Flat volume table

The `BucketTable` component loses its expand/collapse mechanism: the chevron column, `expandedBuckets` state, `toggleBucketExpand` handler, and the `BucketDetails` row are removed. The resulting table has seven columns: Name, Region, Protocol, Volume Type, Mount, Assignments, Actions.

`BucketTable` is also used in `ProjectDetail.tsx` for the "Recent Buckets" card. Since it passes no expand-specific props, the flat table works there without changes.

### Routing

The three routes (`/datasources`, `/datasources/volumes`, `/datasources/connectors`) all render the same `ProjectDataSources` component. This is intentional: the ONTAP single-volume registration flow navigates to `/datasources/volumes` with `location.state` containing prefill data. Using a `<Navigate>` redirect would drop the state. Rendering the same component preserves it, and `ProjectDataSources` reads the state, passes it to `VolumeListing` as `initialPrefill`, and clears it.

## Part B: Generic Explorer Action Queue

### Motivation

The ONTAP volume registration problem is an instance of a general pattern: browse a remote system in the explorer, select resources, configure them locally, and batch-create project entities. The same pattern applies to:

- **Database tables → datasets**: Browse schemas/tables, select multiple, configure format and schedule, batch-create datasets
- **Object store prefixes → datasets**: Browse buckets/prefixes, select, configure, batch-create
- **Cloud resources → connectors**: Browse services, select, batch-create sub-connectors

Building the queue mechanism as a generic framework avoids reimplementing state management, sequential apply with status tracking, and sidebar UI for each new use case.

### Three-layer architecture

```
ExplorerActionStrategy<T>          (interface — domain-specific logic)
  ↓ used by
useExplorerActionQueue<T>          (hook — generic state + orchestration)
  ↓ drives
ExplorerActionQueue<T>             (component — generic sidebar UI)
```

**Layer 1: `ExplorerActionStrategy<T>`** defines what to do. Each domain implements:
- `nodeToQueueItem(node, context)` — convert explorer node to queue item with auto-derived defaults
- `validateItem(item, allItems, existingNames)` — return null if valid, or an error string
- `renderItemFields(item, onUpdate, error)` — render the editable fields for one item
- `applyItem(item, context)` — execute the domain-specific create call

Plus metadata: `actionLabel`, `itemNoun`, `selectableNodeTypes`.

**Layer 2: `useExplorerActionQueue<T>`** manages state. It tracks the queue items, derives `selectedNodeIds` for explorer checkboxes, and orchestrates `applyAll` (sequential iteration with per-item status updates). It knows nothing about volumes, datasets, or any specific domain.

**Layer 3: `ExplorerActionQueue<T>`** renders the sidebar. It shows item cards (delegating field rendering to the strategy), validation errors, status indicators, a "Clear all" link, and a sticky "Apply N of M" footer button. It is strategy-agnostic.

### First strategy: ONTAP volume registration

`OntapVolumeRegistrationStrategy` converts ONTAP volume explorer nodes into queue items using the existing `bucketFormPrefillFromOntapVolume` and `validateOntapVolumeMountReady` utilities. Each item has editable name and NFS endpoint fields, with mount options in a collapsible "Advanced" section. `applyItem` builds a `CreateDataSourceRequest` and calls `datasourceApi.create`.

### ConnectorExplorer imperative handle

The "Add all eligible" button in the sidebar needs access to the explorer's currently visible nodes. Rather than lifting the explorer's internal tree state, we add a `useImperativeHandle` exposing `getVisibleNodes(typeFilter?)`, which filters the existing `flatVisibleNodes` memo. The caller can then filter by validation and add eligible nodes to the queue in bulk.

### Queue state lifecycle

The queue state lives in `ConnectorListing`, not inside the explorer dialog. Closing the dialog hides it but does not destroy the queue. Reopening the same connector restores it. Switching to a different connector clears the queue. This prevents accidental data loss from dialog dismissal.

## Decision Log

### Rejected: Shared state context for cross-section refresh

An earlier iteration proposed a React context shared between `ConnectorListing` and `VolumeListing` for signaling refreshes. Rejected because:
- Adds a provider/consumer pattern for a single boolean signal
- Makes the data flow implicit
- A simple callback + key counter achieves the same result with explicit, traceable data flow

### Rejected: `initialPrefill` as `BucketFormData[]` (array)

Multi-volume registration was initially expected to pass an array of prefill items through `location.state` to `VolumeListing`. Rejected because:
- Multi-volume registration happens entirely within the explorer dialog (inside `ConnectorListing`) — it never navigates away
- The `location.state` prefill path is only used for the legacy single-volume flow
- Changing the type to an array adds complexity for no benefit

### Rejected: Volume-specific queue component

The first design had a `VolumeRegistrationQueue` component with volume-specific props (`clusterUrl`, `queuedVolumes: QueuedVolume[]`). Rejected in favor of the generic `ExplorerActionQueue<T>` + strategy pattern because:
- Database dataset import would need an equivalent `DatasetRegistrationQueue` with near-identical state management and UI chrome
- The strategy pattern isolates domain-specific logic in small, testable files
- The queue hook and UI component are written once and reused

### Rejected: Redirecting `/datasources/volumes` to `/datasources`

Using `<Navigate replace>` for the sub-routes would be simpler but drops `location.state`, breaking the ONTAP single-volume prefill flow. Rendering the same component at all three paths preserves state while achieving the same visual result.

## Future Work

- **Database dataset strategy**: When the dataset wizard supports batch import from database connectors, add a `DatabaseDatasetStrategy` implementing `ExplorerActionStrategy`. The explorer already supports `selectionMode: 'multi'` and `selectableTypes` from the `DataAccessModel` in the provider catalog — the same infrastructure the queue uses.
- **Object store dataset strategy**: Similar pattern for S3/GCS/Azure Blob prefix selection.
- **Drag-and-drop reordering**: Queue items could support drag-and-drop for priority ordering in future batch workflows.

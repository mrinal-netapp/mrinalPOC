import { apiSlice } from './api.slice';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query/react';
import type {
  PaginatedResponse,
} from './api.types';
import type {
  DatasetAcquireResponse,
  DatasetCreateRequest,
  DatasetDetail,
  DatasetKBListResponse,
  DatasetListItem,
  DatasetListParams,
  DatasetManifest,
  DatasetManifestStatus,
  DatasetSnapshotListResponse,
  DatasetSnapshotUpdateRequest,
  DatasetUpdateRequest,
} from './dataset.types';
import { normalizeDataset, normalizeDatasetListItem, normalizeKBListItem, normalizeManifest, normalizeSnapshot, toBackendAcquisitionConfig, toBackendDatabaseSourceFields, toBackendFilterSpec, toBackendRefreshConfig } from './dataset.mapper';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function isNotFoundError(error: FetchBaseQueryError | undefined): boolean {
  return error?.status === 404;
}

function urlBase(projectId: string): string {
  return `/projects/${projectId}/datasets`;
}

type ListDatasetSnapshotsArg = { projectId: string; dsetId: string };

const listDatasetSnapshotsSelector: {
  select?: (arg: ListDatasetSnapshotsArg) => (state: unknown) => { data?: DatasetSnapshotListResponse };
} = {};

const datasetApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    // -- Queries --

    listDatasets: builder.query<
      PaginatedResponse<DatasetListItem>,
      { projectId: string } & Partial<DatasetListParams>
    >({
      query: ({ projectId, limit, offset, search }) => ({
        url: urlBase(projectId),
        // Backend uses 'skip' not 'offset', and 'nameRegex' not 'search'.
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { skip: offset } : {}),
          ...(search ? { nameRegex: search } : {}),
        },
      }),
      transformResponse: (response: unknown): PaginatedResponse<DatasetListItem> => {
        const raw: unknown[] = Array.isArray(response)
          ? response
          : Array.isArray((response as { data?: unknown[] } | null)?.data)
            ? (response as { data: unknown[] }).data
            : [];
        const data = raw.map(normalizeDatasetListItem);
        return { data, pagination: { limit: data.length, offset: 0, total_count: data.length } };
      },
      providesTags: (result) =>
        result
          ? [
            { type: 'Dataset', id: 'LIST' },
            ...result.data.map((item) => ({
              type: 'Dataset' as const,
              id: item.dset_id,
            })),
          ]
          : [{ type: 'Dataset', id: 'LIST' }],
    }),

    getDataset: builder.query<DatasetDetail, { projectId: string; dsetId: string }>({
      query: ({ projectId, dsetId }) => `${urlBase(projectId)}/${dsetId}`,
      transformResponse: (raw: unknown): DatasetDetail => normalizeDataset(raw),
      providesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetDetail', id: dsetId },
      ],
    }),

    listDatasetSnapshots: builder.query<
      DatasetSnapshotListResponse,
      { projectId: string; dsetId: string }
    >({
      // 404 is expected when the dataset is missing. 409 is expected while import/sync is
      // in progress or before a catalog table exists;
      queryFn: async ({ projectId, dsetId }, api, _extra, baseQuery) => {
        const result = await baseQuery({ url: `${urlBase(projectId)}/${dsetId}/snapshots` });
        const status = (result.error as { status?: number } | undefined)?.status;
        if (result.error && status === 404) {
          return { data: { dataset_id: dsetId, snapshots: [] } };
        }
        if (result.error && status === 409) {
          const cached = listDatasetSnapshotsSelector.select?.({ projectId, dsetId })?.(api.getState())?.data;
          if (cached) {
            return { data: cached };
          }
          return { data: { dataset_id: dsetId, snapshots: [] } };
        }
        if (result.error) return { error: result.error };

        const raw = (result.data ?? {}) as Record<string, unknown>;
        const currentSnapshotId: number | null = typeof raw.currentSnapshotId === 'number' ? raw.currentSnapshotId : null;
        const rawSnapshots: unknown[] = Array.isArray(raw.snapshots) ? raw.snapshots : [];

        // Sort oldest → newest so version numbers are stable across calls.
        const sorted = [...rawSnapshots].sort((a, b) =>
          Number((a as { timestampMs?: number }).timestampMs ?? 0) -
          Number((b as { timestampMs?: number }).timestampMs ?? 0));
        const snapshots = sorted.map((s, idx) => normalizeSnapshot(s, idx, currentSnapshotId));

        return { data: { dataset_id: dsetId, snapshots } };
      },
      providesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetSnapshots', id: dsetId },
      ],
    }),

    listDatasetKnowledgeBases: builder.query<
      DatasetKBListResponse,
      { projectId: string; dsetId: string }
    >({
      // Returns raw KnowledgeBase entities (id, camelCase fields). normalizeKBListItem
      // tolerates both the raw entity shape and pre-mapped (kb_id, snake_case) shapes.
      // 404 is tolerated (empty list) when the route is temporarily unavailable.
      queryFn: async ({ projectId, dsetId }, _api, _extra, baseQuery) => {
        const result = await baseQuery(`${urlBase(projectId)}/${dsetId}/knowledge-bases`);
        if (result.error && (result.error as { status?: number }).status === 404) {
          return { data: { dataset_id: dsetId, knowledge_bases: [] } };
        }
        if (result.error) return { error: result.error };

        const raw = (result.data ?? {}) as Record<string, unknown>;
        const rawList: unknown[] = Array.isArray(raw.knowledge_bases) ? raw.knowledge_bases : [];
        return {
          data: {
            dataset_id: (raw.dataset_id as string | undefined) ?? dsetId,
            knowledge_bases: rawList.map(normalizeKBListItem),
          },
        };
      },
      providesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetKBs', id: dsetId },
      ],
    }),

    // Lists every manifest (with its files) for a dataset. The committed manifest
    // is the "live" file set; a draft is a staged batch awaiting commit. Used by
    // the edit form to show/merge existing manual-upload files.
    // 404 → empty list (dataset has no manifests yet).
    listDatasetManifests: builder.query<
      DatasetManifest[],
      { projectId: string; dsetId: string }
    >({
      queryFn: async ({ projectId, dsetId }, _api, _extra, baseQuery) => {
        const result = await baseQuery(`${urlBase(projectId)}/${dsetId}/manifests`);
        if (isNotFoundError(result.error)) {
          return { data: [] };
        }
        if (result.error) return { error: result.error };
        const raw = result.data;
        const wrapped = asRecord(raw);
        const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(wrapped.data) ? wrapped.data : [];
        return { data: list.map(normalizeManifest) };
      },
      providesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetManifests', id: dsetId },
      ],
    }),

    // -- Mutations --

    createDataset: builder.mutation<
      DatasetDetail,
      { projectId: string; body: DatasetCreateRequest }
    >({
      // Frontend field → Backend field
      //   input_type ('data-source'|'upload')            → type ('acquired'|'manual')
      //   data_source_id + data_source_origin_kind='volume'     → originVolume
      //   data_source_id + data_source_origin_kind='connector'  → originConnector
      //   spec                                           → filterSpec
      //   description (may be undefined)                 → description (NOT NULL — default to '')
      //   (missing)                                      → kind (required; form sends explicitly)
      //   refresh_config                                 → scheduleConfig { cronExpression, timezone, enabled }
      //   labels                                         → labels (string[] | undefined)
      queryFn: async ({ projectId, body }, _api, _extra, baseQuery) => {
        // data_source_origin_kind is derived by the form from the selected source's
        // category; when absent we default to the volume origin.
        const isConnector = body.data_source_origin_kind === 'connector';
        const sqlQuery = body.sql_query?.trim();
        const filterSpec = toBackendFilterSpec(body.spec);
        const acquisitionConfig = toBackendAcquisitionConfig(body.spec);
        const databaseSourceFields = toBackendDatabaseSourceFields(body.resource_selector);
        const backendBody = {
          name: body.name,
          description: body.description ?? '',
          type: body.input_type === 'upload' ? 'manual' : 'acquired',
          ...(body.data_source_id
            ? isConnector
              ? { originConnector: body.data_source_id }
              : { originVolume: body.data_source_id }
            : {}),
          kind: body.kind,
          ...(sqlQuery ? { sqlQuery } : {}),
          // filterSpec keeps the form-shaped keys (for edit round-trip) plus the
          // sourcePath the workflow reads; acquisitionConfig carries the file
          // filters the acquisition workflow actually honours (include/exclude
          // patterns, max size, modified-after).
          ...(filterSpec ? { filterSpec } : {}),
          ...(acquisitionConfig ? { acquisitionConfig } : {}),
          // Connector-resource selectors (object store / database / metrics).
          // Volume sources use filterSpec.paths instead and leave this empty.
          ...(body.resource_selector?.length ? { resourceSelector: body.resource_selector } : {}),
          ...databaseSourceFields,
          // Send the rich refreshConfig; the backend derives + persists scheduleConfig
          // from it (applyRefreshConfig) and round-trips the full schedule on edit.
          ...(body.refresh_config
            ? { refreshConfig: toBackendRefreshConfig(body.refresh_config) }
            : {}),
          ...(body.labels?.length ? { labels: body.labels } : {}),
        };
        const result = await baseQuery({ url: urlBase(projectId), method: 'POST', body: backendBody });
        if (result.error) return { error: result.error };
        return { data: normalizeDataset(result.data) };
      },
      invalidatesTags: (_result, _error, { body }) => [
        { type: 'Dataset', id: 'LIST' },
        ...(body.data_source_id
          ? [{ type: 'DataSourceDatasets' as const, id: body.data_source_id }]
          : []),
      ],
    }),

    updateDataset: builder.mutation<
      DatasetDetail,
      { projectId: string; dsetId: string; body: DatasetUpdateRequest }
    >({
      // PUT /:id calls DataSetService.updateDataSet() — the full update path.
      // PATCH /:id only handles acquisitionConfig + scheduleConfig (workflow-internal).
      queryFn: async ({ projectId, dsetId, body }, _api, _extra, baseQuery) => {
        const backendBody: Record<string, unknown> = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          // When the scope changed, send the augmented filterSpec (form keys +
          // sourcePath) and the derived acquisitionConfig file filters. On update
          // we emit empty include/exclude patterns so cleared filters are
          // overwritten rather than left stale.
          ...(body.spec !== undefined ? { filterSpec: toBackendFilterSpec(body.spec) } : {}),
          ...(body.spec !== undefined
            ? { acquisitionConfig: toBackendAcquisitionConfig(body.spec, { explicitClears: true }) ?? {} }
            : {}),
          ...(body.sql_query !== undefined ? { sqlQuery: body.sql_query } : {}),
          // Connector-resource selectors. Sent whenever provided (including an
          // empty array) so cleared connector selections overwrite stale values.
          ...(body.resource_selector !== undefined ? { resourceSelector: body.resource_selector } : {}),
          ...(body.resource_selector !== undefined
            ? toBackendDatabaseSourceFields(body.resource_selector, { explicitClears: true })
            : {}),
          ...(body.refresh_config !== undefined
            ? { refreshConfig: toBackendRefreshConfig(body.refresh_config) }
            : {}),
          ...(body.data_source_id !== undefined
            ? body.data_source_origin_kind === 'connector'
              ? { originConnector: body.data_source_id }
              : { originVolume: body.data_source_id }
            : {}),
          ...(body.deprecated !== undefined ? { deprecated: body.deprecated } : {}),
          ...(body.labels !== undefined ? { labels: body.labels } : {}),
          // Manual-upload files → backend `uploadedFiles`; backend creates/replaces
          // the draft manifest and auto-commits the first batch (triggers import).
          ...(body.uploaded_files !== undefined ? { uploadedFiles: body.uploaded_files } : {}),
        };
        const result = await baseQuery({ url: `${urlBase(projectId)}/${dsetId}`, method: 'PUT', body: backendBody });
        if (result.error) return { error: result.error };
        return { data: normalizeDataset(result.data) };
      },
      invalidatesTags: (_result, _error, { dsetId }) => [
        { type: 'Dataset', id: dsetId },
        { type: 'DatasetDetail', id: dsetId },
        { type: 'DatasetManifests', id: dsetId },
      ],
    }),

    // Sets a manifest's status. Committing a draft (draft → committed) makes the
    // backend write the manifest to S3 and trigger the dataset import workflow.
    // This is the explicit "finish upload" step the edit flow needs (create mode
    // auto-commits the first batch, but edit mode does not).
    updateDatasetManifestStatus: builder.mutation<
      DatasetManifest,
      { projectId: string; dsetId: string; manifestId: string; status: DatasetManifestStatus }
    >({
      queryFn: async ({ projectId, dsetId, manifestId, status }, _api, _extra, baseQuery) => {
        const result = await baseQuery({
          url: `${urlBase(projectId)}/${dsetId}/manifests/${manifestId}/status`,
          method: 'PUT',
          body: { status },
        });
        if (result.error) return { error: result.error };
        return { data: normalizeManifest(result.data) };
      },
      async onQueryStarted({ projectId, dsetId, status }, { dispatch, queryFulfilled }) {
        if (status !== 'committed') return;
        const patch = dispatch(
          datasetApi.util.updateQueryData('getDataset', { projectId, dsetId }, (draft) => {
            draft.lifecycle_status = 'in_progress';
            draft.status = 'Importing';
          }),
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_result, _error, { dsetId }) => [
        { type: 'Dataset', id: dsetId },
        { type: 'DatasetDetail', id: dsetId },
        { type: 'DatasetManifests', id: dsetId },
        { type: 'DatasetSnapshots', id: dsetId },
      ],
    }),

    triggerDatasetSync: builder.mutation<void, { projectId: string; dsetId: string }>({
      query: ({ projectId, dsetId }) => ({
        url: `${urlBase(projectId)}/${dsetId}/acquire`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetDetail', id: dsetId },
        { type: 'DatasetSnapshots', id: dsetId },
      ],
    }),

    deleteDataset: builder.mutation<
      void,
      { projectId: string; dsetId: string; dsrcId?: string }
    >({
      query: ({ projectId, dsetId }) => ({
        url: `${urlBase(projectId)}/${dsetId}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { dsetId, dsrcId }) => [
        { type: 'Dataset', id: 'LIST' },
        { type: 'DatasetDetail', id: dsetId },
        ...(dsrcId
          ? [{ type: 'DataSourceDatasets' as const, id: dsrcId }]
          : []),
      ],
    }),

    // POST /datasets/:id/acquire — served by workflow-engine.
    // Manually triggers a one-shot data acquisition Temporal workflow which creates a new snapshot.
    // This is the "Scan dataset" / on-demand snapshot creation action.
    createDatasetSnapshot: builder.mutation<DatasetAcquireResponse, { projectId: string; dsetId: string }>({
      query: ({ projectId, dsetId }) => ({
        url: `${urlBase(projectId)}/${dsetId}/acquire`,
        method: 'POST',
      }),
      invalidatesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetSnapshots', id: dsetId },
        { type: 'DatasetDetail', id: dsetId },
      ],
    }),

    updateDatasetSnapshot: builder.mutation<
      void,
      { projectId: string; dsetId: string; snapshotId: string; body: DatasetSnapshotUpdateRequest }
    >({
      // Routes to the correct dedicated backend endpoint based on the action:
      //   is_current: true  → POST /:id/snapshots/:snapshotId/set-current  (rollback)
      //   deprecated: true  → POST /:id/snapshots/:snapshotId/expire        (remove/expire)
      //   deprecated: false → restore/un-expire — DISABLED (no backend support yet, see below);
      //                        UI may still render "Restore" for expired rows, but clicking it
      //                        shows a not-supported message and does not call this mutation path.
      queryFn: async ({ projectId, dsetId, snapshotId, body }, _api, _extra, baseQuery) => {
        if (body.is_current) {
          const result = await baseQuery({
            url: `${urlBase(projectId)}/${dsetId}/snapshots/${snapshotId}/set-current`,
            method: 'POST',
          });
          if (result.error) return { error: result.error };
          return { data: undefined };
        }
        if (body.deprecated === true) {
          const result = await baseQuery({
            url: `${urlBase(projectId)}/${dsetId}/snapshots/${snapshotId}/expire`,
            method: 'POST',
          });
          if (result.error) return { error: result.error };
          return { data: undefined };
        }
        // deprecated: false (restore/un-expire) — disabled.
        // POST /restore-version rolls back dataset *config* (name, schedule, labels), not
        // the Iceberg snapshot data. Calling it here would corrupt unrelated dataset settings
        // without actually un-expiring the snapshot in the Iceberg catalog.
        // Additionally, row.version is a client-side counter (idx+1), not a real snapshot ID.
        // Re-enable when the backend ships a dedicated un-expire endpoint.
        //
        // if (body.deprecated === false) {
        //   const result = await baseQuery({
        //     url: `/datasets/${dsetId}/restore-version`,
        //     method: 'POST',
        //     body: { version: body.version },
        //   });
        //   if (result.error) return { error: result.error };
        //   return { data: undefined };
        // }
        return {
          error: {
            status: 'CUSTOM_ERROR',
            error: 'Unsupported snapshot action — no matching backend endpoint.',
          } as const,
        };
      },
      invalidatesTags: (_result, _error, { dsetId }) => [
        { type: 'DatasetSnapshots', id: dsetId },
        { type: 'DatasetDetail', id: dsetId },
      ],
    }),
  }),
});

listDatasetSnapshotsSelector.select = datasetApi.endpoints.listDatasetSnapshots
  .select as NonNullable<typeof listDatasetSnapshotsSelector.select>;

// Endpoints now require `projectId` in args. Call sites read activeProjectId
// from the project-context slice and pass it explicitly.

export { datasetApi };
export const {
  useListDatasetsQuery,
  useGetDatasetQuery,
  useLazyGetDatasetQuery,
  useListDatasetSnapshotsQuery,
  useListDatasetKnowledgeBasesQuery,
  useListDatasetManifestsQuery,
  useLazyListDatasetManifestsQuery,
  useCreateDatasetMutation,
  useUpdateDatasetMutation,
  useUpdateDatasetManifestStatusMutation,
  useTriggerDatasetSyncMutation,
  useDeleteDatasetMutation,
  useCreateDatasetSnapshotMutation,
  useUpdateDatasetSnapshotMutation,
} = datasetApi;

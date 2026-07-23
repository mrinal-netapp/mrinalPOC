import { apiSlice } from './api.slice';
import type {
  DeprecationRequest,
  PaginatedResponse,
} from './api.types';
import type {
  DataSourceCreateRequest,
  DataSourceDatasetsResponse,
  DataSourceDeprecationResponse,
  DataSourceDetail,
  DataSourceFormCreateInput,
  DataSourceListItem,
  DataSourceListParams,
  DataSourceUpdateRequest,
  ScanConfig,
  StorageClass,
} from './data-source.types';
import { normalizeDataSource, resolveDatasetStatus } from './data-source.mapper';

function urlBase(projectId: string): string {
  return `/projects/${projectId}/datasources`;
}

// Volume data sources carry a client-generated id. Use the Web Crypto API for
// adequate entropy / collision-resistance (Math.random is predictable and can
// be restricted in hardened environments); only fall back when crypto is
// unavailable. Emits `vol-` + lowercase hex to stay URL/identifier-safe.
function generateVolumeId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(8));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `vol-${hex}`;
  }
  /* v8 ignore next -- Web Crypto is available in all supported browsers and jsdom */
  return `vol-${Math.random().toString(36).slice(2, 10)}`;
}

const dataSourceApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    // -- Queries --

    listDataSources: builder.query<
      PaginatedResponse<DataSourceListItem>,
      { projectId: string } & Partial<DataSourceListParams>
    >({
      query: ({ projectId, limit, offset, ...rest }) => ({
        url: urlBase(projectId),
        // Backend uses 'skip', not 'offset'. Strip all other unsupported params.
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { skip: offset } : {}),
          ...(rest.search ? { nameRegex: rest.search } : {}),
        },
      }),
      transformResponse: (response: unknown): PaginatedResponse<DataSourceListItem> => {
        const raw: unknown[] = Array.isArray(response)
          ? response
          : Array.isArray((response as { data?: unknown[] } | null)?.data)
            ? (response as { data: unknown[] }).data
            : [];
        const data = raw.map(normalizeDataSource);
        return { data, pagination: { limit: data.length, offset: 0, total_count: data.length } };
      },
      providesTags: (result) =>
        result
          ? [
            { type: 'DataSource', id: 'LIST' },
            ...result.data.map((item) => ({
              type: 'DataSource' as const,
              id: item.dsrc_id,
            })),
          ]
          : [{ type: 'DataSource', id: 'LIST' }],
    }),

    getDataSource: builder.query<DataSourceDetail, { projectId: string; dsrcId: string }>({
      query: ({ projectId, dsrcId }) => `${urlBase(projectId)}/${dsrcId}`,
      transformResponse: (raw: unknown): DataSourceDetail => normalizeDataSource(raw),
      providesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSourceDetail', id: dsrcId },
      ],
    }),

    listDataSourceDatasets: builder.query<
      DataSourceDatasetsResponse,
      { projectId: string; dsrcId: string }
    >({
      // Treat 404 gracefully (empty list) when the route is temporarily unavailable.
      // Backend response shape:   [ { id, name, status, createdAt, type, ... } ]
      // Frontend expected shape:  { data_source_id, datasets: [{ dset_id, name, status (FE enum),
      //                             created_at, file_scope, synchronization_schedule, labels }] }
      queryFn: async ({ projectId, dsrcId }, _api, _extra, baseQuery) => {
        const result = await baseQuery(`${urlBase(projectId)}/${dsrcId}/datasets`);
        if (result.error && (result.error as { status?: number }).status === 404) {
          return { data: { data_source_id: dsrcId, datasets: [] } };
        }
        if (result.error) return { error: result.error };

        const raw: unknown[] = Array.isArray(result.data) ? result.data : [];
        const datasets = raw.map((item) => {
          const d = (item ?? {}) as Record<string, unknown>;
          return {
          dset_id: ((d.id as string | undefined) ?? (d.dset_id as string | undefined) ?? ''),
          name: (d.name as string | undefined) ?? '',
          status: resolveDatasetStatus(d.status as string | undefined),
          created_at: (d.createdAt as string | undefined) ?? (d.created_at as string | undefined) ?? '',
          // Backend returns snake_case for these fields. Defaults guard against missing data.
          file_scope: typeof d.file_scope === 'number' ? d.file_scope : 0,
          synchronization_schedule: (d.synchronization_schedule as string | null | undefined) ?? null,
          labels: Array.isArray(d.labels) ? (d.labels as string[]) : [],
        }});

        return { data: { data_source_id: dsrcId, datasets } };
      },
      providesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSourceDatasets', id: dsrcId },
      ],
    }),

    // StorageClasses for dynamically provisioned volumes are sourced from the
    // deployments endpoint: each deployment exposes a `storage_classes` array,
    // which we flatten + dedupe into the dropdown options. Any error (incl. a
    // 404 on clusters without the route) yields an empty list so the Volume form
    // degrades gracefully to "No storage classes found".
    listStorageClasses: builder.query<StorageClass[], { projectId: string }>({
      // The deployments registry is not project-scoped, so collapse all args to
      // a single stable cache key — otherwise switching projects would trigger a
      // redundant refetch of identical data.
      serializeQueryArgs: () => 'listStorageClasses',
      queryFn: async (_arg, _api, _extra, baseQuery) => {
        const result = await baseQuery(`/deployments`);
        if (result.error) return { data: [] };
        // Accept a bare array, or a { data: [...] } / { deployments: [...] } wrapper.
        const payload = result.data as Record<string, unknown> | unknown[] | null;
        const raw: unknown[] = Array.isArray(payload)
          ? payload
          : Array.isArray((payload as { data?: unknown[] } | null)?.data)
            ? (payload as { data: unknown[] }).data
            : Array.isArray((payload as { deployments?: unknown[] } | null)?.deployments)
              ? (payload as { deployments: unknown[] }).deployments
              : [];
        const names = new Set<string>();
        const collect = (storageClasses: unknown): void => {
          if (!Array.isArray(storageClasses)) return;
          for (const sc of storageClasses) {
            if (typeof sc === 'string') {
              if (sc) names.add(sc);
            } else if (sc && typeof sc === 'object') {
              // Accept { name } or { storage_class_name } entries.
              const entry = sc as Record<string, unknown>;
              const name = (entry.name ?? entry.storage_class_name) as string | undefined;
              if (typeof name === 'string' && name) names.add(name);
            }
          }
        };
        for (const dep of raw) {
          const d = dep as Record<string, unknown> | null;
          // snake_case and camelCase variants of the storage classes field.
          collect(d?.storage_classes);
          collect(d?.storageClasses);
        }
        const data = [...names].map((name) => ({ name, provisioner: '' }));
        return { data };
      },
    }),

    // -- Mutations --

    createDataSource: builder.mutation<
      DataSourceDetail,
      { projectId: string; body: DataSourceFormCreateInput }
    >({
      // Frontend field → Backend field
      //   source_type ('NFS'|'SMB'|'S3')             → volume_config.protocol (lowercase)
      //   connection.server + export_path             → volume_config.volume_info.endpoint ("host:/path")
      //   connection.storage_class_name / storage_size / access_modes → volume_config.volume_info (dynamic)
      //   connection.auth_method / username / password → volume_config.auth_info
      // Volume sources do NOT send scan_config (scanning dropped from the contract).
      //
      // Connector-backed sources (Storage system, Object store, Database, API)
      // arrive with `body.connector` set. Those POST a `type: 'connector'` body
      // — connector_config (provider catalog fields) + credential_id — and skip
      // the volume mapping entirely.
      queryFn: async ({ projectId, body }, _api, _extra, baseQuery) => {
        // Scan mapping for connector-backed sources. Volume sources no longer
        // send scan_config (scanning was dropped from the volume contract).
        const scanConfig = body.scan_enabled && body.scan_config
          ? {
            scan_depth: body.scan_config.scan_depth,
            /* v8 ignore start -- dialog onChange guards custom_depth >= 1; || 1 is unreachable */
            custom_depth: body.scan_config.scan_depth === 'custom'
              ? (Number(body.scan_config.custom_depth) || 1)
              : null,
            /* v8 ignore stop */
          }
          : undefined;

        if (body.connector) {
          const connectorBody: DataSourceCreateRequest = {
            name: body.name,
            type: 'connector',
            description: body.description || undefined,
            labels: body.labels,
            connector_config: {
              scope: body.connector.scope,
              provider: body.connector.provider,
              connector_type: body.connector.connector_type,
              ...body.connector.config,
            },
            credential_id: body.connector.credential_id,
            scan_config: scanConfig,
          };
          const connectorResult = await baseQuery({ url: urlBase(projectId), method: 'POST', body: connectorBody });
          if (connectorResult.error) return { error: connectorResult.error };
          return { data: normalizeDataSource(connectorResult.data) };
        }

        // Fail fast rather than defaulting: a missing source_type here means the
        // volume protocol is unknown, so silently creating an NFS source would be
        // wrong. (Connector payloads are already handled by the branch above.)
        if (body.source_type == null) {
          return {
            error: {
              status: 'CUSTOM_ERROR',
              error: 'Cannot create volume data source: protocol (source_type) is missing.',
            },
          };
        }
        // Volume sources. The Volume tab supports two provisioning modes:
        //   static  ("Existing Volume") — register an existing NFS/SMB export.
        //   dynamic ("New Volume")      — provision a PVC from a StorageClass.
        // `connection.volume_type` ('NFS'|'SMB') drives the protocol; fall back to
        // stripping the legacy "NFSVolumes" suffix from source_type.
        const conn = body.connection;
        const mode: 'static' | 'dynamic' = conn.provisioning_mode === 'dynamic' ? 'dynamic' : 'static';
        const protocol = (conn.volume_type || body.source_type.replace(/volumes$/i, '')).toLowerCase();
        // Region is free-text (user types e.g. "us-east-1"); send it verbatim
        // and only fall back to 'default' when the field is empty.
        const region = conn.region || 'default';

        const volumeInfo =
          mode === 'dynamic'
            ? {
              type: protocol,
              provisioning_mode: 'dynamic' as const,
              storage_class_name: conn.storage_class_name || undefined,
              storage_size: conn.storage_size || undefined,
              // PVC access modes; NFS dynamic provisioning defaults to RWX.
              access_modes: conn.access_modes?.length ? conn.access_modes : ['ReadWriteMany'],
              mount_options: conn.mount_options?.length ? conn.mount_options : undefined,
            }
            : {
              type: protocol,
              provisioning_mode: 'static' as const,
              endpoint: conn.export_path ? `${conn.server}:${conn.export_path}` : conn.server,
              mount_options: conn.mount_options?.length ? conn.mount_options : undefined,
            };

        const backendBody: DataSourceCreateRequest = {
          // Backend expects a client-supplied id + the owning project on volumes.
          id: generateVolumeId(),
          project_id: projectId,
          name: body.name,
          type: 'volume',
          description: body.description || undefined,
          labels: body.labels?.length ? body.labels : undefined,
          metadata: conn.metadata && Object.keys(conn.metadata).length ? conn.metadata : undefined,
          volume_config: {
            region,
            protocol,
            volume_info: volumeInfo,
            auth_info: {
              type: conn.auth_type || conn.auth_method || 'none',
              username: conn.username || undefined,
              // Backend stores the credential as password_encrypted.
              password_encrypted: conn.password || undefined,
            },
          },
        };
        const result = await baseQuery({ url: urlBase(projectId), method: 'POST', body: backendBody });
        if (result.error) return { error: result.error };
        return { data: normalizeDataSource(result.data) };
      },
      invalidatesTags: [
        { type: 'DataSource', id: 'LIST' },
        { type: 'Credential', id: 'LIST' },
      ],
    }),

    updateDataSource: builder.mutation<
      DataSourceDetail,
      { projectId: string; dsrcId: string; body: DataSourceUpdateRequest }
    >({
      query: ({ projectId, dsrcId, body }) => ({
        url: `${urlBase(projectId)}/${dsrcId}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSource', id: dsrcId },
        { type: 'DataSourceDetail', id: dsrcId },
        { type: 'Credential', id: 'LIST' },
      ],
    }),

    // Persists the Test Connection outcome (connectors only) so the landing page
    // + edit form reflect the last result instead of "Untested". Best-effort:
    // callers tolerate failures (e.g. backend down) without blocking the save.
    recordConnectionTestResult: builder.mutation<
      DataSourceDetail,
      { projectId: string; dsrcId: string; success: boolean; message?: string }
    >({
      query: ({ projectId, dsrcId, success, message }) => ({
        url: `${urlBase(projectId)}/${dsrcId}/connection-test-result`,
        method: 'PATCH',
        body: { success, message },
      }),
      transformResponse: (raw: unknown): DataSourceDetail => normalizeDataSource(raw),
      invalidatesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSource', id: 'LIST' },
        { type: 'DataSource', id: dsrcId },
        { type: 'DataSourceDetail', id: dsrcId },
      ],
    }),

    deleteDataSource: builder.mutation<void, { projectId: string; dsrcId: string }>({
      query: ({ projectId, dsrcId }) => ({
        url: `${urlBase(projectId)}/${dsrcId}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSource', id: 'LIST' },
        { type: 'DataSourceDetail', id: dsrcId },
        { type: 'DataSourceDatasets', id: dsrcId },
      ],
    }),

    updateDataSourceDeprecation: builder.mutation<
      DataSourceDeprecationResponse,
      { projectId: string; dsrcId: string; body: DeprecationRequest }
    >({
      query: ({ projectId, dsrcId, body }) => ({
        url: `${urlBase(projectId)}/${dsrcId}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSource', id: dsrcId },
        { type: 'DataSourceDetail', id: dsrcId },
      ],
    }),

    // Caller must pass the live scan_config from the data source detail — passing a stale value will overwrite it.
    triggerManualScan: builder.mutation<
      DataSourceDetail,
      { projectId: string; dsrcId: string; scanConfig: ScanConfig }
    >({
      query: ({ projectId, dsrcId, scanConfig }) => ({
        url: `${urlBase(projectId)}/${dsrcId}/scan`,
        method: 'POST',
        body: { scan_config: scanConfig },
      }),
      invalidatesTags: (_result, _error, { dsrcId }) => [
        { type: 'DataSource', id: dsrcId },
        { type: 'DataSourceDetail', id: dsrcId },
      ],
    }),
  }),
});

// Endpoints now require `projectId` in args. Call sites read activeProjectId
// from the project-context slice via `useAppSelector(projectContextSelector.activeProjectId)`
// and pass it explicitly. See data-source-list.tsx for the pattern.

export { dataSourceApi };
export const {
  useListDataSourcesQuery,
  useLazyListDataSourcesQuery,
  useGetDataSourceQuery,
  useLazyGetDataSourceQuery,
  useListDataSourceDatasetsQuery,
  useListStorageClassesQuery,
  useCreateDataSourceMutation,
  useUpdateDataSourceMutation,
  useRecordConnectionTestResultMutation,
  useDeleteDataSourceMutation,
  useUpdateDataSourceDeprecationMutation,
  useTriggerManualScanMutation,
} = dataSourceApi;

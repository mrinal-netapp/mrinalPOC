import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

import { createMockStore } from '@test/mocks';
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from '@test/api-mock';
import { datasetApi } from './dataset-api.slice';
import type { DatasetCreateRequest } from './dataset.types';

const PROJECT_ID = 'test-project';

type TestStore = ReturnType<typeof createMockStore>;

function resultData<T>(result: unknown): T {
  return (result as { data: T }).data;
}

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0];
  if (typeof arg === 'string') return arg;
  return arg?.url ?? String(arg);
}

function calledMethod(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0];
  return arg?.method ?? 'GET';
}

async function calledBodyJson(mock: Mock): Promise<unknown> {
  const arg = mock.mock.calls[0]?.[0];
  if (arg instanceof Request) return arg.json();
  return arg?.body;
}

// Backend sends 'id', not 'dset_id'. The mapper (normalizeDatasetListItem /
// normalizeDataset) reads raw.id and surfaces it as dset_id on the frontend type.
const LIST_RESPONSE = {
  data: [
    { id: 'a', name: 'dataset-a' },
    { id: 'b', name: 'dataset-b' },
  ],
  pagination: { limit: 10, offset: 0, total_count: 2 },
};

const DETAIL_RESPONSE = { id: 'x', name: 'test-dataset' };

// Backend Iceberg snapshot shape — what the server actually returns
const SNAPSHOT_LIST_RESPONSE = {
  currentSnapshotId: 1000,
  snapshots: [
    {
      snapshotId: 900,
      parentSnapshotId: null,
      timestampMs: 1700000000000,
      summary: { 'total-data-files': '50', 'added-data-files': '50', operation: 'append' },
      operation: 'append',
      manifestList: null,
    },
    {
      snapshotId: 1000,
      parentSnapshotId: 900,
      timestampMs: 1700000100000,
      summary: { 'total-data-files': '60', 'added-data-files': '10', operation: 'append' },
      operation: 'append',
      manifestList: null,
    },
  ],
};

const KB_LIST_RESPONSE = {
  dataset_id: 'x',
  knowledge_bases: [{ kb_id: 'kb-1', name: 'kb-a' }],
};

const CREATE_BODY: DatasetCreateRequest = {
  name: 'new-dataset',
  input_type: 'data-source',
  kind: 'unstructured',
  data_source_id: 'dsrc-uuid-1',
  spec: { folder_scope: 'all' },
};

/** Covers `invalidatesTags` when `data_source_id` is omitted (no DataSourceDatasets tag). */
const CREATE_BODY_NO_DATA_SOURCE: DatasetCreateRequest = {
  name: 'upload-dataset',
  input_type: 'upload',
  kind: 'unstructured',
  spec: {},
};

describe('datasetApi', () => {
  let store: TestStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    store.dispatch(datasetApi.util.resetApiState());
    restoreAllMocks();
  });

  // -- Queries --

  describe('listDatasets', () => {
    it('[tag:dataset-api] should GET /datasets with query params — offset maps to skip', async () => {
      const mock = mockFetchSuccess(LIST_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.listDatasets.initiate({ projectId: PROJECT_ID, limit: 10, offset: 5 }),
      );

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      expect(url).toContain('/datasets');
      expect(url).toContain('limit=10');
      // The slice remaps offset → skip to match the backend query validator.
      expect(url).toContain('skip=5');
      expect(url).not.toContain('offset=');
    });

    it('[tag:dataset-api] should remap search → nameRegex in the query string', async () => {
      const mock = mockFetchSuccess(LIST_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.listDatasets.initiate({ projectId: PROJECT_ID, search: 'finance' }),
      );

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      // The slice remaps search → nameRegex to match the backend query validator.
      expect(url).toContain('nameRegex=finance');
      expect(url).not.toContain('search=');
    });

    it('[tag:dataset-api] should GET /datasets without params when void', async () => {
      const mock = mockFetchSuccess(LIST_RESPONSE);

      await store.dispatch(datasetApi.endpoints.listDatasets.initiate({ projectId: PROJECT_ID }));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets');
      expect(calledUrl(mock)).not.toContain('limit=');
    });

    it('[tag:dataset-api] should provide per-item Dataset tags when result has data', async () => {
      mockFetchSuccess(LIST_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.listDatasets.initiate({ projectId: PROJECT_ID, limit: 10 }),
      );

      const tags = store.getState().api.provided.tags;
      expect(tags.Dataset?.LIST).toBeDefined();
      expect(tags.Dataset?.a).toBeDefined();
      expect(tags.Dataset?.b).toBeDefined();
    });

    it('[tag:dataset-api] should provide only LIST tag when query errors', async () => {
      mockFetchError(500);

      await store.dispatch(
        datasetApi.endpoints.listDatasets.initiate({ projectId: PROJECT_ID, limit: 10 }),
      );

      const tags = store.getState().api.provided.tags;
      expect(tags.Dataset?.LIST).toBeDefined();
      expect(tags.Dataset?.a).toBeUndefined();
    });
  });

  describe('getDataset', () => {
    it('[tag:dataset-api] should GET /datasets/:id and provide DatasetDetail tag', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.getDataset.initiate({ projectId: PROJECT_ID, dsetId: 'dset-123' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-123');

      const tags = store.getState().api.provided.tags;
      expect(tags.DatasetDetail?.['dset-123']).toBeDefined();
    });
  });

  describe('listDatasetSnapshots', () => {
    it('[tag:dataset-api] should GET /datasets/:id/snapshots and provide DatasetSnapshots tag', async () => {
      const mock = mockFetchSuccess(SNAPSHOT_LIST_RESPONSE);

      const result = await store.dispatch(
        datasetApi.endpoints.listDatasetSnapshots.initiate({ projectId: PROJECT_ID, dsetId: 'dset-456' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-456/snapshots');

      const tags = store.getState().api.provided.tags;
      expect(tags.DatasetSnapshots?.['dset-456']).toBeDefined();

      // Verify backend → frontend shape transformation
      const data = resultData<{
        dataset_id: string;
        snapshots: Array<Record<string, unknown>>;
      }>(result);
      expect(data.dataset_id).toBe('dset-456');
      expect(data.snapshots).toHaveLength(2);
      // Sorted oldest→newest; snapshotId 900 becomes version 1
      expect(data.snapshots[0]).toMatchObject({
        id: '900',
        version: 1,
        status: 'completed',
        is_current: false,
        total_files: 50,
        files_added: 50,
      });
      // snapshotId 1000 is currentSnapshotId → is_current true
      expect(data.snapshots[1]).toMatchObject({
        id: '1000',
        version: 2,
        status: 'completed',
        is_current: true,
        total_files: 60,
        files_added: 10,
      });
    });

    it('[tag:dataset-api] should return empty list on 404 (no catalog table yet)', async () => {
      mockFetchError(404);

      const result = await store.dispatch(
        datasetApi.endpoints.listDatasetSnapshots.initiate({ projectId: PROJECT_ID, dsetId: 'dset-no-catalog' }),
      );

      expect(resultData(result)).toEqual({ dataset_id: 'dset-no-catalog', snapshots: [] });
    });

    it('[tag:dataset-api] should return empty list on 409 when no prior snapshot data is cached', async () => {
      mockFetchError(409);

      const result = await store.dispatch(
        datasetApi.endpoints.listDatasetSnapshots.initiate({ projectId: PROJECT_ID, dsetId: 'dset-syncing' }),
      );

      expect(resultData(result)).toEqual({ dataset_id: 'dset-syncing', snapshots: [] });
    });

    it('[tag:dataset-api] should preserve cached snapshots on 409 during import/sync', async () => {
      const params = { projectId: PROJECT_ID, dsetId: 'dset-syncing' };

      mockFetchSuccess(SNAPSHOT_LIST_RESPONSE);
      const initial = await store.dispatch(datasetApi.endpoints.listDatasetSnapshots.initiate(params));
      const cached = resultData<typeof SNAPSHOT_LIST_RESPONSE & { dataset_id: string }>(initial);

      mockFetchError(409);
      const result = await store.dispatch(datasetApi.endpoints.listDatasetSnapshots.initiate(params));

      expect(resultData(result)).toEqual(cached);
      expect(resultData<{ snapshots: unknown[] }>(result).snapshots).toHaveLength(2);
    });
  });

  describe('listDatasetKnowledgeBases', () => {
    it('[tag:dataset-api] should GET /datasets/:id/knowledge-bases', async () => {
      const mock = mockFetchSuccess(KB_LIST_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.listDatasetKnowledgeBases.initiate({ projectId: PROJECT_ID, dsetId: 'dset-789' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-789/knowledge-bases');
    });
  });

  // -- Mutations --

  describe('createDataset', () => {
    it('[tag:dataset-api] should POST /datasets and invalidate Dataset LIST', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.createDataset.initiate({ projectId: PROJECT_ID, body: CREATE_BODY }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets');
      expect(calledMethod(mock)).toBe('POST');
      await expect(calledBodyJson(mock)).resolves.toMatchObject({ kind: 'unstructured' });
    });

    it('[tag:dataset-api] createDataset without data_source_id completes (invalidatesTags falsy data_source_id branch)', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.createDataset.initiate({ projectId: PROJECT_ID, body: CREATE_BODY_NO_DATA_SOURCE }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets');
    });

    it('[tag:dataset-api] createDataset sends sourceDatabase/sourceSchema for database table scope', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.createDataset.initiate({
          projectId: PROJECT_ID,
          body: {
            name: 'sql-ds',
            input_type: 'data-source',
            kind: 'structured',
            data_source_id: 'cn-mysql',
            data_source_origin_kind: 'connector',
            spec: { folder_scope: 'all' },
            resource_selector: [{ database: 'sakila', schema: 'sakila', table: 'country' }],
            sql_query: '-- Database: sakila\nSELECT * FROM "sakila"."country"',
          },
        }),
      );

      await expect(calledBodyJson(mock)).resolves.toMatchObject({
        sourceDatabase: 'sakila',
        sourceSchema: 'sakila',
        resourceSelector: [{ database: 'sakila', schema: 'sakila', table: 'country' }],
      });
    });
  });

  describe('updateDataset', () => {
    it('[tag:dataset-api] should PUT /datasets/:id and invalidate Dataset + DatasetDetail tags', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.updateDataset.initiate({
          projectId: PROJECT_ID,
          dsetId: 'dset-upd',
          body: { name: 'updated-name' },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-upd');
      expect(calledMethod(mock)).toBe('PUT');
    });

    it('[tag:dataset-api] should support deprecation toggle via updateDataset', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.updateDataset.initiate({
          projectId: PROJECT_ID,
          dsetId: 'dset-dep',
          body: { deprecated: true },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(await calledBodyJson(mock)).toMatchObject({ deprecated: true });
    });

    it('[tag:dataset-api] updateDataset clears sourceDatabase/sourceSchema when resource_selector is emptied', async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE);

      await store.dispatch(
        datasetApi.endpoints.updateDataset.initiate({
          projectId: PROJECT_ID,
          dsetId: 'dset-db-clear',
          body: { resource_selector: [] },
        }),
      );

      expect(await calledBodyJson(mock)).toMatchObject({
        resourceSelector: [],
        sourceDatabase: null,
        sourceSchema: null,
      });
    });
  });

  describe('triggerDatasetSync', () => {
    it('[tag:dataset-api] should POST /datasets/:id/acquire to trigger sync workflow', async () => {
      const mock = mockFetchSuccess({ workflowId: 'wf-123', status: 'running', datasetId: 'dset-sync' });

      await store.dispatch(
        datasetApi.endpoints.triggerDatasetSync.initiate({ projectId: PROJECT_ID, dsetId: 'dset-sync' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-sync/acquire');
      expect(calledMethod(mock)).toBe('POST');
    });
  });

  describe('deleteDataset', () => {
    it('[tag:dataset-api] should DELETE /datasets/:id', async () => {
      const mock = mockFetchSuccess(null);

      await store.dispatch(
        datasetApi.endpoints.deleteDataset.initiate({ projectId: PROJECT_ID, dsetId: 'dset-del', dsrcId: 'dsrc-123' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-del');
      expect(calledMethod(mock)).toBe('DELETE');
    });

    it('[tag:dataset-api] deleteDataset without dsrcId omits DataSourceDatasets invalidation branch', async () => {
      const mock = mockFetchSuccess(null);

      await store.dispatch(
        datasetApi.endpoints.deleteDataset.initiate({ projectId: PROJECT_ID, dsetId: 'dset-del-no-dsrc' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-del-no-dsrc');
      expect(calledMethod(mock)).toBe('DELETE');
    });
  });

  describe('createDatasetSnapshot', () => {
    it('[tag:dataset-api] should POST /datasets/:id/acquire to trigger on-demand acquisition', async () => {
      const mock = mockFetchSuccess({ workflowId: 'wf-123', status: 'started', datasetId: 'dset-snap' });

      const result = await store.dispatch(
        datasetApi.endpoints.createDatasetSnapshot.initiate({ projectId: PROJECT_ID, dsetId: 'dset-snap' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-snap/acquire');
      expect(calledMethod(mock)).toBe('POST');
      expect(resultData(result)).toMatchObject({
        workflowId: 'wf-123',
        status: 'started',
        datasetId: 'dset-snap',
      });
    });
  });

  describe('updateDatasetSnapshot', () => {
    it('[tag:dataset-api] rollback (is_current: true) should POST .../set-current', async () => {
      const mock = mockFetchSuccess({});

      await store.dispatch(
        datasetApi.endpoints.updateDatasetSnapshot.initiate({
          projectId: PROJECT_ID,
          dsetId: 'dset-snap-upd',
          snapshotId: '1000',
          body: { is_current: true },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-snap-upd/snapshots/1000/set-current');
      expect(calledMethod(mock)).toBe('POST');
    });

    it('[tag:dataset-api] expire (deprecated: true) should POST .../expire', async () => {
      const mock = mockFetchSuccess({});

      await store.dispatch(
        datasetApi.endpoints.updateDatasetSnapshot.initiate({
          projectId: PROJECT_ID,
          dsetId: 'dset-snap-exp',
          snapshotId: '900',
          body: { deprecated: true },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/datasets/dset-snap-exp/snapshots/900/expire');
      expect(calledMethod(mock)).toBe('POST');
    });
  });
});

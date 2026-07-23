import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

import { createMockStore } from '@test/mocks';
import { mockFetchByUrl, mockFetchSuccess, mockFetchError, restoreAllMocks } from '@test/api-mock';
import { kbApi } from './kb-api.slice';
import type { KBCreateRequest } from './kb.types';

const PROJECT_ID = 'test-project';

type TestStore = ReturnType<typeof createMockStore>;

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

const KB_LIST_BACKEND_RESPONSE = [
  {
    id: 'kb-a',
    name: 'kb-alpha',
    projectId: 'test-project',
    sourceDataset: 'dset-1',
    embeddingModel: 'openai-text-embedding-3-small',
    chunkSize: 500,
    vectorSize: 1536,
    status: 'ready',
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'kb-b',
    name: 'kb-beta',
    projectId: 'test-project',
    sourceDataset: 'dset-2',
    embeddingModel: 'openai-text-embedding-3-small',
    chunkSize: 500,
    vectorSize: 1536,
    status: 'deprecated',
    createdAt: '2024-01-02T00:00:00Z',
  },
];

const KB_DETAIL_BACKEND_RESPONSE = {
  id: 'kb-123',
  name: 'kb-detail-fixture',
  description: 'Some KB',
  projectId: 'test-project',
  sourceDataset: 'dset-1',
  embeddingModel: 'openai-text-embedding-3-small',
  chunkSize: 500,
  chunkStrategy: 'fixed',
  chunkOverlap: 50,
  vectorSize: 1536,
  status: 'ready',
  indexingMode: 'hybrid',
  quantizationType: 'auto',
  stats: {
    chunkCount: 340,
    vectorCount: 340,
    storageBytes: 4908094,
    documentCount: 12,
    lastProcessedAt: '2024-02-01T00:00:00Z',
  },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  facets: [],
};

const KB_BACKEND_FOR_ASSIGNED = {
  id: 'kb-456',
  name: 'kb-with-dataset',
  projectId: 'test-project',
  sourceDataset: 'dset-abc',
  embeddingModel: 'openai-text-embedding-3-small',
  chunkSize: 500,
  vectorSize: 1536,
  status: 'ready',
  createdAt: '2024-01-01T00:00:00Z',
};

const DATASET_BACKEND = {
  id: 'dset-abc',
  projectId: 'test-project',
  name: 'My Dataset',
  description: 'desc',
  kind: 'unstructured',
  status: 'ready',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const KB_SNAPSHOTS_LIST_RESPONSE = {
  data: [
    {
      id: 'snap-1',
      version: 1,
      status: 'completed',
      expired: false,
      is_current: true,
      created_at: '2024-01-01T00:00:00Z',
    },
  ],
  pagination: { limit: 30, offset: 0, total_count: 1 },
};

const CREATE_BODY: KBCreateRequest = {
  name: 'new-kb',
  dataset_id: 'd1111111-1111-4111-8111-111111111111',
  embedding_config: { model: 'openai-text-embedding-3-small' },
};

describe('kbApi', () => {
  let store: TestStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    store.dispatch(kbApi.util.resetApiState());
    restoreAllMocks();
  });

  describe('listKnowledgeBases', () => {
    it('[tag:kb-api] should GET project-scoped /knowledgebases with query params', async () => {
      const mock = mockFetchSuccess(KB_LIST_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.listKnowledgeBases.initiate({ projectId: PROJECT_ID, limit: 10, offset: 0, search: 'foo' }),
      );

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      expect(url).toContain('/projects/test-project/knowledgebases');
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=0');
      expect(url).toContain('search=foo');
    });

    it('[tag:kb-api] should GET project-scoped /knowledgebases without params when void', async () => {
      const mock = mockFetchSuccess(KB_LIST_BACKEND_RESPONSE);

      await store.dispatch(kbApi.endpoints.listKnowledgeBases.initiate({ projectId: PROJECT_ID }));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases');
      expect(calledUrl(mock)).not.toContain('limit=');
    });

    it('[tag:kb-api] should transform backend KBs into PaginatedResponse<KBListItem>', async () => {
      mockFetchSuccess(KB_LIST_BACKEND_RESPONSE);

      const result = await store.dispatch(
        kbApi.endpoints.listKnowledgeBases.initiate({ projectId: PROJECT_ID }),
      );

      expect(result.data).toBeDefined();
      expect(result.data!.data).toHaveLength(2);
      expect(result.data!.data[0]).toMatchObject({
        kb_id: 'kb-a',
        name: 'kb-alpha',
        status: 'ready',
        deprecated: false,
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        assigned_dataset: { dset_id: 'dset-1' },
      });
      expect(result.data!.data[1]).toMatchObject({
        kb_id: 'kb-b',
        status: 'deprecated',
        deprecated: true,
      });
      expect(result.data!.pagination).toMatchObject({
        offset: 0,
        total_count: 2,
      });
    });

    it('[tag:kb-api] should provide per-item KnowledgeBase tags when result has data', async () => {
      mockFetchSuccess(KB_LIST_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.listKnowledgeBases.initiate({ projectId: PROJECT_ID, limit: 10 }),
      );

      const tags = store.getState().api.provided.tags;
      expect(tags.KnowledgeBase?.LIST).toBeDefined();
      expect(tags.KnowledgeBase?.['kb-a']).toBeDefined();
      expect(tags.KnowledgeBase?.['kb-b']).toBeDefined();
    });

    it('[tag:kb-api] should provide only LIST tag when query errors', async () => {
      mockFetchError(500);

      await store.dispatch(
        kbApi.endpoints.listKnowledgeBases.initiate({ projectId: PROJECT_ID, limit: 10 }),
      );

      const tags = store.getState().api.provided.tags;
      expect(tags.KnowledgeBase?.LIST).toBeDefined();
      expect(tags.KnowledgeBase?.['kb-a']).toBeUndefined();
    });
  });

  describe('getKnowledgeBase', () => {
    it('[tag:kb-api] should GET project-scoped /knowledgebases/:id and provide KBDetail tag', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.getKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-123' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases/kb-123');

      const tags = store.getState().api.provided.tags;
      expect(tags.KBDetail?.['kb-123']).toBeDefined();
    });

    it('[tag:kb-api] should transform backend KB into KBDetail shape', async () => {
      mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      const result = await store.dispatch(
        kbApi.endpoints.getKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-123' }),
      );

      expect(result.data).toMatchObject({
        kb_id: 'kb-123',
        name: 'kb-detail-fixture',
        status: 'ready',
        synchronization_status: 'Completed',
        description: 'Some KB',
        deprecated: false,
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-15T00:00:00Z',
        last_synchronized_at: '2024-02-01T00:00:00Z',
        files_indexed: 12,
        stats: {
          chunkCount: 340,
          vectorCount: 340,
          storageBytes: 4908094,
          documentCount: 12,
          lastProcessedAt: '2024-02-01T00:00:00Z',
        },
        assigned_dataset: { dset_id: 'dset-1' },
        snapshot: {
          files_indexed: 12,
          vectors: 340,
          last_sync: '2024-02-01T00:00:00Z',
        },
        embedding_config: {
          model: 'openai-text-embedding-3-small',
          dimensions: 1536,
        },
        chunking_config: {
          chunk_size: 500,
          overlap: 50,
        },
        indexing_config: {
          index_type: 'hybrid_search',
          vector_quantization: 'auto',
        },
      });
      expect(result.data!.chunking_config!.strategy).toBe('chunk_by_character');
    });

    it.each([
      ['hybrid', 'hybrid_search'],
      ['semantic', 'vector_only'],
      ['fts', 'keyword_only'],
    ])('[tag:kb-api] maps backend indexingMode "%s" to UI index_type "%s"', async (backend, ui) => {
      mockFetchSuccess({ ...KB_DETAIL_BACKEND_RESPONSE, indexingMode: backend });

      const result = await store.dispatch(
        kbApi.endpoints.getKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-123' }),
      );

      expect(result.data!.indexing_config!.index_type).toBe(ui);
    });

    it.each([
      ['fixed', 'chunk_by_character'],
      ['sentence', 'sentence'],
      ['recursive', 'recursive'],
      ['token', 'chunk_by_token'],
      ['markdown', 'hierarchical'],
    ])('[tag:kb-api] maps backend chunkStrategy "%s" to UI strategy "%s"', async (backend, ui) => {
      mockFetchSuccess({ ...KB_DETAIL_BACKEND_RESPONSE, chunkStrategy: backend });

      const result = await store.dispatch(
        kbApi.endpoints.getKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-123' }),
      );

      expect(result.data!.chunking_config!.strategy).toBe(ui);
    });

    it.each([
      ['none', 'none'],
      ['auto', 'auto'],
      ['scalar', 'scalar'],
      ['ivf_pq', 'ivf_pq'],
      ['ivf_rq', 'ivf_rq'],
    ])('[tag:kb-api] maps backend quantizationType "%s" to UI vector_quantization "%s"', async (backend, ui) => {
      mockFetchSuccess({ ...KB_DETAIL_BACKEND_RESPONSE, quantizationType: backend });

      const result = await store.dispatch(
        kbApi.endpoints.getKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-123' }),
      );

      expect(result.data!.indexing_config!.vector_quantization).toBe(ui);
    });

    it.each([
      ['in_progress', 'in_progress', false],
      ['ready', 'ready', false],
      ['errored', 'errored', false],
      ['deprecated', 'deprecated', true],
    ])(
      '[tag:kb-api] maps backend status "%s" to UI status "%s" with deprecated=%s',
      async (backend, uiStatus, deprecated) => {
        mockFetchSuccess({ ...KB_DETAIL_BACKEND_RESPONSE, status: backend });

        const result = await store.dispatch(
          kbApi.endpoints.getKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-123' }),
        );

        expect(result.data!.status).toBe(uiStatus);
        expect(result.data!.deprecated).toBe(deprecated);
      },
    );
  });

  describe('getKBAssignedDataset', () => {
    it('[tag:kb-api] should fetch KB then dataset and shape into KBAssignedDatasetResponse', async () => {
      const mock = mockFetchByUrl([
        { match: '/projects/test-project/knowledgebases/kb-456', data: KB_BACKEND_FOR_ASSIGNED },
        { match: '/projects/test-project/datasets/dset-abc', data: DATASET_BACKEND },
      ]);

      const result = await store.dispatch(
        kbApi.endpoints.getKBAssignedDataset.initiate({ projectId: PROJECT_ID, kbId: 'kb-456' }),
      );

      expect(mock).toHaveBeenCalledTimes(2);
      const urls = mock.mock.calls.map(([arg]) => {
        if (typeof arg === 'string') return arg;
        return (arg as { url?: string })?.url ?? String(arg);
      });
      expect(urls.some(u => u.includes('/projects/test-project/knowledgebases/kb-456'))).toBe(true);
      expect(urls.some(u => u.includes('/projects/test-project/datasets/dset-abc'))).toBe(true);

      expect(result.data).toEqual({
        kb_id: 'kb-456',
        dataset: {
          dset_id: 'dset-abc',
          name: 'My Dataset',
          kind: 'unstructured',
          status: 'Healthy',
          synchronization_status: 'Completed',
        },
      });

      const tags = store.getState().api.provided.tags;
      expect(tags.KBDetail?.['kb-456']).toBeDefined();
    });

    it('[tag:kb-api] should return empty dataset when KB has no sourceDataset', async () => {
      mockFetchByUrl([
        {
          match: '/projects/test-project/knowledgebases/kb-no-ds',
          data: { ...KB_BACKEND_FOR_ASSIGNED, id: 'kb-no-ds', sourceDataset: null },
        },
      ]);

      const result = await store.dispatch(
        kbApi.endpoints.getKBAssignedDataset.initiate({ projectId: PROJECT_ID, kbId: 'kb-no-ds' }),
      );

      expect(result.data).toEqual({ kb_id: 'kb-no-ds', dataset: {} });
    });

    it('[tag:kb-api] should propagate KB error without calling dataset endpoint', async () => {
      const mock = mockFetchByUrl([
        {
          match: '/projects/test-project/knowledgebases/kb-missing',
          data: { error: 'KnowledgeBase not found' },
          status: 404,
        },
      ]);

      const result = await store.dispatch(
        kbApi.endpoints.getKBAssignedDataset.initiate({ projectId: PROJECT_ID, kbId: 'kb-missing' }),
      );

      expect(result.error).toBeDefined();
      expect(mock).toHaveBeenCalledTimes(1);
    });
  });

  describe('listKBSnapshots', () => {
    it('[tag:kb-api] should GET /knowledge-bases/:id/snapshots and provide KBSnapshots tag', async () => {
      const mock = mockFetchSuccess(KB_SNAPSHOTS_LIST_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.listKBSnapshots.initiate({ kbId: 'kb-789' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/knowledge-bases/kb-789/snapshots');

      const tags = store.getState().api.provided.tags;
      expect(tags.KBSnapshots?.['kb-789']).toBeDefined();
    });

    it('[tag:kb-api] should pass status and include_expired when provided', async () => {
      const mock = mockFetchSuccess(KB_SNAPSHOTS_LIST_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.listKBSnapshots.initiate({
          kbId: 'kb-789',
          status: 'completed',
          includeExpired: false,
          limit: 20,
          offset: 5,
        }),
      );

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      expect(url).toContain('status=completed');
      expect(url).toContain('include_expired=false');
      expect(url).toContain('limit=20');
      expect(url).toContain('offset=5');
    });

    it('[tag:kb-api] should omit optional snapshot list params when not provided', async () => {
      const mock = mockFetchSuccess(KB_SNAPSHOTS_LIST_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.listKBSnapshots.initiate({ kbId: 'kb-789' }),
      );

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      expect(url).not.toContain('status=');
      expect(url).not.toContain('include_expired=');
      expect(url).not.toContain('limit=');
      expect(url).not.toContain('offset=');
    });
  });

  describe('validateKBName', () => {
    it('[tag:kb-api] should resolve locally without hitting the network', async () => {
      const mock = mockFetchSuccess({ name: 'my-kb', available: true });

      const result = await store.dispatch(
        kbApi.endpoints.validateKBName.initiate({ name: 'my-kb' }),
      );

      expect(mock).not.toHaveBeenCalled();
      expect(result.data).toEqual({ name: 'my-kb', available: true });
    });
  });

  describe('createKnowledgeBase', () => {
    it('[tag:kb-api] should POST project-scoped /knowledgebases with reshaped body', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.createKnowledgeBase.initiate({ projectId: PROJECT_ID, body: CREATE_BODY }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases');
      expect(calledUrl(mock)).not.toContain('/projects/test-project/knowledgebases/');
      expect(calledMethod(mock)).toBe('POST');

      expect(await calledBodyJson(mock)).toMatchObject({
        name: 'new-kb',
        sourceDataset: CREATE_BODY.dataset_id,
        embeddingModel: CREATE_BODY.embedding_config.model,
      });
    });

    it('[tag:kb-api] should flatten all nested config blocks into backend shape', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.createKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          body: {
            name: 'full-kb',
            dataset_id: 'dset-x',
            description: 'optional desc',
            embedding_config: { model: 'm1', dimensions: 1536 },
            chunking_config: { strategy: 'sentence', chunk_size: 512, overlap: 0, options: { maxSentences: 5, overlapSentences: 1 } },
            indexing_config: { index_type: 'keyword_only', vector_quantization: 'scalar' },
            labels: ['a'],
            use_pipeline: true,
          },
        }),
      );

      expect(await calledBodyJson(mock)).toEqual({
        name: 'full-kb',
        description: 'optional desc',
        labels: ['a'],
        sourceDataset: 'dset-x',
        embeddingModel: 'm1',
        vectorSize: 1536,
        chunkSize: 512,
        chunkOverlap: 0,
        chunkStrategy: 'sentence',
        chunkOptions: { maxSentences: 5, overlapSentences: 1 },
        indexingMode: 'fts',
        quantizationType: 'scalar',
      });
    });

    it('[tag:kb-api] should transform backend response into KBDetail', async () => {
      mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      const result = await store.dispatch(
        kbApi.endpoints.createKnowledgeBase.initiate({ projectId: PROJECT_ID, body: CREATE_BODY }),
      );

      expect(result.data).toMatchObject({
        kb_id: 'kb-123',
        name: 'kb-detail-fixture',
        status: 'ready',
      });
    });

    it('[tag:kb-api] should preserve workflow outcome fields on create response', async () => {
      mockFetchSuccess({
        ...KB_DETAIL_BACKEND_RESPONSE,
        workflowId: 'wf-create-1',
        warning: 'KB created but workflow not started: source dataset not found',
        workflowSkippedReason: 'dataset_not_found',
      });

      const result = await store.dispatch(
        kbApi.endpoints.createKnowledgeBase.initiate({ projectId: PROJECT_ID, body: CREATE_BODY }),
      );

      expect(result.data).toMatchObject({
        kb_id: 'kb-123',
        workflowId: 'wf-create-1',
        warning: 'KB created but workflow not started: source dataset not found',
        workflowSkippedReason: 'dataset_not_found',
      });
    });
  });

  describe('updateKnowledgeBase', () => {
    it('[tag:kb-api] should PUT project-scoped /knowledgebases/:id with backend-shape body', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-upd',
          body: { description: 'Updated' },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases/kb-upd');
      expect(calledMethod(mock)).toBe('PUT');
      expect(await calledBodyJson(mock)).toEqual({ description: 'Updated' });
    });

    it('[tag:kb-api] should reshape nested UI body into flat camelCase backend body', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-upd',
          body: {
            name: 'renamed',
            dataset_id: 'dset-2',
            embedding_config: { model: 'm', dimensions: 1536 },
            chunking_config: { strategy: 'chunk_by_token', chunk_size: 500, overlap: 50 },
            indexing_config: { index_type: 'hybrid_search', vector_quantization: 'ivf_pq' },
            labels: ['a', 'b'],
            deprecated: true,
            use_pipeline: true,
          },
        }),
      );

      expect(await calledBodyJson(mock)).toEqual({
        name: 'renamed',
        sourceDataset: 'dset-2',
        embeddingModel: 'm',
        vectorSize: 1536,
        chunkSize: 500,
        chunkOverlap: 50,
        chunkStrategy: 'token',
        indexingMode: 'hybrid',
        quantizationType: 'ivf_pq',
        labels: ['a', 'b'],
      });
    });

    it('[tag:kb-api] should preserve empty-string description so backend can clear the column', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-clr',
          body: { description: '' },
        }),
      );

      expect(await calledBodyJson(mock)).toEqual({ description: '' });
    });

    it('[tag:kb-api] should drop unknown chunking strategies rather than send them', async () => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-upd',
          body: { chunking_config: { strategy: 'semantic', chunk_size: 200 } },
        }),
      );

      const sent = await calledBodyJson(mock) as Record<string, unknown>;
      expect(sent).toEqual({ chunkSize: 200 });
      expect(sent.chunkStrategy).toBeUndefined();
    });

    it.each([
      ['hybrid_search', 'hybrid'],
      ['vector_only', 'semantic'],
      ['keyword_only', 'fts'],
    ])('[tag:kb-api] sends UI index_type "%s" as backend indexingMode "%s"', async (ui, backend) => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-upd',
          body: { indexing_config: { index_type: ui as 'hybrid_search' | 'vector_only' | 'keyword_only' } },
        }),
      );

      const sent = await calledBodyJson(mock) as Record<string, unknown>;
      expect(sent.indexingMode).toBe(backend);
    });

    it.each([
      ['chunk_by_character', 'fixed'],
      ['sentence', 'sentence'],
      ['recursive', 'recursive'],
      ['chunk_by_token', 'token'],
      ['hierarchical', 'markdown'],
    ])('[tag:kb-api] sends UI chunking strategy "%s" as backend chunkStrategy "%s"', async (ui, backend) => {
      const mock = mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-upd',
          body: {
            chunking_config: {
              strategy: ui as
                | 'chunk_by_character'
                | 'sentence'
                | 'recursive'
                | 'chunk_by_token'
                | 'hierarchical',
            },
          },
        }),
      );

      const sent = await calledBodyJson(mock) as Record<string, unknown>;
      expect(sent.chunkStrategy).toBe(backend);
    });

    it('[tag:kb-api] should transform backend response into KBDetail and invalidate list/detail', async () => {
      mockFetchSuccess(KB_DETAIL_BACKEND_RESPONSE);

      const result = await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-123',
          body: { description: 'Some KB' },
        }),
      );

      expect(result.data).toMatchObject({
        kb_id: 'kb-123',
        status: 'ready',
        synchronization_status: 'Completed',
        description: 'Some KB',
      });

      const tags = store.getState().api.provided.tags;
      expect(tags.KnowledgeBase?.['kb-123']).toBeUndefined();
    });

    it('[tag:kb-api] should preserve workflow outcome fields on update response', async () => {
      mockFetchSuccess({
        ...KB_DETAIL_BACKEND_RESPONSE,
        workflowId: 'wf-update-1',
        workflowStatus: 'running',
      });

      const result = await store.dispatch(
        kbApi.endpoints.updateKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-123',
          body: { chunking_config: { chunk_size: 600 } },
        }),
      );

      expect(result.data).toMatchObject({
        kb_id: 'kb-123',
        workflowId: 'wf-update-1',
        workflowStatus: 'running',
      });
    });
  });

  describe('deleteKnowledgeBase', () => {
    it('[tag:kb-api] should DELETE project-scoped /knowledgebases/:id and invalidate list/detail', async () => {
      const mock = mockFetchSuccess(null);

      await store.dispatch(
        kbApi.endpoints.deleteKnowledgeBase.initiate({ projectId: PROJECT_ID, kbId: 'kb-del' }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases/kb-del');
      expect(calledMethod(mock)).toBe('DELETE');
    });
  });

  describe('createKBSnapshot', () => {
    it('[tag:kb-api] should POST /knowledge-bases/:id/snapshots with body', async () => {
      const detail = { ...KB_SNAPSHOTS_LIST_RESPONSE.data[0], kb_id: 'kb-snap' };
      const mock = mockFetchSuccess(detail);

      await store.dispatch(
        kbApi.endpoints.createKBSnapshot.initiate({
          kbId: 'kb-snap',
          body: { workflow_id: 'wf-1' },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/knowledge-bases/kb-snap/snapshots');
      expect(calledMethod(mock)).toBe('POST');
      expect(await calledBodyJson(mock)).toMatchObject({ workflow_id: 'wf-1' });
    });

    it('[tag:kb-api] should POST empty object when body omitted', async () => {
      const detail = { ...KB_SNAPSHOTS_LIST_RESPONSE.data[0], kb_id: 'kb-snap' };
      const mock = mockFetchSuccess(detail);

      await store.dispatch(
        kbApi.endpoints.createKBSnapshot.initiate({ kbId: 'kb-snap' }),
      );

      expect(await calledBodyJson(mock)).toEqual({});
    });
  });

  describe('updateKBSnapshot', () => {
    it('[tag:kb-api] should PATCH /knowledge-bases/:id/snapshots/:snapshotId', async () => {
      const detail = { ...KB_SNAPSHOTS_LIST_RESPONSE.data[0], kb_id: 'kb-snap-upd' };
      const mock = mockFetchSuccess(detail);

      await store.dispatch(
        kbApi.endpoints.updateKBSnapshot.initiate({
          kbId: 'kb-snap-upd',
          snapshotId: 'snap-uuid-1',
          body: { expired: true, is_current: false },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/knowledge-bases/kb-snap-upd/snapshots/snap-uuid-1');
      expect(calledMethod(mock)).toBe('PATCH');
      expect(await calledBodyJson(mock)).toMatchObject({
        expired: true,
        is_current: false,
      });
    });
  });

  describe('manualSyncKB', () => {
    it('[tag:kb-api] should POST /projects/:projectId/knowledgebases/:id/create to trigger re-sync', async () => {
      const mock = mockFetchSuccess({
        workflowId: 'wf-sync-1',
        status: 'running',
        knowledgeBaseId: 'kb-sync-123',
        projectId: PROJECT_ID,
      });

      await store.dispatch(
        kbApi.endpoints.manualSyncKB.initiate({
          projectId: PROJECT_ID,
          kbId: 'kb-sync-123',
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases/kb-sync-123/create');
      expect(calledMethod(mock)).toBe('POST');
      expect(await calledBodyJson(mock)).toEqual({});
    });
  });

  describe('searchKnowledgeBase', () => {
    it('[tag:kb-api] should POST /projects/:projectId/knowledgebases/:id/search via kb-retrieval', async () => {
      const mock = mockFetchSuccess({
        results: [
          {
            id: 'chunk-1',
            text: 'Passage',
            score: 0.9,
            source: 'doc.pdf',
            chunkIndex: 0,
          },
        ],
        query: 'backup config',
        resultCount: 1,
      });

      const result = await store.dispatch(
        kbApi.endpoints.searchKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kba64shx73',
          query: 'backup config',
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledMethod(mock)).toBe('POST');
      expect(calledUrl(mock)).toContain('/projects/test-project/knowledgebases/kba64shx73/search');
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0].chunkId).toBe('chunk-1');
    });

    it('[tag:kb-api] should include rerankerType when provided for hybrid search', async () => {
      const mock = mockFetchSuccess({
        results: [],
        query: 'backup config',
        resultCount: 0,
      });

      await store.dispatch(
        kbApi.endpoints.searchKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kba64shx73',
          query: 'backup config',
          searchMode: 'hybrid',
          rerankerType: 'rrf',
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(await calledBodyJson(mock)).toMatchObject({
        query: 'backup config',
        searchMode: 'hybrid',
        rerankerType: 'rrf',
      });
    });

    it('[tag:kb-api] should forward rerankerType none to disable reranking', async () => {
      const mock = mockFetchSuccess({
        results: [],
        query: 'backup config',
        resultCount: 0,
      });

      await store.dispatch(
        kbApi.endpoints.searchKnowledgeBase.initiate({
          projectId: PROJECT_ID,
          kbId: 'kba64shx73',
          query: 'backup config',
          searchMode: 'hybrid',
          rerankerType: 'none',
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(await calledBodyJson(mock)).toMatchObject({
        query: 'backup config',
        searchMode: 'hybrid',
        rerankerType: 'none',
      });
    });
  });
});

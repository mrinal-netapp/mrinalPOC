import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeBase } from '../models/KnowledgeBase';
import {
  extractKnowledgeBaseWorkflowUpdate,
  knowledgeBaseProcessingOverridesChanged,
  splitKnowledgeBaseUpdateBody,
} from '../utils/knowledgeBaseUpdateWorkflow';
import { resolveEmbeddingModelName } from '../services/knowledgeBaseEmbedding';

test('splitKnowledgeBaseUpdateBody separates metadata from processing fields', () => {
  const { metadataUpdate, processingOverrides } = splitKnowledgeBaseUpdateBody({
    description: 'new desc',
    labels: ['a'],
    chunkSize: 512,
    embeddingModel: 'text-embedding-3-small',
    status: 'ready',
    jobId: 'wf-old',
  });

  assert.equal(metadataUpdate.description, 'new desc');
  assert.deepEqual(metadataUpdate.labels, ['a']);
  assert.equal(metadataUpdate.status, undefined);
  assert.equal(metadataUpdate.jobId, undefined);
  assert.equal(processingOverrides.chunkSize, 512);
  assert.equal(processingOverrides.embeddingModel, 'text-embedding-3-small');
});

test('splitKnowledgeBaseUpdateBody drops null processing overrides', () => {
  const { metadataUpdate, processingOverrides } = splitKnowledgeBaseUpdateBody({
    description: null,
    textColumns: null,
    chunkSize: 512,
  });

  assert.equal(metadataUpdate.description, null);
  assert.equal(processingOverrides.textColumns, undefined);
  assert.equal(processingOverrides.chunkSize, 512);
});

test('splitKnowledgeBaseUpdateBody drops empty string processing overrides', () => {
  const { processingOverrides } = splitKnowledgeBaseUpdateBody({
    embeddingModel: '   ',
    sourceDataset: '',
    dataType: '\t',
    chunkSize: 512,
  });

  assert.equal(processingOverrides.embeddingModel, undefined);
  assert.equal(processingOverrides.sourceDataset, undefined);
  assert.equal(processingOverrides.dataType, undefined);
  assert.equal(processingOverrides.chunkSize, 512);
});

test('splitKnowledgeBaseUpdateBody preserves empty textColumns to allow clearing', () => {
  const { processingOverrides } = splitKnowledgeBaseUpdateBody({
    dataType: 'unstructured',
    textColumns: '',
  });

  assert.equal(processingOverrides.dataType, 'unstructured');
  assert.equal(processingOverrides.textColumns, '');
});

test('splitKnowledgeBaseUpdateBody normalizes whitespace-only textColumns to empty string', () => {
  const { processingOverrides } = splitKnowledgeBaseUpdateBody({
    dataType: 'unstructured',
    textColumns: '   ',
  });

  assert.equal(processingOverrides.dataType, 'unstructured');
  assert.equal(processingOverrides.textColumns, '');
});

test('splitKnowledgeBaseUpdateBody trims textColumns before forwarding', () => {
  const { processingOverrides } = splitKnowledgeBaseUpdateBody({
    dataType: 'structured',
    textColumns: ' title , body ',
  });

  assert.equal(processingOverrides.textColumns, 'title , body');
});

test('splitKnowledgeBaseUpdateBody rejects unsafe and unknown keys', () => {
  const { metadataUpdate, processingOverrides } = splitKnowledgeBaseUpdateBody({
    name: 'safe-name',
    description: 'ok',
    status: 'ready',
    jobId: 'wf-old',
    __proto__: { polluted: true },
    constructor: { polluted: true },
    prototype: { polluted: true },
    unknownField: 'drop-me',
  });

  assert.equal(metadataUpdate.name, 'safe-name');
  assert.equal(metadataUpdate.description, 'ok');
  assert.equal(metadataUpdate.status, undefined);
  assert.equal(metadataUpdate.jobId, undefined);
  assert.equal(metadataUpdate.__proto__, undefined);
  assert.equal(metadataUpdate.unknownField, undefined);
  assert.equal(Object.keys(processingOverrides).length, 0);
});

test('extractKnowledgeBaseWorkflowUpdate commits workflow completion fields', () => {
  const workflowUpdate = extractKnowledgeBaseWorkflowUpdate({
    status: 'ready',
    lanceTablePath: '/mnt/pvcs/default-nemo/projects/p/knowledgebases/kb1/lancedb-run-abc',
    stats: { documentCount: 1, chunkCount: 1, vectorCount: 1 },
    lastSyncedAt: '2026-07-13T13:01:35Z',
    chunkSize: 512,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    name: 'ignored-metadata',
  });

  assert.equal(workflowUpdate?.status, 'ready');
  assert.equal(workflowUpdate?.errorMessage, null);
  assert.equal(workflowUpdate?.lanceTablePath, '/mnt/pvcs/default-nemo/projects/p/knowledgebases/kb1/lancedb-run-abc');
  assert.deepEqual(workflowUpdate?.stats, { documentCount: 1, chunkCount: 1, vectorCount: 1 });
  assert.equal(workflowUpdate?.chunkSize, 512);
  assert.equal(workflowUpdate?.embeddingModel, 'sentence-transformers/all-MiniLM-L6-v2');
  assert.equal((workflowUpdate as Record<string, unknown>).name, undefined);
});

test('extractKnowledgeBaseWorkflowUpdate returns null without status', () => {
  assert.equal(
    extractKnowledgeBaseWorkflowUpdate({ chunkSize: 400, description: 'x' }),
    null,
  );
});

test('knowledgeBaseProcessingOverridesChanged detects real processing changes', () => {
  const kb = {
    chunkSize: 300,
    embeddingModel: 'old-model',
    chunkOptions: { maxSentences: 5 },
  } as KnowledgeBase;

  assert.equal(
    knowledgeBaseProcessingOverridesChanged(kb, {
      chunkSize: 300,
      embeddingModel: 'old-model',
      chunkOptions: { maxSentences: 5 },
    }),
    false,
  );
  assert.equal(
    knowledgeBaseProcessingOverridesChanged(kb, { chunkSize: 400 }),
    true,
  );
});

test('knowledgeBaseProcessingOverridesChanged ignores JSONB key order', () => {
  const kb = {
    chunkOptions: { overlapSentences: 2, maxSentences: 5 },
  } as KnowledgeBase;

  assert.equal(
    knowledgeBaseProcessingOverridesChanged(kb, {
      chunkOptions: { maxSentences: 5, overlapSentences: 2 },
    }),
    false,
  );
});

test('resolveEmbeddingModelName treats empty/whitespace override as not provided', () => {
  assert.equal(resolveEmbeddingModelName('', 'persisted-model'), 'persisted-model');
  assert.equal(resolveEmbeddingModelName('   ', 'persisted-model'), 'persisted-model');
  assert.equal(resolveEmbeddingModelName('override-model', 'persisted-model'), 'override-model');
  assert.equal(resolveEmbeddingModelName(undefined, 'persisted-model'), 'persisted-model');
  assert.equal(resolveEmbeddingModelName({ bad: true }, 'persisted-model'), 'persisted-model');
});

/**
 * Drift / catalog unit tests.
 *
 * These cover the pure parts of the reference-edge subsystem (the
 * declarative catalog) without needing a live database. The intent is
 * that any new reference field added to a source entity gains an
 * extractor here in the same PR, and this test file fails noisily if
 * the extractor's contract regresses.
 *
 * Run: `npx ts-node --transpile-only tests/referenceCatalog.drift.test.ts`
 *
 * The full DB-backed convergence test (run reconciler twice, expect
 * `added == removed == 0` on the second pass) lives in the integration
 * suite; it depends on Postgres + Temporal which aren't available here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceCatalog } from '../services/referenceCatalog';
import type { Pipeline } from '../models/Pipeline';

test('agent extractor enumerates scalar FK + JSON arrays', () => {
  const edges = referenceCatalog.extractEdges('agent', 'agt-1', {
    id: 'agt-1',
    projectId: 'p1',
    modelId: 'm1',
    mcpServerIds: ['mcp1', 'mcp2', '', 'mcp1'], // dup + blank filtered
    knowledgeBaseIds: ['kb1'],
    datasetIds: ['ds1'],
  });
  // (model:m1) (mcp:mcp1) (mcp:mcp2) (kb:kb1) (ds:ds1) — 5 unique edges
  assert.equal(edges.length, 5);
  assert.ok(edges.some((e) => e.targetType === 'model' && e.targetId === 'm1'));
  assert.ok(edges.some((e) => e.targetType === 'mcp_server' && e.targetId === 'mcp1'));
  assert.ok(edges.some((e) => e.targetType === 'knowledge_base' && e.targetId === 'kb1'));
  assert.ok(edges.some((e) => e.targetType === 'dataset' && e.targetId === 'ds1'));
});

test('agent extractor de-duplicates repeated ids', () => {
  const edges = referenceCatalog.extractEdges('agent', 'agt-1', {
    id: 'agt-1',
    projectId: 'p1',
    modelId: 'm1',
    mcpServerIds: ['mcp1', 'mcp1', 'mcp1'],
    knowledgeBaseIds: [],
    datasetIds: [],
  });
  // model + 1 mcp = 2
  assert.equal(edges.length, 2);
});

test('model extractor surfaces credential FK', () => {
  const edges = referenceCatalog.extractEdges('model', 'm1', {
    id: 'm1',
    projectId: 'p1',
    credentialId: 'cred-1',
  });
  assert.deepEqual(edges, [
    { targetType: 'credential', targetId: 'cred-1', relation: 'uses_credential' },
  ]);
});

test('mcp_server extractor surfaces both credentialId and runtimeCredentialId', () => {
  const edges = referenceCatalog.extractEdges('mcp_server', 'mcp-1', {
    id: 'mcp-1',
    projectId: 'p1',
    credentialId: 'cred-a',
    runtimeCredentialId: 'cred-b',
  });
  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.targetId === 'cred-a' && e.relation === 'uses_credential'));
  assert.ok(edges.some((e) => e.targetId === 'cred-b' && e.relation === 'uses_credential'));
});

test('mcp_server extractor deduplicates when both credential ids are the same', () => {
  const edges = referenceCatalog.extractEdges('mcp_server', 'mcp-2', {
    id: 'mcp-2',
    projectId: 'p1',
    credentialId: 'cred-same',
    runtimeCredentialId: 'cred-same',
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].targetId, 'cred-same');
});

test('agent_team extractor surfaces manager model + shared resources + members', () => {
  const edges = referenceCatalog.extractEdges('agent_team', 'team-1', {
    id: 'team-1',
    projectId: 'p1',
    manager: { modelId: 'm1' },
    sharedKnowledgeBaseIds: ['kb1', 'kb2'],
    sharedDatasetIds: ['ds1'],
    members: [{ memberType: 'agent', memberId: 'agt-1' }],
  });
  assert.equal(edges.length, 5);
  assert.ok(edges.some((e) => e.relation === 'uses_team_model' && e.targetId === 'm1'));
  assert.ok(edges.some((e) => e.relation === 'shares_kb' && e.targetId === 'kb1'));
  assert.ok(edges.some((e) => e.relation === 'has_member' && e.targetId === 'agt-1'));
});

test('pipeline extractor walks graph nodes and emits graph_ref edges', () => {
  const pipeline: Pick<Pipeline, 'id' | 'projectId' | 'graph'> = {
    id: 'pl-1',
    projectId: 'p1',
    graph: {
      nodes: [
        { id: 'n1', type: 'agent', config: { params: { projectId: 'p1', agentId: 'agt-1' } } },
        { id: 'n2', type: 'knowledge', config: { params: { knowledgeBaseId: 'kb1' } } },
        { id: 'n3', type: 'mcp', config: { params: { server: 'mcp1' } } },
        { id: 'n4', type: 'dataset_reader', config: { params: { dataset_id: 'ds1' } } },
        { id: 'n5', type: 'publish_to_kb', config: { params: { knowledgeBaseId: 'kb2' } } },
        { id: 'n6', type: 'function', config: { params: {} } },
      ],
      edges: [],
    },
  };
  const edges = referenceCatalog.extractEdges('pipeline', 'pl-1', pipeline);
  assert.equal(edges.length, 5);
  assert.ok(edges.every((e) => e.relation === 'graph_ref'));
  assert.ok(edges.some((e) => e.targetType === 'agent' && e.targetId === 'agt-1'));
  assert.ok(edges.some((e) => e.targetType === 'knowledge_base' && e.targetId === 'kb1'));
  assert.ok(edges.some((e) => e.targetType === 'knowledge_base' && e.targetId === 'kb2'));
  assert.ok(edges.some((e) => e.targetType === 'mcp_server' && e.targetId === 'mcp1'));
  assert.ok(edges.some((e) => e.targetType === 'dataset' && e.targetId === 'ds1'));
});

test('pipeline extractor skips cross-project agent references', () => {
  const pipeline: Pick<Pipeline, 'id' | 'projectId' | 'graph'> = {
    id: 'pl-1',
    projectId: 'p1',
    graph: {
      nodes: [
        // Cross-project reference: agent lives in p2 but the pipeline is in p1.
        // The reference-edge schema is project-scoped so we must drop this.
        { id: 'n1', type: 'agent', config: { params: { projectId: 'p2', agentId: 'agt-1' } } },
        // Same-project reference — should survive.
        { id: 'n2', type: 'agent', config: { params: { projectId: 'p1', agentId: 'agt-2' } } },
      ],
      edges: [],
    },
  };
  const edges = referenceCatalog.extractEdges('pipeline', 'pl-1', pipeline);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].targetId, 'agt-2');
});

test('knowledge_base extractor links sourceDataset to dataset target', () => {
  const edges = referenceCatalog.extractEdges('knowledge_base', 'kb12345678', {
    id: 'kb12345678',
    projectId: 'p1',
    name: 'My KB',
    sourceDataset: 'dsabcd123456',
    embeddingModel: 'text-embedding-3-small',
    chunkSize: 512,
    vectorSize: 1536,
  });
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], {
    targetType: 'dataset',
    targetId: 'dsabcd123456',
    relation: 'uses_dataset',
  });
});

test('knowledge_base extractor links embeddingModelId to model target', () => {
  const edges = referenceCatalog.extractEdges('knowledge_base', 'kb12345678', {
    id: 'kb12345678',
    projectId: 'p1',
    name: 'My KB',
    sourceDataset: 'dsabcd123456',
    embeddingModel: 'text-embedding-3-small',
    embeddingModelId: 'mdl-embed-1',
    chunkSize: 512,
    vectorSize: 1536,
  });
  assert.equal(edges.length, 2);
  assert.deepEqual(edges[1], {
    targetType: 'model',
    targetId: 'mdl-embed-1',
    relation: 'uses_embedding_model',
  });
});

test('knowledge_base extractor skips migration placeholders for sourceDataset', () => {
  const edges = referenceCatalog.extractEdges('knowledge_base', 'kb12345678', {
    id: 'kb12345678',
    projectId: 'p1',
    name: 'My KB',
    sourceDataset: '__unset__',
    embeddingModel: 'm',
    chunkSize: 512,
    vectorSize: 1536,
  });
  assert.deepEqual(edges, []);
});

test('data_source extractor surfaces credential FK', () => {
  const edges = referenceCatalog.extractEdges('data_source', 'ds-conn-1', {
    id: 'ds-conn-1',
    projectId: 'p1',
    type: 'connector',
    credentialId: 'cred-42',
  });
  assert.deepEqual(edges, [
    { targetType: 'credential', targetId: 'cred-42', relation: 'uses_credential' },
  ]);
});

test('data_source extractor surfaces credential_id from API model shape', () => {
  const edges = referenceCatalog.extractEdges('data_source', 'ds-conn-2', {
    id: 'ds-conn-2',
    project_id: 'p1',
    type: 'ontap',
    credential_id: 'cred-snake',
  });
  assert.deepEqual(edges, [
    { targetType: 'credential', targetId: 'cred-snake', relation: 'uses_credential' },
  ]);
});

test('data_source extractor surfaces credential_id from API model shape', () => {
  const edges = referenceCatalog.extractEdges('data_source', 'ds-conn-2', {
    id: 'ds-conn-2',
    project_id: 'p1',
    type: 'connector',
    credential_id: 'cred-99',
  });
  assert.deepEqual(edges, [
    { targetType: 'credential', targetId: 'cred-99', relation: 'uses_credential' },
  ]);
});

test('data_source extractor returns empty when no credential', () => {
  const edges = referenceCatalog.extractEdges('data_source', 'ds-vol-1', {
    id: 'ds-vol-1',
    projectId: 'p1',
    type: 'volume',
  });
  assert.deepEqual(edges, []);
});

test('agent_team extractor surfaces member references', () => {
  const edges = referenceCatalog.extractEdges('agent_team', 'team-2', {
    id: 'team-2',
    projectId: 'p1',
    manager: {},
    sharedKnowledgeBaseIds: [],
    sharedDatasetIds: [],
    members: [
      { memberType: 'agent', memberId: 'agt-1' },
      { memberType: 'team', memberId: 'team-3' },
      { memberType: 'agent', memberId: 'agt-2' },
    ],
  });
  assert.equal(edges.length, 3);
  assert.ok(edges.some((e) => e.targetType === 'agent' && e.targetId === 'agt-1' && e.relation === 'has_member'));
  assert.ok(edges.some((e) => e.targetType === 'agent_team' && e.targetId === 'team-3' && e.relation === 'has_member'));
  assert.ok(edges.some((e) => e.targetType === 'agent' && e.targetId === 'agt-2' && e.relation === 'has_member'));
});

test('evaluation extractor enumerates subject agent + judge models', () => {
  const edges = referenceCatalog.extractEdges('evaluation', 'evt-1', {
    templateId: 'evt-1',
    projectId: 'p1',
    evalName: 'RAG validation',
    agent: { agentId: 'agt-1', agentVersion: 'v2.4.1' },
    evaluators: { strategy: 'both', aiJudge: { models: ['m-judge', '', 'm-judge'], dimensions: ['helpfulness'] } }, // dup + blank filtered
  });
  // (agent:agt-1 evaluates_agent) (model:m-judge uses_judge_model) — 2 unique edges
  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.targetType === 'agent' && e.targetId === 'agt-1' && e.relation === 'evaluates_agent'));
  assert.ok(edges.some((e) => e.targetType === 'model' && e.targetId === 'm-judge' && e.relation === 'uses_judge_model'));
});

test('evaluation extractor emits no edges when bindings are absent', () => {
  const edges = referenceCatalog.extractEdges('evaluation', 'evt-2', {
    templateId: 'evt-2',
    projectId: 'p1',
    evalName: 'deterministic only',
    agent: { agentId: '', agentVersion: 'v1' },
    evaluators: { strategy: 'deterministic', deterministic: { metrics: ['rag_quality'] } },
  });
  assert.equal(edges.length, 0);
});

test('extractor is idempotent: identical input yields identical output', () => {
  const row = {
    id: 'agt-1',
    projectId: 'p1',
    modelId: 'm1',
    mcpServerIds: ['mcp1'],
    knowledgeBaseIds: ['kb1'],
    datasetIds: [],
  };
  const e1 = referenceCatalog.extractEdges('agent', 'agt-1', row);
  const e2 = referenceCatalog.extractEdges('agent', 'agt-1', row);
  assert.deepEqual(e1, e2);
});

test('extractor returns empty array for unknown source kind', () => {
  // Cast to any to bypass the EntityKind type — runtime behavior under
  // a typo in catalog usage should be "no edges", not throw.
  const edges = referenceCatalog.extractEdges('unknown_kind' as any, 'x', {});
  assert.deepEqual(edges, []);
});

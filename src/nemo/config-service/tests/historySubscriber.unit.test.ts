/**
 * Unit tests for db/historySubscriber.ts
 *
 * Run: node --require ts-node/register --test tests/historySubscriber.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EntityManager } from 'typeorm';

import { DataSource } from '../models/DataSource';
import { DataSet } from '../models/DataSet';
import { EvaluationTemplate } from '../models/EvaluationTemplate';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { MCPServer } from '../models/MCPServer';
import { Model } from '../models/Model';
import { Pipeline } from '../models/Pipeline';
import { Agent } from '../models/Agent';
import { AgentTeam } from '../models/AgentTeam';
import {
  DataSourceHistorySubscriber,
  DataSetHistorySubscriber,
  KnowledgeBaseHistorySubscriber,
  MCPServerHistorySubscriber,
  ModelHistorySubscriber,
  PipelineHistorySubscriber,
  AgentHistorySubscriber,
  AgentTeamHistorySubscriber,
  EvaluationTemplateHistorySubscriber,
} from '../db/historySubscriber';

type HistoryRecord = {
  entityId: string;
  version: number;
  data: Record<string, unknown>;
  op: string;
};

function makeManager(options: {
  entity?: Record<string, unknown> | null;
  fetchedEntity?: Record<string, unknown> | null;
  lastHistory?: { version: number } | null;
  saved?: HistoryRecord[];
}): EntityManager {
  const saved = options.saved ?? [];
  const entityRepo = {
    findOne: async () => options.fetchedEntity ?? options.entity ?? null,
  };
  const historyRepo = {
    findOne: async () => options.lastHistory ?? null,
    save: async (row: HistoryRecord) => {
      saved.push(row);
      return row;
    },
  };
  return {
    getRepository: (cls: { name?: string }) => {
      const name = cls?.name ?? '';
      if (name.endsWith('History')) return historyRepo;
      return entityRepo;
    },
  } as unknown as EntityManager;
}

test('DataSourceHistorySubscriber: listenTo returns DataSource entity', () => {
  const sub = new DataSourceHistorySubscriber();
  assert.equal(sub.listenTo(), DataSource);
});

test('DataSourceHistorySubscriber: afterUpdate saves version 1 snapshot', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new DataSourceHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: { id: 'ds-1', name: 'vol-a', createdAt: new Date(), updatedAt: new Date() },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entityId, 'ds-1');
  assert.equal(saved[0].version, 1);
  assert.equal(saved[0].op, 'update');
  assert.equal(saved[0].data.name, 'vol-a');
  assert.equal(saved[0].data.id, undefined);
});

test('DataSourceHistorySubscriber: afterUpdate increments version from last history', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new DataSourceHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved, lastHistory: { version: 4 } }),
    entity: { id: 'ds-1', name: 'updated' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved[0].version, 5);
});

test('DataSourceHistorySubscriber: afterUpdate uses databaseEntity when entity is missing', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new DataSourceHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: undefined,
    databaseEntity: { id: 'ds-2', name: 'from-db' },
  } as any);
  assert.equal(saved[0].entityId, 'ds-2');
});

test('DataSourceHistorySubscriber: afterUpdate no-op without entity id', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new DataSourceHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: { name: 'no-id' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved.length, 0);
});

test('DataSourceHistorySubscriber: beforeRemove saves delete operation', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new DataSourceHistorySubscriber();
  await sub.beforeRemove({
    manager: makeManager({ saved }),
    entity: { id: 'ds-9', name: 'gone' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved[0].op, 'delete');
});

test('DataSourceHistorySubscriber: skips history when entity id is missing', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new DataSourceHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: { name: 'no-id' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved.length, 0);
});

test('EvaluationTemplateHistorySubscriber: uses templateId as history key', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new EvaluationTemplateHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: { templateId: 'tpl-1', evalName: 'smoke' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved[0].entityId, 'tpl-1');
  assert.equal(saved[0].data.evalName, 'smoke');
});

test('EvaluationTemplateHistorySubscriber: beforeRemove uses templateId from databaseEntity', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new EvaluationTemplateHistorySubscriber();
  await sub.beforeRemove({
    manager: makeManager({ saved }),
    entity: undefined,
    databaseEntity: { templateId: 'tpl-9', evalName: 'old' },
  } as any);
  assert.equal(saved[0].entityId, 'tpl-9');
  assert.equal(saved[0].op, 'delete');
});

test('all subscribers expose listenTo for their entity class', () => {
  assert.equal(new DataSourceHistorySubscriber().listenTo(), DataSource);
  assert.equal(new DataSetHistorySubscriber().listenTo(), DataSet);
  assert.equal(new KnowledgeBaseHistorySubscriber().listenTo(), KnowledgeBase);
  assert.equal(new MCPServerHistorySubscriber().listenTo(), MCPServer);
  assert.equal(new ModelHistorySubscriber().listenTo(), Model);
  assert.equal(new PipelineHistorySubscriber().listenTo(), Pipeline);
  assert.equal(new AgentHistorySubscriber().listenTo(), Agent);
  assert.equal(new AgentTeamHistorySubscriber().listenTo(), AgentTeam);
  assert.equal(new EvaluationTemplateHistorySubscriber().listenTo(), EvaluationTemplate);
});

const subscriberSmokeCases: Array<{
  name: string;
  subscriber: {
    listenTo: () => unknown;
    afterUpdate: (event: any) => Promise<void>;
    beforeRemove: (event: any) => Promise<void>;
  };
  payload: Record<string, unknown>;
}> = [
  { name: 'DataSet', subscriber: new DataSetHistorySubscriber(), payload: { id: 'set-1' } },
  { name: 'KnowledgeBase', subscriber: new KnowledgeBaseHistorySubscriber(), payload: { id: 'kb-1' } },
  { name: 'MCPServer', subscriber: new MCPServerHistorySubscriber(), payload: { id: 'mcp-1' } },
  { name: 'Model', subscriber: new ModelHistorySubscriber(), payload: { id: 'mdl-1' } },
  { name: 'Pipeline', subscriber: new PipelineHistorySubscriber(), payload: { id: 'pip-1' } },
  { name: 'Agent', subscriber: new AgentHistorySubscriber(), payload: { id: 'agt-1' } },
  { name: 'AgentTeam', subscriber: new AgentTeamHistorySubscriber(), payload: { id: 'team-1' } },
];

for (const { name, subscriber, payload } of subscriberSmokeCases) {
  test(`${name}HistorySubscriber: afterUpdate and beforeRemove persist history`, async () => {
    const saved: HistoryRecord[] = [];
    const event = {
      manager: makeManager({ saved }),
      entity: { ...payload, name: 'test' },
      databaseEntity: undefined,
    };
    await subscriber.afterUpdate(event as any);
    await subscriber.beforeRemove(event as any);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].op, 'update');
    assert.equal(saved[1].op, 'delete');
  });

  test(`${name}HistorySubscriber: uses databaseEntity when entity is missing`, async () => {
    const saved: HistoryRecord[] = [];
    await subscriber.afterUpdate({
      manager: makeManager({ saved }),
      entity: undefined,
      databaseEntity: { ...payload, name: 'from-db' },
    } as any);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].entityId, payload.id);
    assert.equal(saved[0].data.name, 'from-db');
  });
}

test('AgentHistorySubscriber: beforeRemove uses databaseEntity id when entity is missing', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new AgentHistorySubscriber();
  await sub.beforeRemove({
    manager: makeManager({ saved }),
    entity: undefined,
    databaseEntity: { id: 'agt-db-only', name: 'legacy' },
  } as any);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entityId, 'agt-db-only');
  assert.equal(saved[0].op, 'delete');
});

test('KnowledgeBaseHistorySubscriber: persists minimal databaseEntity snapshot', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new KnowledgeBaseHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: undefined,
    databaseEntity: { id: 'kb-minimal' },
  } as any);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entityId, 'kb-minimal');
  assert.equal(saved[0].data.id, undefined);
});

const beforeRemoveDbEntityCases: Array<{
  name: string;
  subscriber: { beforeRemove: (event: any) => Promise<void> };
  id: string;
}> = [
  { name: 'DataSet', subscriber: new DataSetHistorySubscriber(), id: 'set-db' },
  { name: 'KnowledgeBase', subscriber: new KnowledgeBaseHistorySubscriber(), id: 'kb-db' },
  { name: 'MCPServer', subscriber: new MCPServerHistorySubscriber(), id: 'mcp-db' },
  { name: 'Model', subscriber: new ModelHistorySubscriber(), id: 'mdl-db' },
  { name: 'Pipeline', subscriber: new PipelineHistorySubscriber(), id: 'pip-db' },
  { name: 'AgentTeam', subscriber: new AgentTeamHistorySubscriber(), id: 'team-db' },
];

for (const { name, subscriber, id } of beforeRemoveDbEntityCases) {
  test(`${name}HistorySubscriber: beforeRemove uses databaseEntity id when entity is missing`, async () => {
    const saved: HistoryRecord[] = [];
    await subscriber.beforeRemove({
      manager: makeManager({ saved }),
      entity: undefined,
      databaseEntity: { id, name: 'legacy' },
    } as any);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].entityId, id);
    assert.equal(saved[0].op, 'delete');
  });
}

test('EvaluationTemplateHistorySubscriber: afterUpdate no-op without templateId', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new EvaluationTemplateHistorySubscriber();
  await sub.afterUpdate({
    manager: makeManager({ saved }),
    entity: { evalName: 'no-template-id' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved.length, 0);
});

test('EvaluationTemplateHistorySubscriber: beforeRemove no-op without templateId', async () => {
  const saved: HistoryRecord[] = [];
  const sub = new EvaluationTemplateHistorySubscriber();
  await sub.beforeRemove({
    manager: makeManager({ saved }),
    entity: { evalName: 'no-template-id' },
    databaseEntity: undefined,
  } as any);
  assert.equal(saved.length, 0);
});

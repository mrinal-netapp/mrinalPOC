/**
 * Unit tests for model @BeforeInsert/@BeforeUpdate lifecycle hooks.
 *
 * Run: node --require ts-node/register --test tests/models.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../models/Agent';
import { AgentTeam } from '../models/AgentTeam';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { DataSet } from '../models/DataSet';
import { DataSource } from '../models/DataSource';
import { ArtifactStore } from '../models/ArtifactStore';
import { Workspace } from '../models/Workspace';
import { Pipeline } from '../models/Pipeline';
import { MCPServer } from '../models/MCPServer';

const idCases: Array<{ name: string; make: () => any; prefix: string }> = [
  { name: 'Agent', make: () => new Agent(), prefix: 'ag-' },
  { name: 'AgentTeam', make: () => new AgentTeam(), prefix: 'agr-' },
  { name: 'KnowledgeBase', make: () => new KnowledgeBase(), prefix: 'kb' },
  { name: 'DataSet', make: () => new DataSet(), prefix: 'dset' },
  { name: 'ArtifactStore', make: () => new ArtifactStore(), prefix: 'as' },
  { name: 'Pipeline', make: () => new Pipeline(), prefix: 'pl-' },
];

for (const { name, make, prefix } of idCases) {
  test(`${name}.generateId: assigns prefixed id and preserves an existing one`, () => {
    const entity = make();
    entity.generateId();
    assert.ok(typeof entity.id === 'string' && entity.id.startsWith(prefix), `got ${entity.id}`);

    const preset = make();
    preset.id = 'preset-id';
    preset.generateId();
    assert.equal(preset.id, 'preset-id');
  });
}

test('Workspace.generateId: 10-char base36 id, idempotent when set', () => {
  const ws = new Workspace();
  ws.generateId();
  assert.match(ws.id, /^[0-9a-z]{10}$/);
  const preset = new Workspace();
  preset.id = 'fixedws001';
  preset.generateId();
  assert.equal(preset.id, 'fixedws001');
});

test('DataSource.generateId: connector vs volume prefixes', () => {
  const connector = new DataSource();
  connector.type = 'connector';
  connector.generateId();
  assert.ok(connector.id.startsWith('cn-'), `got ${connector.id}`);

  const volume = new DataSource();
  volume.type = 'volume';
  volume.generateId();
  assert.ok(volume.id.startsWith('vol-'), `got ${volume.id}`);

  const preset = new DataSource();
  preset.type = 'connector';
  preset.id = 'cn-existing';
  preset.generateId();
  assert.equal(preset.id, 'cn-existing');
});

test('MCPServer.validateConnection: enforces transport requirements', () => {
  const managed = new MCPServer();
  managed.deploymentType = 'managed';
  assert.doesNotThrow(() => managed.validateConnection());

  const platform = new MCPServer();
  platform.deploymentType = 'platform' as any;
  assert.doesNotThrow(() => platform.validateConnection());

  const stdioMissing = new MCPServer();
  stdioMissing.deploymentType = 'remote' as any;
  stdioMissing.transport = 'stdio' as any;
  assert.throws(() => stdioMissing.validateConnection(), /command is required/);

  const httpMissing = new MCPServer();
  httpMissing.deploymentType = 'remote' as any;
  httpMissing.transport = 'http' as any;
  assert.throws(() => httpMissing.validateConnection(), /url is required/);

  const valid = new MCPServer();
  valid.deploymentType = 'remote' as any;
  valid.transport = 'http' as any;
  valid.url = 'http://server';
  assert.doesNotThrow(() => valid.validateConnection());

  const validStdio = new MCPServer();
  validStdio.deploymentType = 'remote' as any;
  validStdio.transport = 'stdio' as any;
  validStdio.command = 'run-me';
  assert.doesNotThrow(() => validStdio.validateConnection());
});

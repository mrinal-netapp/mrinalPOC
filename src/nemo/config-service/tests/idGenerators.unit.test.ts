/**
 * Unit tests for the short-ID generator family (generate + validate).
 *
 * Run: node --require ts-node/register --test tests/idGenerators.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { AgentIdGenerator } from '../services/AgentIdGenerator';
import { AgentTeamIdGenerator } from '../services/AgentTeamIdGenerator';
import { ArtifactStoreIdGenerator } from '../services/ArtifactStoreIdGenerator';
import { ConnectorIdGenerator } from '../services/ConnectorIdGenerator';
import { DataSetIdGenerator } from '../services/DataSetIdGenerator';
import { KnowledgeBaseIdGenerator } from '../services/KnowledgeBaseIdGenerator';
import { PipelineIdGenerator } from '../services/PipelineIdGenerator';
import { VolumeIdGenerator } from '../services/VolumeIdGenerator';
import { WorkspaceIdGenerator } from '../services/WorkspaceIdGenerator';
import { ProjectIdGenerator } from '../utils/ProjectIdGenerator';

interface PrefixedGen {
  generate(): string;
  validate(id: string): boolean;
}

const prefixed: Array<{ name: string; gen: PrefixedGen; prefix: string; idLen: number }> = [
  { name: 'AgentIdGenerator', gen: AgentIdGenerator, prefix: 'ag-', idLen: 8 },
  { name: 'AgentTeamIdGenerator', gen: AgentTeamIdGenerator, prefix: 'agr-', idLen: 8 },
  { name: 'ArtifactStoreIdGenerator', gen: ArtifactStoreIdGenerator, prefix: 'as', idLen: 8 },
  { name: 'ConnectorIdGenerator', gen: ConnectorIdGenerator, prefix: 'cn-', idLen: 8 },
  { name: 'DataSetIdGenerator', gen: DataSetIdGenerator, prefix: 'dset', idLen: 8 },
  { name: 'KnowledgeBaseIdGenerator', gen: KnowledgeBaseIdGenerator, prefix: 'kb', idLen: 8 },
  { name: 'PipelineIdGenerator', gen: PipelineIdGenerator, prefix: 'pl-', idLen: 8 },
  { name: 'VolumeIdGenerator', gen: VolumeIdGenerator, prefix: 'vol-', idLen: 8 },
];

for (const { name, gen, prefix, idLen } of prefixed) {
  test(`${name}: generate() yields prefix + ${idLen} base36 chars`, () => {
    for (let i = 0; i < 50; i++) {
      const id = gen.generate();
      assert.ok(id.startsWith(prefix), `expected ${id} to start with ${prefix}`);
      const part = id.slice(prefix.length);
      assert.equal(part.length, idLen, `expected ${idLen}-char body for ${id}`);
      assert.match(part, /^[0-9a-z]+$/);
    }
  });

  test(`${name}: validate() accepts generated ids and rejects malformed ones`, () => {
    assert.equal(gen.validate(gen.generate()), true);
    assert.equal(gen.validate(''), false);
    assert.equal(gen.validate(undefined as unknown as string), false);
    assert.equal(gen.validate(123 as unknown as string), false);
    assert.equal(gen.validate('wrongprefix12345'), false);
    assert.equal(gen.validate(prefix + 'AB12CD34'), false); // uppercase
    assert.equal(gen.validate(prefix + 'short'), false); // wrong length
    assert.equal(gen.validate(prefix + 'toolongggggg'), false);
  });

  test(`${name}: generate() is sufficiently unique`, () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(gen.generate());
    assert.ok(seen.size > 190, `expected near-unique ids, got ${seen.size}/200`);
  });
}

test('AgentIdGenerator.generate: pads when base36 conversion is short', (t) => {
  let calls = 0;
  t.mock.method(crypto, 'randomBytes', (n: number) => {
    calls += 1;
    if (calls === 1) return Buffer.alloc(n, 0);
    return Buffer.from([7]);
  });
  const id = AgentIdGenerator.generate();
  assert.match(id, /^ag-[0-9a-z]{8}$/);
});

test('ProjectIdGenerator: generate/validate with proj prefix', () => {
  const id = ProjectIdGenerator.generate();
  assert.ok(id.startsWith('proj'));
  assert.equal(id.length, 12);
  assert.equal(ProjectIdGenerator.validate(id), true);
  assert.equal(ProjectIdGenerator.validate('proj' + 'ABCDEFGH'), false);
  assert.equal(ProjectIdGenerator.validate('xxxxabc12345'), false);
  assert.equal(ProjectIdGenerator.validate('proj123'), false);
  assert.equal(ProjectIdGenerator.validate(null as unknown as string), false);
});

test('WorkspaceIdGenerator: default + bounds + validation', () => {
  const id = WorkspaceIdGenerator.generate();
  assert.equal(id.length, 10);
  assert.match(id, /^[0-9a-z]+$/);
  assert.equal(WorkspaceIdGenerator.validate(id), true);

  assert.equal(WorkspaceIdGenerator.generate(8).length, 8);
  assert.equal(WorkspaceIdGenerator.generate(12).length, 12);
  assert.throws(() => WorkspaceIdGenerator.generate(7), /between 8 and 12/);
  assert.throws(() => WorkspaceIdGenerator.generate(13), /between 8 and 12/);

  assert.equal(WorkspaceIdGenerator.validate(''), false);
  assert.equal(WorkspaceIdGenerator.validate('ABCDEFGH'), false); // uppercase
  assert.equal(WorkspaceIdGenerator.validate('short'), false); // too short
  assert.equal(WorkspaceIdGenerator.validate('toolongworkspaceid'), false);
  assert.equal(WorkspaceIdGenerator.validate(42 as unknown as string), false);
});

test('ArtifactStoreIdGenerator: high-volume generate stays well-formed', () => {
  for (let i = 0; i < 500; i++) {
    const id = ArtifactStoreIdGenerator.generate();
    assert.match(id, /^as[0-9a-z]{8}$/);
  }
});

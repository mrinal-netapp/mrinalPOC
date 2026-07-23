/**
 * Unit tests for services/GuardrailCatalogService.ts.
 *
 * Run: node --require ts-node/register --test tests/GuardrailCatalogService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QueryFailedError } from 'typeorm';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { GuardrailCatalogService } from '../services/GuardrailCatalogService';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

let handle: FakeDataSourceHandle;

function validBody() {
  return {
    key: 'pii_masker',
    stage: 'output' as const,
    displayName: 'PII Masking',
    description: 'Masks PII',
    type: 'privacy',
    supportedActions: ['block', 'modify', 'warn'],
    defaultAction: 'modify',
    message: 'Masked',
    config: { mask_email: true },
    configSchema: {
      type: 'object',
      properties: {
        mask_email: { type: 'boolean', is_required: true, can_override: true },
      },
    },
  };
}

beforeEach(() => {
  handle = installFakeRepositories({});
});

afterEach(() => {
  handle.restore();
});

test('list: applies filters and returns ordered rows', async () => {
  const rows = [{ id: UUID, stage: 'input', key: 'x' }];
  handle.repos.GuardrailCatalog = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: rows }),
  });
  const result = await GuardrailCatalogService.list({ stage: 'input', enabled: true });
  assert.deepEqual(result, rows);
});

test('getById: throws NotFoundError when missing', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({ findOne: async () => null });
  await assert.rejects(() => GuardrailCatalogService.getById(UUID), NotFoundError);
});

test('create: validates config_schema and persists', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: UUID }),
  });
  const created = await GuardrailCatalogService.create(validBody());
  assert.equal(created.id, UUID);
});

test('create: rejects default_action outside supported_actions', async () => {
  await assert.rejects(
    () =>
      GuardrailCatalogService.create({
        ...validBody(),
        defaultAction: 'block',
        supportedActions: ['warn'],
      }),
    ValidationError,
  );
});

test('create: maps unique violation to ConflictError', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({
    create: (d: any) => ({ ...d }),
    save: async () => {
      throw new QueryFailedError('insert', [], { code: '23505' } as any);
    },
  });
  await assert.rejects(() => GuardrailCatalogService.create(validBody()), ConflictError);
});

test('update: merges and re-validates config invariants', async () => {
  const existing = { id: UUID, ...validBody(), stage: 'input' as const };
  let findCount = 0;
  handle.repos.GuardrailCatalog = makeFakeRepo({
    findOne: async () => {
      findCount += 1;
      if (findCount === 1) return existing;
      return { ...existing, displayName: 'Renamed' };
    },
    update: async () => ({ affected: 1 }),
  });
  const updated = await GuardrailCatalogService.update(UUID, { displayName: 'Renamed' });
  assert.equal(updated.displayName, 'Renamed');
});

test('delete: throws when row absent', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({
    delete: async () => ({ affected: 0 }),
  });
  await assert.rejects(() => GuardrailCatalogService.delete(UUID), NotFoundError);
});

test('validateAgentGuardrails: rejects unknown guardrail id', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({ find: async () => [] });
  await assert.rejects(
    () =>
      GuardrailCatalogService.validateAgentGuardrails({
        input_guardrails: [{ guardrail_id: UUID, action: 'block' }],
      }),
    /does not exist/,
  );
});

test('validateAgentGuardrails: rejects stage mismatch', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({
    find: async () => [{ id: UUID, stage: 'output', configSchema: null }],
  });
  await assert.rejects(
    () =>
      GuardrailCatalogService.validateAgentGuardrails({
        input_guardrails: [{ guardrail_id: UUID, action: 'block' }],
      }),
    /cannot be used in input_guardrails/,
  );
});

test('validateAgentGuardrails: accepts valid override config', async () => {
  handle.repos.GuardrailCatalog = makeFakeRepo({
    find: async () => [{ id: UUID, stage: 'input', configSchema: validBody().configSchema }],
  });
  await GuardrailCatalogService.validateAgentGuardrails({
    input_guardrails: [{ guardrail_id: UUID, action: 'block', config: { mask_email: false } }],
  });
});

test('validateAgentGuardrails: rejects non-uuid guardrail_id', async () => {
  await assert.rejects(
    () =>
      GuardrailCatalogService.validateAgentGuardrails({
        output_guardrails: [{ guardrail_id: 'not-a-uuid', action: 'block' }],
      }),
    /not a valid UUID/,
  );
});

test('validateAgentGuardrails: no-op for empty guardrails', async () => {
  await GuardrailCatalogService.validateAgentGuardrails(undefined);
  await GuardrailCatalogService.validateAgentGuardrails({ input_guardrails: [] });
});

test('create: requires config_schema when config is non-empty', async () => {
  await assert.rejects(
    () =>
      GuardrailCatalogService.create({
        ...validBody(),
        config: { mask_email: true },
        configSchema: undefined,
      }),
    /config_schema is required/,
  );
});

test('update: maps unique violation to ConflictError', async () => {
  const existing = { id: UUID, ...validBody(), stage: 'input' as const };
  handle.repos.GuardrailCatalog = makeFakeRepo({
    findOne: async () => existing,
    update: async () => {
      throw new QueryFailedError('update', [], { code: '23505' } as any);
    },
  });
  await assert.rejects(
    () => GuardrailCatalogService.update(UUID, { key: 'dup-key' }),
    ConflictError,
  );
});

test('list: applies key and type filters', async () => {
  const clauses: string[] = [];
  handle.repos.GuardrailCatalog = makeFakeRepo({
    createQueryBuilder: () => {
      const qb = makeQueryBuilder({ many: [] });
      const origAndWhere = qb.andWhere.bind(qb);
      qb.andWhere = (clause: string, params: any) => {
        clauses.push(clause);
        return origAndWhere(clause, params);
      };
      return qb;
    },
  });
  await GuardrailCatalogService.list({ key: 'pii_masker', type: 'privacy' });
  assert.ok(clauses.some((c) => c.includes('g.key')));
  assert.ok(clauses.some((c) => c.includes('g.type')));
});

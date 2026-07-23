/**
 * Smoke tests for the Model TypeORM entity (field defaults and construction).
 *
 * Run: node --require ts-node/register --test tests/models/Model.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Model } from '../../models/Model';

test('Model: isBuiltin defaults to false on new instances', () => {
  const m = new Model();
  assert.equal(m.isBuiltin, false);
});

test('Model: accepts llm and embedding metadata shapes', () => {
  const m = new Model();
  m.id = 'mdl-1';
  m.projectId = 'proj1';
  m.name = 'gpt-4o';
  m.modelType = 'llm';
  m.provider = 'openai';
  m.providerModelId = 'gpt-4o';
  m.gatewayModelId = 'openai/gpt-4o';
  m.gatewayBindingName = 'proj1_cred_gpt-4o';
  m.model_info = { architecture: 'transformer', parameters: 'large' };
  m.rateCardOverride = { _gateway: { keyName: 'k1' } };
  m.rpm = 100;
  m.tpm = 50_000;
  m.spendingLimit = 10;
  m.spendingLimitPeriod = 'month';
  m.inputCostPer1M = 2.5;
  m.outputCostPer1M = 10;
  m.markupPercent = 15;
  m.isBuiltin = true;

  assert.equal(m.isBuiltin, true);
  assert.equal(m.model_info?.architecture, 'transformer');
  assert.equal(m.spendingLimitPeriod, 'month');
});

test('Model: embedding type with limits, auth, and history relation', () => {
  const m = new Model();
  m.id = 'emb-1';
  m.projectId = 'proj1';
  m.name = 'minilm';
  m.displayName = 'MiniLM';
  m.modelType = 'embedding';
  m.provider = 'as-tei-minilm';
  m.providerModelId = 'sentence-transformers/all-MiniLM-L6-v2';
  m.gatewayModelId = 'as-tei-minilm/minilm-binding';
  m.gatewayBindingName = 'minilm-binding';
  m.providerDeploymentName = 'deploy-1';
  m.credentialId = '123e4567-e89b-12d3-a456-426614174000';
  m.modelClass = 'fast';
  m.endpoint = 'http://tei.svc';
  m.auth = { access_token: 'tok', secret_key: 'sec' };
  m.limits = { tpm: 1000, timeout: 30, stream_timeout: 60, max_retries: 3 };
  m.createdAt = new Date('2024-01-01');
  m.updatedAt = new Date('2024-06-01');
  m.history = [];

  assert.equal(m.modelType, 'embedding');
  assert.equal(m.limits?.timeout, 30);
  assert.equal(m.auth?.access_token, 'tok');
  assert.deepEqual(m.history, []);
});

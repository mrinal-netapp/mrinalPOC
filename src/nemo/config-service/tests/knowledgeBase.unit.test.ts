/**
 * Knowledge Base create/update validator tests.
 *
 * Run: `npm run test:kb`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createKnowledgeBaseValidator,
  updateKnowledgeBaseValidator,
} from '../validators/knowledgeBaseValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseKnowledgeBaseCreate } from './helpers/knowledgeBaseFixtures';

const CHUNK_STRATEGIES = ['fixed', 'sentence', 'recursive', 'token', 'markdown'] as const;
const INDEXING_MODES = ['hybrid', 'semantic', 'fts'] as const;
const QUANTIZATION_TYPES = ['auto', 'none', 'ivf_pq', 'scalar', 'ivf_rq'] as const;

test('createKnowledgeBaseValidator: valid default body passes', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate(),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

for (const chunkStrategy of CHUNK_STRATEGIES) {
  test(`createKnowledgeBaseValidator: accepts chunkStrategy ${chunkStrategy}`, async () => {
    const result = await runValidators(createKnowledgeBaseValidator, {
      body: baseKnowledgeBaseCreate({ chunkStrategy }),
    });
    assert.equal(result.isEmpty(), true, validationMessages(result));
  });
}

for (const indexingMode of INDEXING_MODES) {
  test(`createKnowledgeBaseValidator: accepts indexingMode ${indexingMode}`, async () => {
    const result = await runValidators(createKnowledgeBaseValidator, {
      body: baseKnowledgeBaseCreate({ indexingMode }),
    });
    assert.equal(result.isEmpty(), true, validationMessages(result));
  });
}

for (const quantizationType of QUANTIZATION_TYPES) {
  test(`createKnowledgeBaseValidator: accepts quantizationType ${quantizationType}`, async () => {
    const result = await runValidators(createKnowledgeBaseValidator, {
      body: baseKnowledgeBaseCreate({
        quantizationType,
        quantizationOptions: {
          numPartitions: 128,
          numSubVectors: 96,
          efConstruction: 150,
          m: 16,
          numBits: 4,
        },
      }),
    });
    assert.equal(result.isEmpty(), true, validationMessages(result));
  });
}

test('createKnowledgeBaseValidator: rejects invalid chunkStrategy', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ chunkStrategy: 'paragraph' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).length > 0);
});

test('createKnowledgeBaseValidator: rejects invalid indexingMode', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ indexingMode: 'vector_only' }),
  });
  assert.equal(result.isEmpty(), false);
});

test('createKnowledgeBaseValidator: rejects invalid quantizationType', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ quantizationType: 'hnsw_flat' }),
  });
  assert.equal(result.isEmpty(), false);
});

test('createKnowledgeBaseValidator: rejects invalid quantizationOptions subfields', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      quantizationOptions: { numBits: 9 },
    }),
  });
  assert.equal(result.isEmpty(), false);
});

// The UI sends the full synchronizationConfig with schedule fields (incl.
// timezone) set to null whenever sync_mode is not 'scheduled'. This must pass.
for (const syncMode of ['manual', 'after_dataset_updates'] as const) {
  test(`createKnowledgeBaseValidator: accepts non-scheduled sync_mode=${syncMode} with null schedule fields`, async () => {
    const result = await runValidators(createKnowledgeBaseValidator, {
      body: baseKnowledgeBaseCreate({
        synchronizationConfig: {
          sync_mode: syncMode,
          data_change_threshold_enabled: false,
          data_change_threshold_value: null,
          schedule_type: null,
          interval_minutes: null,
          time_of_day: null,
          day_of_week: null,
          day_of_month: null,
          timezone: null,
          cron_expression: null,
        },
      }),
    });
    assert.equal(result.isEmpty(), true, validationMessages(result));
  });
}

test('createKnowledgeBaseValidator: accepts scheduled daily config', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'daily',
        time_of_day: '02:30',
        timezone: 'UTC',
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createKnowledgeBaseValidator: rejects a non-string, non-null timezone', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'manual',
        data_change_threshold_enabled: false,
        timezone: 123,
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
});

test('updateKnowledgeBaseValidator: accepts non-scheduled sync config with null timezone', async () => {
  const result = await runValidators(updateKnowledgeBaseValidator, {
    body: {
      synchronizationConfig: {
        sync_mode: 'manual',
        data_change_threshold_enabled: false,
        data_change_threshold_value: null,
        schedule_type: null,
        interval_minutes: null,
        time_of_day: null,
        day_of_week: null,
        day_of_month: null,
        timezone: null,
        cron_expression: null,
      },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateKnowledgeBaseValidator: PATCH partial fields passes', async () => {
  const result = await runValidators(updateKnowledgeBaseValidator, {
    body: {
      chunkStrategy: 'token',
      chunkOptions: { maxTokens: 256, tokenOverlap: 32 },
      indexingMode: 'semantic',
      quantizationType: 'ivf_pq',
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateKnowledgeBaseValidator: rejects invalid chunkStrategy on PATCH', async () => {
  const result = await runValidators(updateKnowledgeBaseValidator, {
    body: { chunkStrategy: 'ngram' },
  });
  assert.equal(result.isEmpty(), false);
});

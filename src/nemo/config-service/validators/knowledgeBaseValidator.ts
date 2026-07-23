import { body } from 'express-validator';

const VALID_CHUNK_STRATEGIES = ['fixed', 'sentence', 'recursive', 'token', 'markdown'];
const VALID_INDEXING_MODES = ['hybrid', 'semantic', 'fts'];
const VALID_QUANTIZATION_TYPES = ['auto', 'none', 'ivf_pq', 'scalar', 'ivf_rq'];

const VALID_SYNC_MODES = ['manual', 'after_dataset_updates', 'scheduled'] as const;
const VALID_SYNC_SCHEDULE_TYPES = ['hourly', 'daily', 'weekly', 'monthly', 'cron'] as const;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const LABEL_MAX_LENGTH = 64;
const LABELS_MAX_COUNT = 32;

/**
 * Validate the optional `labels` field on KB create/update payloads.
 * Mirrors the shape constraints used by the DataSource and DataSet
 * validators: optional array of non-empty strings, capped on count and
 * per-entry length.
 */
function assertLabelsShape(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new Error('labels must be an array of strings');
  }
  if (value.length > LABELS_MAX_COUNT) {
    throw new Error(`labels may contain at most ${LABELS_MAX_COUNT} entries`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('labels entries must be non-empty strings');
    }
    if (entry.length > LABEL_MAX_LENGTH) {
      throw new Error(`labels entries must be at most ${LABEL_MAX_LENGTH} characters`);
    }
  }
}

/**
 * Validate a `synchronizationConfig` (KBSynchronizationConfig) payload.
 *
 * - sync_mode='scheduled' requires schedule_type
 *   - hourly  requires interval_minutes >= 120
 *   - daily   requires time_of_day (HH:mm)
 *   - weekly  requires day_of_week (0..6 array) and time_of_day
 *   - monthly requires day_of_month (1..31) and time_of_day
 *   - cron    requires cron_expression
 * - data_change_threshold_enabled=true requires data_change_threshold_value >= 1
 */
function assertSynchronizationConfigShape(cfg: unknown): void {
  if (!cfg || typeof cfg !== 'object') return;
  const c = cfg as Record<string, unknown>;

  const syncMode = c.sync_mode as (typeof VALID_SYNC_MODES)[number] | undefined;
  if (!syncMode || !VALID_SYNC_MODES.includes(syncMode)) {
    throw new Error(
      `synchronizationConfig.sync_mode must be one of: ${VALID_SYNC_MODES.join(', ')}`,
    );
  }

  // Treat null like "not provided": the UI sends `timezone: null` (along with
  // the other schedule fields) whenever sync_mode is not 'scheduled', and it
  // defaults to 'UTC' downstream. Only a present, non-null, non-string value is
  // invalid.
  if (c.timezone !== undefined && c.timezone !== null && typeof c.timezone !== 'string') {
    throw new Error('synchronizationConfig.timezone must be a string');
  }

  if (c.data_change_threshold_enabled !== undefined && typeof c.data_change_threshold_enabled !== 'boolean') {
    throw new Error('synchronizationConfig.data_change_threshold_enabled must be a boolean');
  }
  if (c.data_change_threshold_enabled === true) {
    const v = Number(c.data_change_threshold_value);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      throw new Error(
        'synchronizationConfig.data_change_threshold_value must be an integer >= 1 when data_change_threshold_enabled=true',
      );
    }
  }

  if (syncMode !== 'scheduled') {
    return;
  }

  const scheduleType = c.schedule_type as (typeof VALID_SYNC_SCHEDULE_TYPES)[number] | undefined;
  if (!scheduleType || !VALID_SYNC_SCHEDULE_TYPES.includes(scheduleType)) {
    throw new Error(
      `synchronizationConfig.schedule_type must be one of: ${VALID_SYNC_SCHEDULE_TYPES.join(', ')} when sync_mode=scheduled`,
    );
  }

  switch (scheduleType) {
    case 'hourly': {
      const n = Number(c.interval_minutes);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 120) {
        throw new Error(
          'synchronizationConfig.interval_minutes must be an integer >= 120 when schedule_type=hourly',
        );
      }
      break;
    }
    case 'daily': {
      if (typeof c.time_of_day !== 'string' || !TIME_OF_DAY_RE.test(c.time_of_day as string)) {
        throw new Error(
          'synchronizationConfig.time_of_day must match HH:mm (24-hour) when schedule_type=daily',
        );
      }
      break;
    }
    case 'weekly': {
      if (typeof c.time_of_day !== 'string' || !TIME_OF_DAY_RE.test(c.time_of_day as string)) {
        throw new Error(
          'synchronizationConfig.time_of_day must match HH:mm (24-hour) when schedule_type=weekly',
        );
      }
      const dow = c.day_of_week;
      if (!Array.isArray(dow) || dow.length === 0) {
        throw new Error(
          'synchronizationConfig.day_of_week must be a non-empty array of integers 0..6 when schedule_type=weekly',
        );
      }
      for (const d of dow) {
        const n = Number(d);
        if (!Number.isInteger(n) || n < 0 || n > 6) {
          throw new Error('synchronizationConfig.day_of_week entries must be integers between 0 and 6');
        }
      }
      break;
    }
    case 'monthly': {
      if (typeof c.time_of_day !== 'string' || !TIME_OF_DAY_RE.test(c.time_of_day as string)) {
        throw new Error(
          'synchronizationConfig.time_of_day must match HH:mm (24-hour) when schedule_type=monthly',
        );
      }
      const dom = Number(c.day_of_month);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) {
        throw new Error(
          'synchronizationConfig.day_of_month must be an integer between 1 and 31 when schedule_type=monthly',
        );
      }
      break;
    }
    case 'cron': {
      if (typeof c.cron_expression !== 'string' || (c.cron_expression as string).trim() === '') {
        throw new Error('synchronizationConfig.cron_expression is required when schedule_type=cron');
      }
      break;
    }
  }
}

export const createKnowledgeBaseValidator = [
  body('name').isString().notEmpty(),
  body('description').optional().isString(),
  body('sourceDataset').isString().notEmpty(),
  // Accept either `embeddingModelId` (preferred, UUID FK to models) OR the
  // legacy `embeddingModel` (string, looked up by name against the project's
  // seeded catalog). At least one must be supplied — `.custom` enforces this.
  body('embeddingModelId').optional().isUUID(),
  body('embeddingModel').optional().isString(),
  body().custom((value: Record<string, unknown>) => {
    const hasId = typeof value.embeddingModelId === 'string' && value.embeddingModelId.length > 0;
    const hasName = typeof value.embeddingModel === 'string' && value.embeddingModel.length > 0;
    if (!hasId && !hasName) {
      throw new Error('embeddingModelId (uuid) or embeddingModel (name) is required');
    }
    return true;
  }),
  body('chunkSize').isInt({ min: 1 }),
  body('vectorSize').isInt({ min: 1 }),
  body('dataType').optional().isString(), // Deprecated: no longer required
  // Chunking strategy fields
  body('chunkStrategy').optional().isIn(VALID_CHUNK_STRATEGIES),
  body('chunkOverlap').optional().isInt({ min: 0 }),
  body('chunkOptions').optional().isObject(),
  body('chunkOptions.maxSentences').optional().isInt({ min: 1 }),
  body('chunkOptions.overlapSentences').optional().isInt({ min: 0 }),
  body('chunkOptions.maxTokens').optional().isInt({ min: 1 }),
  body('chunkOptions.tokenOverlap').optional().isInt({ min: 0 }),
  body('chunkOptions.splitOnHeaders').optional().isBoolean(),
  // Indexing mode
  body('indexingMode').optional().isIn(VALID_INDEXING_MODES),
  // Quantization fields
  body('quantizationType').optional().isIn(VALID_QUANTIZATION_TYPES),
  body('quantizationOptions').optional().isObject(),
  body('quantizationOptions.numPartitions').optional().isInt({ min: 1 }),
  body('quantizationOptions.numSubVectors').optional().isInt({ min: 1 }),
  body('quantizationOptions.efConstruction').optional().isInt({ min: 1 }),
  body('quantizationOptions.m').optional().isInt({ min: 1 }),
  body('quantizationOptions.numBits').optional().isInt({ min: 1, max: 8 }),
  // Synchronization config
  body('synchronizationConfig').optional().isObject().withMessage('synchronizationConfig must be an object'),
  body('synchronizationConfig').optional().custom((cfg: unknown) => {
    assertSynchronizationConfigShape(cfg);
    return true;
  }),
  body('labels').optional({ values: 'null' }).custom((value: unknown) => {
    assertLabelsShape(value);
    return true;
  }),
];

export const updateKnowledgeBaseValidator = [
  body('name').optional().isString(),
  body('description').optional().isString(),
  body('sourceDataset').optional().isString(),
  body('embeddingModel').optional().isString(),
  body('embeddingModelId').optional().isUUID(),
  body('chunkSize').optional().isInt({ min: 1 }),
  body('vectorSize').optional().isInt({ min: 1 }),
  body('dataType').optional().isString(),
  // Chunking strategy fields
  body('chunkStrategy').optional().isIn(VALID_CHUNK_STRATEGIES),
  body('chunkOverlap').optional().isInt({ min: 0 }),
  body('chunkOptions').optional().isObject(),
  body('chunkOptions.maxSentences').optional().isInt({ min: 1 }),
  body('chunkOptions.overlapSentences').optional().isInt({ min: 0 }),
  body('chunkOptions.maxTokens').optional().isInt({ min: 1 }),
  body('chunkOptions.tokenOverlap').optional().isInt({ min: 0 }),
  body('chunkOptions.splitOnHeaders').optional().isBoolean(),
  // Indexing mode
  body('indexingMode').optional().isIn(VALID_INDEXING_MODES),
  // Quantization fields
  body('quantizationType').optional().isIn(VALID_QUANTIZATION_TYPES),
  body('quantizationOptions').optional().isObject(),
  body('quantizationOptions.numPartitions').optional().isInt({ min: 1 }),
  body('quantizationOptions.numSubVectors').optional().isInt({ min: 1 }),
  body('quantizationOptions.efConstruction').optional().isInt({ min: 1 }),
  body('quantizationOptions.m').optional().isInt({ min: 1 }),
  body('quantizationOptions.numBits').optional().isInt({ min: 1, max: 8 }),
  // Status/stats (set by workflow on completion)
  body('status').optional().isIn(['in_progress', 'ready', 'errored', 'deprecated']),
  body('lanceTablePath').optional().isString(),
  body('errorMessage').optional().isString(),
  body('stats').optional().isObject(),
  body('stats.documentCount').optional().isInt({ min: 0 }),
  body('stats.chunkCount').optional().isInt({ min: 0 }),
  body('stats.vectorCount').optional().isInt({ min: 0 }),
  body('stats.storageBytes').optional().isInt({ min: 0 }),
  body('stats.storageMB').optional().isFloat({ min: 0 }),
  body('stats.fileCount').optional().isInt({ min: 0 }),
  body('stats.lastProcessedAt').optional().isString(),
  // Synchronization config
  body('synchronizationConfig').optional().isObject().withMessage('synchronizationConfig must be an object'),
  body('synchronizationConfig').optional().custom((cfg: unknown) => {
    assertSynchronizationConfigShape(cfg);
    return true;
  }),
  body('labels').optional({ values: 'null' }).custom((value: unknown) => {
    assertLabelsShape(value);
    return true;
  }),
  // lastSyncedAt is set by the workflow on success
  body('lastSyncedAt').optional().isString(),
];

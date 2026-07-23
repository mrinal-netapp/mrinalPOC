import { body } from 'express-validator';
import { validateDatasetName } from '../utils/datasetNameValidation';

/**
 * Validate the optional new acquisition filter fields:
 *  - fileIncludePattern: string glob list (e.g. "*.csv,*.parquet")
 *  - maxFileSize: positive integer in bytes
 *  - modifiedAfter: ISO-8601 date-time
 * Used by both create and update validators below.
 */
function assertAcquisitionFilterShape(cfg: unknown): void {
  if (!cfg || typeof cfg !== 'object') return;
  const c = cfg as Record<string, unknown>;
  if (c.fileIncludePattern !== undefined && typeof c.fileIncludePattern !== 'string') {
    throw new Error('acquisitionConfig.fileIncludePattern must be a string');
  }
  if (c.maxFileSize !== undefined) {
    const n = Number(c.maxFileSize);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error('acquisitionConfig.maxFileSize must be a positive integer (bytes)');
    }
  }
  if (c.modifiedAfter !== undefined) {
    if (typeof c.modifiedAfter !== 'string' || Number.isNaN(Date.parse(c.modifiedAfter))) {
      throw new Error('acquisitionConfig.modifiedAfter must be an ISO-8601 date-time string');
    }
  }
}

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isMetricCategorySelectorEntry(entry: unknown): boolean {
  return Boolean(
    entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).category === 'string',
  );
}

function resourceSelectorHasMetricCategory(selector: unknown): boolean {
  return Array.isArray(selector) && selector.some(isMetricCategorySelectorEntry);
}

const LABEL_MAX_LENGTH = 64;
const LABELS_MAX_COUNT = 32;

/**
 * Validate the optional `labels` field on create/update payloads.
 * Same shape constraints as the DataSource validator: an optional array
 * of non-empty strings, capped on count and per-entry length.
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
 * Validate a `refresh_config` (DatasetRefreshConfig) payload per `schedule_type`.
 * - hourly  requires interval_minutes >= 120
 * - daily   requires time_of_day (HH:mm)
 * - weekly  requires day_of_week (0..6 array) and time_of_day
 * - monthly requires day_of_month (1..31) and time_of_day
 * - cron    requires cron_expression
 */
function assertRefreshConfigShape(cfg: unknown): void {
  if (!cfg || typeof cfg !== 'object') return;
  const c = cfg as Record<string, unknown>;
  if (typeof c.auto_refresh_enabled !== 'boolean') {
    throw new Error('refresh_config.auto_refresh_enabled must be a boolean');
  }
  if (c.paused !== undefined && typeof c.paused !== 'boolean') {
    throw new Error('refresh_config.paused must be a boolean');
  }
  const validTypes = ['hourly', 'daily', 'weekly', 'monthly', 'cron'] as const;
  const scheduleType = c.schedule_type as (typeof validTypes)[number] | undefined;
  if (!scheduleType || !validTypes.includes(scheduleType)) {
    throw new Error(`refresh_config.schedule_type must be one of: ${validTypes.join(', ')}`);
  }
  if (c.timezone !== undefined && typeof c.timezone !== 'string') {
    throw new Error('refresh_config.timezone must be a string');
  }
  switch (scheduleType) {
    case 'hourly': {
      const n = Number(c.interval_minutes);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 120) {
        throw new Error('refresh_config.interval_minutes must be an integer >= 120 when schedule_type=hourly');
      }
      break;
    }
    case 'daily': {
      if (typeof c.time_of_day !== 'string' || !TIME_OF_DAY_RE.test(c.time_of_day as string)) {
        throw new Error('refresh_config.time_of_day must match HH:mm (24-hour) when schedule_type=daily');
      }
      break;
    }
    case 'weekly': {
      if (typeof c.time_of_day !== 'string' || !TIME_OF_DAY_RE.test(c.time_of_day as string)) {
        throw new Error('refresh_config.time_of_day must match HH:mm (24-hour) when schedule_type=weekly');
      }
      const dow = c.day_of_week;
      if (!Array.isArray(dow) || dow.length === 0) {
        throw new Error('refresh_config.day_of_week must be a non-empty array of integers 0..6 when schedule_type=weekly');
      }
      for (const d of dow) {
        const n = Number(d);
        if (!Number.isInteger(n) || n < 0 || n > 6) {
          throw new Error('refresh_config.day_of_week entries must be integers between 0 and 6');
        }
      }
      break;
    }
    case 'monthly': {
      if (typeof c.time_of_day !== 'string' || !TIME_OF_DAY_RE.test(c.time_of_day as string)) {
        throw new Error('refresh_config.time_of_day must match HH:mm (24-hour) when schedule_type=monthly');
      }
      const dom = Number(c.day_of_month);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) {
        throw new Error('refresh_config.day_of_month must be an integer between 1 and 31 when schedule_type=monthly');
      }
      break;
    }
    case 'cron': {
      if (typeof c.cron_expression !== 'string' || c.cron_expression.trim() === '') {
        throw new Error('refresh_config.cron_expression is required when schedule_type=cron');
      }
      break;
    }
  }
}

export const createDataSetValidator = [
  body('name')
    .isString()
    .notEmpty()
    .withMessage('Dataset name is required')
    .custom((value: string) => {
      const validation = validateDatasetName(value);
      if (!validation.valid) {
        throw new Error(validation.error || 'Invalid dataset name');
      }
      return true;
    })
    .withMessage((value: string) => {
      const validation = validateDatasetName(value);
      return validation.error || 'Invalid dataset name';
    }),
  body('description').optional({ values: 'falsy' }).isString().withMessage('description must be a string'),
  body('type').isString().isIn(['acquired', 'manual']),
  body('originConnector').optional().isString(),
  body('originVolume').optional().isString().withMessage('originVolume must be a string if provided'),
  body('origin_volume').optional().isString(),
  body().custom((_, { req }) => {
    if (req.body?.type !== 'acquired') {
      return true;
    }
    const c = req.body?.originConnector;
    const v = req.body?.originVolume || req.body?.origin_volume;
    const hasC = Boolean(c && String(c).trim());
    const hasV = Boolean(v && String(v).trim());
    if (hasC && hasV) {
      throw new Error('Set only one of originConnector or originVolume, not both');
    }
    if (hasC || hasV) {
      return true;
    }
    throw new Error('Acquired datasets require originConnector or originVolume');
  }),
  body('kind').isString().isIn(['unstructured', 'structured']),
  body('uploadedFiles').optional().isArray(),
  body('filterSpec').optional().isObject(),
  body('fileProcessors').optional().isArray(),
  body('sqlQuery')
    .if((_, { req }) =>
      req.body?.kind === 'structured' && !resourceSelectorHasMetricCategory(req.body?.resourceSelector),
    )
    .isString()
    .notEmpty(),
  body('sourceDatabase').optional().isString().withMessage('sourceDatabase must be a string if provided'),
  body('sourceSchema').optional().isString().withMessage('sourceSchema must be a string if provided'),
  body('enablePiiAnalysis').optional().isBoolean().withMessage('enablePiiAnalysis must be a boolean'),
  body('piiAnalysisImageOnly').optional().isBoolean().withMessage('piiAnalysisImageOnly must be a boolean'),
  body('resourceSelector').optional().isArray().withMessage('resourceSelector must be an array'),
  body('acquisitionConfig').optional().isObject().withMessage('acquisitionConfig must be an object'),
  body('acquisitionConfig').optional().custom((cfg: unknown) => {
    assertAcquisitionFilterShape(cfg);
    return true;
  }),
  body('scheduleConfig').optional().isObject().withMessage('scheduleConfig must be an object'),
  body('refresh_config').optional().isObject().withMessage('refresh_config must be an object'),
  body('refresh_config').optional().custom((cfg: unknown) => {
    assertRefreshConfigShape(cfg);
    return true;
  }),
  body('refreshConfig').optional().isObject().withMessage('refreshConfig must be an object'),
  body('refreshConfig').optional().custom((cfg: unknown) => {
    assertRefreshConfigShape(cfg);
    return true;
  }),
  body('labels').optional({ values: 'null' }).custom((value: unknown) => {
    assertLabelsShape(value);
    return true;
  }),
  // Metrics-as-resource guardrails (mirrors the wizard + workflow checks).
  // The dataset's resourceSelector can mix metric_category entries with other
  // shapes only by accident — the workflow dispatches AcquireMetrics solely on
  // category presence and the metrics adapter cannot consume non-metric
  // entries. Reject mixed selectors at write time so we never persist an
  // ambiguous dataset.
  body().custom((_, { req }) => {
    const selector = req.body?.resourceSelector;
    if (!Array.isArray(selector) || selector.length === 0) return true;
    const hasMetric = selector.some(isMetricCategorySelectorEntry);
    if (!hasMetric) return true;
    const hasNonMetric = selector.some((e) => !isMetricCategorySelectorEntry(e));
    if (hasNonMetric) {
      throw new Error(
        'resourceSelector cannot mix metric_category entries with other resource shapes; create a separate dataset for the metric categories',
      );
    }
    if (req.body?.kind && req.body.kind !== 'structured') {
      throw new Error('Datasets that select metric categories must have kind="structured"');
    }
    const writeMode = req.body?.acquisitionConfig?.writeMode;
    if (writeMode && writeMode !== 'append' && writeMode !== 'incremental') {
      throw new Error(
        `acquisitionConfig.writeMode=${writeMode} is not supported for metric_category datasets in v1 (use append or incremental)`,
      );
    }
    return true;
  }),
];

export const updateDataSetValidator = [
  body().custom((_, { req }) => {
    const c = req.body?.originConnector;
    const v = req.body?.originVolume || req.body?.origin_volume;
    if (c === undefined && v === undefined) {
      return true;
    }
    const hasC = c !== undefined && String(c).trim() !== '';
    const hasV = v !== undefined && String(v).trim() !== '';
    if (hasC && hasV) {
      throw new Error('Set only one of originConnector or originVolume, not both');
    }
    return true;
  }),
  body('name')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Dataset name cannot be empty')
    .custom((value: string) => {
      if (value) {
        const validation = validateDatasetName(value);
        if (!validation.valid) {
          throw new Error(validation.error || 'Invalid dataset name');
        }
      }
      return true;
    })
    .withMessage((value: string) => {
      if (value) {
        const validation = validateDatasetName(value);
        return validation.error || 'Invalid dataset name';
      }
      return 'Invalid dataset name';
    }),
  body('description').optional().isString(),
  body('type').optional().isString().isIn(['acquired', 'manual']),
  body('originConnector').optional().isString(),
  body('originVolume').optional().isString(),
  body('origin_volume').optional().isString(),
  body('kind').optional().isString().isIn(['unstructured', 'structured']),
  body('uploadedFiles').optional().isArray(),
  body('filterSpec').optional().isObject(),
  body('fileProcessors').optional().isArray(),
  body('sqlQuery').optional().isString(),
  body('sourceDatabase').optional().isString(),
  body('sourceSchema').optional().isString(),
  body('enablePiiAnalysis').optional().isBoolean(),
  body('piiAnalysisImageOnly').optional().isBoolean(),
  body('resourceSelector').optional().isArray(),
  body('acquisitionConfig').optional().isObject(),
  body('acquisitionConfig').optional().custom((cfg: unknown) => {
    assertAcquisitionFilterShape(cfg);
    return true;
  }),
  body('scheduleConfig').optional().isObject(),
  body('refresh_config').optional().isObject(),
  body('refresh_config').optional().custom((cfg: unknown) => {
    assertRefreshConfigShape(cfg);
    return true;
  }),
  body('refreshConfig').optional().isObject(),
  body('refreshConfig').optional().custom((cfg: unknown) => {
    assertRefreshConfigShape(cfg);
    return true;
  }),
  body('labels').optional({ values: 'null' }).custom((value: unknown) => {
    assertLabelsShape(value);
    return true;
  }),
  body().custom((_, { req }) => {
    const selector = req.body?.resourceSelector;
    if (!Array.isArray(selector) || selector.length === 0) return true;
    const hasMetric = selector.some(isMetricCategorySelectorEntry);
    if (!hasMetric) return true;
    const hasNonMetric = selector.some((e) => !isMetricCategorySelectorEntry(e));
    if (hasNonMetric) {
      throw new Error(
        'resourceSelector cannot mix metric_category entries with other resource shapes; create a separate dataset for the metric categories',
      );
    }
    if (req.body?.kind && req.body.kind !== 'structured') {
      throw new Error('Datasets that select metric categories must have kind="structured"');
    }
    const writeMode = req.body?.acquisitionConfig?.writeMode;
    if (writeMode && writeMode !== 'append' && writeMode !== 'incremental') {
      throw new Error(
        `acquisitionConfig.writeMode=${writeMode} is not supported for metric_category datasets in v1 (use append or incremental)`,
      );
    }
    return true;
  }),
];

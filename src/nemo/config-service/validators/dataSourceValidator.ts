import { body, query } from 'express-validator';
import { validateConnectorConfig, getProviderIds } from '../services/ProviderCatalogService';

const SCAN_DEPTH_VALUES = ['none', 'all_levels', 'top_5_levels', 'top_2_levels', 'custom'] as const;

const LABEL_MAX_LENGTH = 64;
const LABELS_MAX_COUNT = 32;

/**
 * Validates the optional `labels` field on create/update payloads. Labels
 * are free-form tags persisted as a TEXT[] column; we cap both the number
 * of labels and the length of each entry to keep the column small and
 * indexable.
 */
function validateLabelsArray(value: unknown): true {
  if (value === undefined || value === null) return true;
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
  return true;
}

/**
 * Validates a scan_config object: enforces scan_depth enum and the conditional
 * relationship between scan_depth='custom' and custom_depth.
 * Throws on invalid input so express-validator surfaces a 400.
 */
function validateScanConfigObject(config: any): true {
  if (config === undefined || config === null) return true;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('scan_config must be an object');
  }
  const { scan_depth, custom_depth } = config;
  if (!SCAN_DEPTH_VALUES.includes(scan_depth)) {
    throw new Error(
      `scan_config.scan_depth must be one of: ${SCAN_DEPTH_VALUES.join(', ')}`
    );
  }
  if (scan_depth === 'custom') {
    if (custom_depth === undefined || custom_depth === null) {
      throw new Error('scan_config.custom_depth is required when scan_depth is "custom"');
    }
    if (!Number.isInteger(custom_depth) || custom_depth < 1 || custom_depth > 100) {
      throw new Error('scan_config.custom_depth must be an integer between 1 and 100');
    }
  } else if (custom_depth !== undefined && custom_depth !== null) {
    throw new Error('scan_config.custom_depth is only allowed when scan_depth is "custom"');
  }
  const allowed = new Set(['scan_depth', 'custom_depth']);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      throw new Error(`scan_config: unknown field '${key}'`);
    }
  }
  return true;
}

export const createDataSourceValidator = [
  body('name').isString().withMessage('name must be a string').notEmpty().withMessage('Name is required'),
  body('type').isString().withMessage('type must be a string').isIn(['volume', 'connector']).withMessage('Type must be volume or connector'),
  body('description').optional({ values: 'falsy' }).isString().withMessage('description must be a string'),
  // Volume fields
  body('volume_config').if(body('type').equals('volume')).isObject().withMessage('volume_config is required for type volume'),
  body('volume_config.region').if(body('type').equals('volume')).isString().withMessage('volume_config.region must be a string').notEmpty().withMessage('volume_config.region is required'),
  body('volume_config.volume_info').if(body('type').equals('volume')).isObject().withMessage('volume_config.volume_info must be an object'),
  body('volume_config.volume_info.type').if(body('type').equals('volume')).isString().withMessage('volume_config.volume_info.type must be a string').notEmpty().withMessage('volume_config.volume_info.type is required'),
  body('volume_config.auth_info').if(body('type').equals('volume')).isObject().withMessage('volume_config.auth_info must be an object'),
  body('volume_config.protocol').if(body('type').equals('volume')).isString().withMessage('volume_config.protocol must be a string').notEmpty().withMessage('volume_config.protocol is required'),
  // Connector fields: scope + provider required, then catalog-driven validation
  body('connector_config').if(body('type').equals('connector'))
    .isObject().withMessage('connector_config is required for type connector')
    .custom((config) => {
      if (!config.scope || !['account', 'resource'].includes(config.scope)) {
        throw new Error('connector_config.scope must be "account" or "resource"');
      }
      if (!config.provider) {
        throw new Error('connector_config.provider is required');
      }
      const validProviders = getProviderIds();
      if (!validProviders.includes(config.provider)) {
        throw new Error(`Unknown provider: ${config.provider}. Valid providers: ${validProviders.join(', ')}`);
      }

      // The legacy `metrics` connector type was merged into the primary
      // connectors (ONTAP, GCP). Metric acquisition is now driven by
      // metric_category resourceSelector entries on those primary connectors.
      if (!['database', 'objectstore', 'cloud', 'storage', 'api'].includes(config.connector_type)) {
        throw new Error('connector_type must be database, objectstore, cloud, storage, or api');
      }

      const { scope, provider, connector_type, database_type, ...providerFields } = config;
      const result = validateConnectorConfig(provider, scope, providerFields);
      if (!result.valid) {
        throw new Error(result.errors.join('; '));
      }

      return true;
    }),
  body('credential_id').if(body('type').equals('connector'))
    .isString().withMessage('credential_id must be a string').notEmpty().withMessage('credential_id is required for connectors'),
  body('metadata').optional({ values: 'falsy' }).isObject().withMessage('metadata must be an object'),
  body('labels').optional({ values: 'null' }).custom((value) => validateLabelsArray(value)),
  // scan_config is volume-only and constrained.
  body('scan_config').optional({ values: 'null' }).custom((cfg, { req }) => {
    if (cfg === undefined || cfg === null) return true;
    if (req.body?.type === 'connector') {
      throw new Error('scan_config is only allowed when type is "volume"');
    }
    return validateScanConfigObject(cfg);
  }),
];

export const updateDataSourceValidator = [
  body('name').optional().isString(),
  body('description').optional().isString(),
  body('volume_config').optional().isObject(),
  body('connector_config').optional().isObject(),
  body('credential_id').optional().isString(),
  body('metadata').optional().isObject(),
  body('labels').optional({ values: 'null' }).custom((value) => validateLabelsArray(value)),
  body('deprecated').optional().isBoolean().withMessage('deprecated must be a boolean'),
  body('mount_health').optional().isObject(),
  body('scan_config').optional({ values: 'null' }).custom((cfg) => {
    if (cfg === undefined || cfg === null) return true;
    return validateScanConfigObject(cfg);
  }),
];

export const listDataSourceQueryValidator = [
  query('type').optional().isString().isIn(['volume', 'connector']).withMessage('type must be one of: volume, connector'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be an integer between 1 and 100'),
  query('skip').optional().isInt({ min: 0 }).withMessage('skip must be an integer >= 0'),
];

/**
 * Validator for the manual rescan trigger body (POST /datasources/:id/scan).
 * Both fields are optional; if scan_config is present it must be valid.
 */
export const scanDataSourceValidator = [
  body('scan_config').optional({ values: 'null' }).custom((cfg) => {
    if (cfg === undefined || cfg === null) return true;
    return validateScanConfigObject(cfg);
  }),
];

/**
 * Validator for the internal workflow-engine callback. Requires scan_status
 * with a valid state; scan_result is optional (omitted on early/failure
 * transitions).
 */
export const scanCallbackValidator = [
  body('scan_status').isObject().withMessage('scan_status object is required').custom((status) => {
    const validStates = ['pending', 'scanning', 'completed', 'failed', 'skipped'];
    if (!status || !validStates.includes(status.state)) {
      throw new Error(`scan_status.state must be one of: ${validStates.join(', ')}`);
    }
    return true;
  }),
  body('scan_result').optional().isObject().custom((result) => {
    if (result === undefined || result === null) return true;
    const required = ['completed_at', 'total_files', 'total_folders', 'total_size_bytes', 'file_type_stats'];
    for (const key of required) {
      if (!(key in result)) {
        throw new Error(`scan_result.${key} is required`);
      }
    }
    if (!Array.isArray(result.file_type_stats)) {
      throw new Error('scan_result.file_type_stats must be an array');
    }
    return true;
  }),
];

/** Validator for GET /datasources/:id/datasets query params. */
export const listAssociatedDataSetsQueryValidator = [
  query('limit').optional().isInt({ min: 1, max: 1000 }),
  query('skip').optional().isInt({ min: 0 }),
  query('nameRegex').optional().isString(),
  query('includeManual').optional().isBoolean(),
];

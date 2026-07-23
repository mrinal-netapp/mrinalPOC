import { body } from 'express-validator';
import { getCatalogEntryIds } from '../catalog/mcpServerCatalog';

const SEP986_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

export const createMCPServerValidator = [
  body('name')
    .isString()
    .notEmpty()
    .matches(SEP986_NAME_REGEX)
    .withMessage('Name must be alphanumeric with underscores only'),
  body('deploymentType')
    .optional()
    .isIn(['remote', 'managed'])
    .withMessage('deploymentType must be remote or managed'),
  body('catalogId')
    .optional()
    .isString()
    .custom((value, { req }) => {
      if (req.body.deploymentType === 'managed') {
        if (!value) throw new Error('catalogId is required for managed deployment');
        if (!getCatalogEntryIds().includes(value)) throw new Error(`Unknown catalog ID: ${value}`);
      }
      return true;
    }),
  body('managedConfig').optional().isObject(),
  body('managedConfig.resourcePreset')
    .optional()
    .isIn(['small', 'medium', 'large'])
    .withMessage('resourcePreset must be small, medium, or large'),
  body('managedConfig.envOverrides').optional().isObject(),
  body('managedConfig.volumeSize').optional().isString(),
  body().custom((value) => {
    if (value.deploymentType === 'managed') {
      return true;
    }
    if (!value.transport) {
      throw new Error('transport is required for remote deployment');
    }
    if (value.transport === 'stdio' && !value.command) {
      throw new Error('command is required for stdio transport');
    }
    if (['http', 'sse', 'streamable-http'].includes(value.transport) && !value.url) {
      throw new Error('url is required for http/sse/streamable-http transport');
    }
    return true;
  }),
  body('transport')
    .optional()
    .isIn(['http', 'sse', 'stdio', 'streamable-http'])
    .withMessage('transport must be http, sse, stdio, or streamable-http'),
  body('description').optional().isString(),
  body('url').optional().isString(),
  body('command').optional().isString(),
  body('args').optional().isArray(),
  body('env').optional().isObject(),
  body('authType')
    .optional()
    .isIn(['none', 'api_key', 'bearer_token', 'basic', 'oauth2']),
  body('credentialId').optional({ values: 'null' }).isUUID(),
  body('runtimeCredentialId').optional({ values: 'null' }).isUUID(),
  body('authorizationUrl').optional({ values: 'null' }).isString(),
  body('tokenUrl').optional({ values: 'null' }).isString(),
  body('staticHeaders').optional().isObject(),
  body('queryParams').optional().isArray(),
  body('queryParams.*.name').optional().isString().notEmpty(),
  body('queryParams.*.value').optional().isString(),
  body('queryParams.*.enabled').optional().isBoolean(),
  body('queryParams.*.secretRef').optional().isObject(),
  body('queryParams.*.secretRef.credentialId').optional().isUUID(),
  body('queryParams.*.secretRef.field').optional().isString().notEmpty(),
  body('headerParams').optional().isArray(),
  body('headerParams.*.name').optional().isString().notEmpty(),
  body('headerParams.*.value').optional().isString(),
  body('headerParams.*.enabled').optional().isBoolean(),
  body('headerParams.*.secretRef').optional().isObject(),
  body('headerParams.*.secretRef.credentialId').optional().isUUID(),
  body('headerParams.*.secretRef.field').optional().isString().notEmpty(),
  body('authConfig').optional().isObject(),
  body('authConfig.location').optional().isIn(['header', 'query', 'cookie']),
  body('authConfig.keyName').optional().isString().notEmpty(),
  body('authConfig.prefix').optional().isString(),
  body('authConfig.secretRef').optional().isObject(),
  body('authConfig.secretRef.credentialId').optional().isUUID(),
  body('authConfig.secretRef.field').optional().isString().notEmpty(),
  body('extraHeaders').optional().isArray(),
  body('allowedTools').optional().isArray(),
  body('disallowedTools').optional().isArray(),
  body('specPath').optional({ values: 'null' }).isString(),
  body('timeout').optional().isInt({ min: 1 }),
  body('trust').optional().isBoolean(),
];

export const updateMCPServerValidator = [
  body('name')
    .optional()
    .isString()
    .matches(SEP986_NAME_REGEX)
    .withMessage('Name must be alphanumeric with underscores only'),
  body('managedConfig').optional().isObject(),
  body('managedConfig.resourcePreset')
    .optional()
    .isIn(['small', 'medium', 'large']),
  body('managedConfig.envOverrides').optional().isObject(),
  body('managedConfig.volumeSize').optional().isString(),
  body('transport')
    .optional()
    .isIn(['http', 'sse', 'stdio', 'streamable-http']),
  body().custom((value) => {
    if (value.transport === 'stdio' && value.url !== undefined && !value.command) {
      throw new Error('command is required when switching to stdio transport');
    }
    if (['http', 'sse', 'streamable-http'].includes(value.transport) && value.command !== undefined && !value.url) {
      throw new Error('url is required when switching to http/sse/streamable-http transport');
    }
    if (value.transport === 'stdio' && value.command === '') {
      throw new Error('command cannot be empty for stdio transport');
    }
    if (['http', 'sse', 'streamable-http'].includes(value.transport) && value.url === '') {
      throw new Error('url cannot be empty for http/sse/streamable-http transport');
    }
    return true;
  }),
  body('description').optional().isString(),
  body('url').optional({ values: 'null' }).isString(),
  body('command').optional({ values: 'null' }).isString(),
  body('args').optional().isArray(),
  body('env').optional().isObject(),
  body('authType')
    .optional()
    .isIn(['none', 'api_key', 'bearer_token', 'basic', 'oauth2']),
  body('credentialId').optional({ values: 'null' }).isUUID(),
  body('runtimeCredentialId').optional({ values: 'null' }).isUUID(),
  body('authorizationUrl').optional({ values: 'null' }).isString(),
  body('tokenUrl').optional({ values: 'null' }).isString(),
  body('staticHeaders').optional().isObject(),
  body('queryParams').optional().isArray(),
  body('queryParams.*.name').optional().isString().notEmpty(),
  body('queryParams.*.value').optional().isString(),
  body('queryParams.*.enabled').optional().isBoolean(),
  body('queryParams.*.secretRef').optional().isObject(),
  body('queryParams.*.secretRef.credentialId').optional().isUUID(),
  body('queryParams.*.secretRef.field').optional().isString().notEmpty(),
  body('headerParams').optional().isArray(),
  body('headerParams.*.name').optional().isString().notEmpty(),
  body('headerParams.*.value').optional().isString(),
  body('headerParams.*.enabled').optional().isBoolean(),
  body('headerParams.*.secretRef').optional().isObject(),
  body('headerParams.*.secretRef.credentialId').optional().isUUID(),
  body('headerParams.*.secretRef.field').optional().isString().notEmpty(),
  body('authConfig').optional().isObject(),
  body('authConfig.location').optional().isIn(['header', 'query', 'cookie']),
  body('authConfig.keyName').optional().isString().notEmpty(),
  body('authConfig.prefix').optional().isString(),
  body('authConfig.secretRef').optional().isObject(),
  body('authConfig.secretRef.credentialId').optional().isUUID(),
  body('authConfig.secretRef.field').optional().isString().notEmpty(),
  body('extraHeaders').optional().isArray(),
  body('allowedTools').optional().isArray(),
  body('disallowedTools').optional().isArray(),
  body('specPath').optional({ values: 'null' }).isString(),
  body('timeout').optional().isInt({ min: 1 }),
  body('trust').optional().isBoolean(),
];

import { body, query, ValidationChain } from 'express-validator';

const VALID_STAGES = ['input', 'output', 'tool'] as const;

/**
 * Body validation for creating a guardrail catalog entry. `key` correctness
 * (matching a runtime implementation) is intentionally NOT validated here — the
 * catalog is populated via this API and `key` is the caller's responsibility.
 */
export const createGuardrailCatalogValidator: ValidationChain[] = [
  body('key').isString().notEmpty().withMessage('key is required').trim(),
  body('stage').isIn(VALID_STAGES as unknown as string[]).withMessage(`stage must be one of: ${VALID_STAGES.join(', ')}`),
  body('display_name').isString().notEmpty().withMessage('display_name is required').trim(),
  body('description').isString().notEmpty().withMessage('description is required').trim(),
  body('type').isString().notEmpty().withMessage('type is required').trim(),
  body('supported_actions').isArray({ min: 1 }).withMessage('supported_actions must be a non-empty array'),
  body('supported_actions.*').isString(),
  body('enabled').optional().isBoolean(),
  body('priority').optional().isInt(),
  body('default_action').isString().notEmpty().withMessage('default_action is required').trim(),
  body('message').isString().notEmpty().withMessage('message is required').trim(),
  body('config').optional().isObject(),
  body('config_schema').optional({ values: 'null' }).isObject(),
  body('version').optional().isInt({ min: 1 }),
  // `default_action` must be within `supported_actions`.
  body('default_action').custom((defaultAction: string, { req }) => {
    const supported = req.body?.supported_actions;
    if (Array.isArray(supported) && !supported.includes(defaultAction)) {
      throw new Error(`default_action must be one of supported_actions: ${supported.join(', ')}`);
    }
    return true;
  }),
];

const optNull = { values: 'null' as const };

/** Body validation for updating a guardrail catalog entry (all fields optional). */
export const updateGuardrailCatalogValidator: ValidationChain[] = [
  body('key').optional().isString().notEmpty().trim(),
  body('stage').optional().isIn(VALID_STAGES as unknown as string[]),
  body('display_name').optional().isString().notEmpty().trim(),
  body('description').optional().isString().notEmpty(),
  body('type').optional().isString().notEmpty().trim(),
  body('supported_actions').optional().isArray({ min: 1 }),
  body('supported_actions.*').optional().isString(),
  body('enabled').optional().isBoolean(),
  body('priority').optional().isInt(),
  body('default_action').optional().isString().notEmpty().trim(),
  body('message').optional().isString().notEmpty(),
  body('config').optional().isObject(),
  body('config_schema').optional(optNull).isObject(),
  body('version').optional().isInt({ min: 1 }),
];

/** Query-param validation for the list endpoint (all filters optional). */
export const listGuardrailCatalogValidator: ValidationChain[] = [
  query('id').optional().isUUID().withMessage('id must be a UUID'),
  query('key').optional().isString().notEmpty(),
  query('stage').optional().isIn(VALID_STAGES as unknown as string[]),
  query('type').optional().isString().notEmpty(),
  query('enabled').optional().isBoolean().withMessage('enabled must be a boolean'),
];

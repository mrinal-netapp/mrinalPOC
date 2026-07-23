import { Router, Request, Response } from 'express';
import { param } from 'express-validator';
import { GuardrailCatalogService, GuardrailCatalogFilters } from '../services/GuardrailCatalogService';
import { GuardrailCatalog } from '../models/GuardrailCatalog';
import {
  createGuardrailCatalogValidator,
  updateGuardrailCatalogValidator,
  listGuardrailCatalogValidator,
} from '../validators/guardrailCatalogValidator';
import { asyncHandler, validateRequest, sendSuccess } from '../utils/routeHandler';

const router = Router();

/** Validate the `:id` path param is a UUID so a bad id returns 400, not a Postgres cast 500. */
const idParamValidator = [param('id').isUUID().withMessage('id must be a UUID')];

/**
 * Map the request body to the entity column names (snake_case body fields map
 * to camelCase entity properties for the renamed columns).
 */
function bodyToEntity(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...body };
  if ('display_name' in body) {
    out.displayName = body.display_name;
    delete out.display_name;
  }
  if ('supported_actions' in body) {
    out.supportedActions = body.supported_actions;
    delete out.supported_actions;
  }
  if ('default_action' in body) {
    out.defaultAction = body.default_action;
    delete out.default_action;
  }
  if ('config_schema' in body) {
    out.configSchema = body.config_schema;
    delete out.config_schema;
  }
  return out;
}

/**
 * Map a stored entity back to the snake_case API response shape, so responses
 * match the request body fields and the OpenAPI `GuardrailCatalog` schema
 * (the entity serializes camelCase property names by default).
 */
function entityToResponse(entity: GuardrailCatalog): Record<string, any> {
  const { displayName, supportedActions, defaultAction, configSchema, createdAt, updatedAt, ...rest } =
    entity;
  return {
    ...rest,
    display_name: displayName,
    supported_actions: supportedActions,
    default_action: defaultAction,
    config_schema: configSchema,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * GET /api/v1/guardrails
 * List all guardrail definitions. Optional, AND-combined filters:
 * id, key, stage, type, enabled. No filters returns the complete set.
 */
router.get(
  '/',
  listGuardrailCatalogValidator,
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateRequest(req, res)) return;
    const filters: GuardrailCatalogFilters = {};
    if (typeof req.query.id === 'string') filters.id = req.query.id;
    if (typeof req.query.key === 'string') filters.key = req.query.key;
    if (typeof req.query.stage === 'string') filters.stage = req.query.stage;
    if (typeof req.query.type === 'string') filters.type = req.query.type;
    if (req.query.enabled !== undefined) filters.enabled = String(req.query.enabled).toLowerCase() === 'true';
    const items = await GuardrailCatalogService.list(filters);
    sendSuccess(res, items.map(entityToResponse));
  }),
);

/**
 * POST /api/v1/guardrails
 * Create a guardrail definition. Returns 201 with the created guardrail id.
 */
router.post(
  '/',
  createGuardrailCatalogValidator,
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateRequest(req, res)) return;
    const created = await GuardrailCatalogService.create(bodyToEntity(req.body));
    sendSuccess(res, { id: created.id }, 201);
  }),
);

/**
 * GET /api/v1/guardrails/:id
 * Fetch a guardrail definition by id (the fetch-by-id agent-service uses).
 */
router.get(
  '/:id',
  idParamValidator,
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateRequest(req, res)) return;
    const item = await GuardrailCatalogService.getById(req.params.id);
    sendSuccess(res, entityToResponse(item));
  }),
);

/**
 * PUT /api/v1/guardrails/:id
 * Update a guardrail definition. Returns 200 with the updated guardrail.
 */
router.put(
  '/:id',
  idParamValidator,
  updateGuardrailCatalogValidator,
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateRequest(req, res)) return;
    const updated = await GuardrailCatalogService.update(req.params.id, bodyToEntity(req.body));
    sendSuccess(res, entityToResponse(updated));
  }),
);

/**
 * DELETE /api/v1/guardrails/:id
 * Hard-delete a guardrail definition. Returns 200 { deleted: true }.
 */
router.delete(
  '/:id',
  idParamValidator,
  asyncHandler(async (req: Request, res: Response) => {
    if (!validateRequest(req, res)) return;
    await GuardrailCatalogService.delete(req.params.id);
    sendSuccess(res, { deleted: true });
  }),
);

export default router;

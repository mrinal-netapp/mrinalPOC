import Ajv from 'ajv';
import { In } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { GuardrailCatalog } from '../models/GuardrailCatalog';
import { AgentGuardrails } from '../models/Agent';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import { isPostgresUniqueViolation } from '../utils/pgErrors';
import { isUuid } from '../utils/uuid';
import { validateConfigSchemaShape } from '../validators/guardrailConfigSchemaMeta';
import { BaseService } from './BaseService';

const ajv = new Ajv({ allErrors: false, strict: false });

/** Optional filters for the guardrail catalog list endpoint. */
export interface GuardrailCatalogFilters {
  id?: string;
  key?: string;
  stage?: string;
  type?: string;
  enabled?: boolean;
}

function repo() {
  return AppDataSource.getRepository(GuardrailCatalog);
}

/**
 * Validate a `config` object against a guardrail's `config_schema` (JSON
 * Schema). No-op when the definition has no schema.
 */
function validateConfigAgainstSchema(
  config: unknown,
  configSchema: Record<string, unknown> | undefined | null,
  ctx: string,
): void {
  if (!configSchema) return;
  let validate;
  try {
    validate = ajv.compile(configSchema);
  } catch (err: any) {
    throw new ValidationError(`${ctx}: invalid config_schema (${err.message})`);
  }
  if (!validate(config ?? {})) {
    const detail = (validate.errors || [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new ValidationError(`${ctx}: config does not satisfy config_schema: ${detail}`);
  }
}

function isNonEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/**
 * Catalog invariant: `default_action` must be one of `supported_actions`.
 * Enforced in the service (not just the create validator) so updates that
 * change either field — using the merged values — cannot drift into an
 * inconsistent state. No-op when either value is absent on a partial update.
 */
function assertDefaultActionSupported(
  supportedActions: string[] | undefined,
  defaultAction: string | undefined,
  ctx: string,
): void {
  if (
    Array.isArray(supportedActions) &&
    typeof defaultAction === 'string' &&
    !supportedActions.includes(defaultAction)
  ) {
    throw new ValidationError(
      `${ctx}: default_action '${defaultAction}' must be one of supported_actions: ${supportedActions.join(', ')}`,
    );
  }
}

/**
 * Catalog-level rules for a guardrail's `config` / `config_schema`, applied in
 * fail-fast order:
 *   1. `config_schema` is required when `config` is non-empty,
 *   2. a supplied `config_schema` must satisfy the fixed meta-schema (flat
 *      object; every property declares `type` / `is_required` / `can_override`),
 *   3. `config` must satisfy that `config_schema`.
 *
 * Throws {@link ValidationError} on the first violation.
 */
function assertCatalogConfigSchema(
  config: Record<string, unknown> | undefined,
  configSchema: Record<string, unknown> | undefined | null,
  ctx: string,
): void {
  if (isNonEmptyObject(config) && !configSchema) {
    throw new ValidationError(`${ctx}: config_schema is required when config is non-empty`);
  }
  if (configSchema) {
    const shapeErrors = validateConfigSchemaShape(configSchema);
    if (shapeErrors.length > 0) {
      throw new ValidationError(
        `${ctx}: config_schema does not satisfy the meta-schema: ${shapeErrors.join('; ')}`,
      );
    }
    validateConfigAgainstSchema(config ?? {}, configSchema, ctx);
  }
}

/**
 * Business logic for the guardrails catalog (the reusable definitions backing
 * `/api/v1/guardrails`). config-service stores definitions and serves them by
 * id; it does not resolve them into the runtime `GuardrailSection`.
 */
export class GuardrailCatalogService extends BaseService {
  /** List definitions with optional, AND-combined filters; ordered for stable UI rendering. */
  static async list(filters: GuardrailCatalogFilters = {}): Promise<GuardrailCatalog[]> {
    const qb = repo().createQueryBuilder('g');
    if (filters.id) qb.andWhere('g.id = :id', { id: filters.id });
    if (filters.key) qb.andWhere('g.key = :key', { key: filters.key });
    if (filters.stage) qb.andWhere('g.stage = :stage', { stage: filters.stage });
    if (filters.type) qb.andWhere('g.type = :type', { type: filters.type });
    if (filters.enabled !== undefined) qb.andWhere('g.enabled = :enabled', { enabled: filters.enabled });
    return qb
      .orderBy('g.stage', 'ASC')
      .addOrderBy('g.priority', 'ASC')
      .addOrderBy('g.display_name', 'ASC')
      .getMany();
  }

  static async getById(id: string): Promise<GuardrailCatalog> {
    const found = await repo().findOne({ where: { id } });
    if (!found) {
      throw new NotFoundError('Guardrail', id);
    }
    return found;
  }

  static async create(data: Partial<GuardrailCatalog>): Promise<GuardrailCatalog> {
    assertDefaultActionSupported(data.supportedActions, data.defaultAction, 'guardrail');
    assertCatalogConfigSchema(data.config, data.configSchema, 'guardrail');
    const entity = repo().create(data);
    try {
      return await repo().save(entity);
    } catch (err: any) {
      if (isPostgresUniqueViolation(err)) {
        throw new ConflictError(
          `A guardrail with stage '${data.stage}' and key '${data.key}' already exists`,
        );
      }
      throw err;
    }
  }

  static async update(id: string, data: Partial<GuardrailCatalog>): Promise<GuardrailCatalog> {
    const existing = await this.getById(id);
    const merged = { ...existing, ...data } as GuardrailCatalog;
    assertDefaultActionSupported(merged.supportedActions, merged.defaultAction, 'guardrail');
    assertCatalogConfigSchema(merged.config, merged.configSchema, 'guardrail');
    try {
      await repo().update(id, data as any);
    } catch (err: any) {
      if (isPostgresUniqueViolation(err)) {
        throw new ConflictError(
          `A guardrail with stage '${merged.stage}' and key '${merged.key}' already exists`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  static async delete(id: string): Promise<void> {
    const result = await repo().delete(id);
    if (!result.affected) {
      throw new NotFoundError('Guardrail', id);
    }
  }

  /**
   * Catalog-aware validation of an agent's unified `guardrails` object:
   *   1. every `guardrail_id` resolves to a catalog row,
   *   2. the referenced row's stage matches the array it is placed in,
   *   3. any per-agent `config` override satisfies the definition's `config_schema`.
   *
   * Throws {@link ValidationError} on the first violation. No-op for an absent
   * guardrails object.
   */
  static async validateAgentGuardrails(guardrails: AgentGuardrails | null | undefined): Promise<void> {
    if (!guardrails) return;

    const arrays: Array<['input' | 'output' | 'tool', typeof guardrails.input_guardrails]> = [
      ['input', guardrails.input_guardrails],
      ['output', guardrails.output_guardrails],
      ['tool', guardrails.tool_guardrails],
    ];

    const ids = new Set<string>();
    for (const [stage, rules] of arrays) {
      (rules || []).forEach((rule, idx) => {
        const id = rule?.guardrail_id;
        if (!id) return;
        // Defense-in-depth: a non-UUID id would otherwise reach the `In(...)`
        // query and trigger a Postgres cast error (500). The agent validator
        // also rejects this, but the service must not depend on it.
        if (!isUuid(id)) {
          throw new ValidationError(
            `guardrails.${stage}_guardrails[${idx}]: guardrail_id '${id}' is not a valid UUID`,
          );
        }
        ids.add(id);
      });
    }
    if (ids.size === 0) return;

    const rows = await repo().find({ where: { id: In([...ids]) } });
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const [stage, rules] of arrays) {
      (rules || []).forEach((rule, idx) => {
        const ctx = `guardrails.${stage}_guardrails[${idx}]`;
        const def = byId.get(rule.guardrail_id);
        if (!def) {
          throw new ValidationError(`${ctx}: guardrail_id '${rule.guardrail_id}' does not exist`);
        }
        if (def.stage !== stage) {
          throw new ValidationError(
            `${ctx}: guardrail '${rule.guardrail_id}' has stage '${def.stage}', cannot be used in ${stage}_guardrails`,
          );
        }
        if (rule.config !== undefined) {
          validateConfigAgainstSchema(rule.config, def.configSchema, ctx);
        }
      });
    }
  }
}

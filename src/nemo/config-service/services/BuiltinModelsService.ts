import { get_logger } from '@agentstudio/observability-client-runtime';
import { DataSource } from 'typeorm';
import { Model } from '../models/Model';
import { Project } from '../models/Project';
import {
  BUILTIN_EMBEDDING_MODELS,
  BuiltinEmbeddingModel,
  buildTeiEndpoint,
} from './BuiltinModels';
import { getLLMGatewayClient } from './gatewayClient';
import {
  buildBuiltinGatewayBindingName,
  buildGatewayModelId,
} from './bifrost/bifrostProviderOps';
import { assignBuiltinModelsToProjectVirtualKey } from './bifrost/bifrostProjectGovernance';
import {
  enrichModelInfoFromCatalog,
  getKnownEmbeddingModelInfo,
} from '../providers/embeddingDimensions';

const logger = get_logger();
const TAG = '[BuiltinModelsService]';

/** A resolved built-in binding to assign to a project's virtual key. */
type BuiltinBinding = { provider: string; modelId: string; providerKeyId?: string };

/**
 * Single source of truth for the Bifrost-side provider name of a built-in
 * TEI model. Centralised so we never have the literal `as-${teiServiceName}`
 * string concatenation in more than one place. Phase 2 (gateway wiring)
 * also reads this when registering provider keys with Bifrost.
 *
 * `teiServiceName` is the in-cluster K8s Service name (e.g. `tei-minilm`).
 * The result is e.g. `as-tei-minilm` — single `tei-` prefix, matches the
 * Service name. Earlier drafts double-prefixed (`as-tei-tei-minilm`); do
 * not reintroduce that.
 */
export function builtinGatewayProviderName(teiServiceName: string): string {
  return `as-${teiServiceName}`;
}

/**
 * Owns the lifecycle of system-managed built-in embedding models.
 *
 *   - {@link seedBuiltinsForProject} — called from the gateway-setup
 *     activity so the built-in rows exist before the project becomes
 *     usable to end users. Idempotent via the `(projectId, name)` unique
 *     index on `models`.
 *   - {@link registerBuiltinsWithGatewayForProject} — Phase 2 hook; no-op
 *     today. Will register each built-in as a custom openai-compatible
 *     provider in Bifrost once `BifrostGatewayClient` learns custom-
 *     provider config.
 *   - {@link ensureBuiltinsForAllProjects} — startup backfill. Walks
 *     every project and re-runs the seed so a new built-in added to
 *     {@link BUILTIN_EMBEDDING_MODELS} later propagates to all existing
 *     projects on the next config-service start.
 *   - {@link backfillKnowledgeBaseEmbeddingModelId} — stamps the
 *     `embeddingModelId` FK on pre-port KBs whose `embeddingModel` name
 *     matches a now-seeded built-in.
 */
export class BuiltinModelsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: BuiltinEmbeddingModel[] = BUILTIN_EMBEDDING_MODELS,
  ) {}

  /**
   * Idempotent insert of one row per built-in for the given project.
   * Uses INSERT ... ON CONFLICT DO NOTHING against the (projectId, name)
   * unique index so concurrent callers don't race.
   *
   * Returns the number of rows actually inserted (via `RETURNING id` so the
   * count is accurate — TypeORM's `dataSource.query()` returns the rows
   * array for the pg driver, not a `[rows, count]` tuple, and `ON CONFLICT
   * DO NOTHING` without `RETURNING` would yield an empty array).
   */
  async seedBuiltinsForProject(projectId: string): Promise<number> {
    if (this.catalog.length === 0) return 0;

    // Build a single multi-row INSERT. Each row uses 7 positional params
    // (projectId, name, displayName, provider, providerModelId, modelType,
    // model_info), then hardcodes isBuiltin=true and timestamps.
    const valuesSql = this.catalog
      .map((_, i) => {
        const base = i * 7;
        return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, true, NOW(), NOW())`;
      })
      .join(',\n');

    const params: unknown[] = [];
    for (const m of this.catalog) {
      params.push(
        projectId,
        m.name,
        m.displayName,
        // Built-ins live under a dedicated Bifrost provider name per TEI
        // service. Stored on `provider` so the model row carries enough
        // context for the gateway client to find the existing provider key
        // later (e.g., on delete). See `builtinGatewayProviderName` for
        // the single source of truth on the naming convention.
        builtinGatewayProviderName(m.teiServiceName),
        m.providerModelId,
        'embedding',
        JSON.stringify({
          dimensions: m.dimensions,
          recommendedChunkSize: m.recommendedChunkSize,
          category: m.category,
          description: m.description,
        }),
      );
    }

    const sql = `
      INSERT INTO models
        ("id", "projectId", "name", "displayName", "provider", "providerModelId", "modelType", "model_info", "isBuiltin", "createdAt", "updatedAt")
      VALUES
        ${valuesSql}
      ON CONFLICT ("projectId", "name") DO NOTHING
      RETURNING id
    `;

    const rows = (await this.dataSource.query(sql, params)) as unknown[];
    const inserted = Array.isArray(rows) ? rows.length : 0;
    if (inserted > 0) {
      logger.info(`${TAG} Seeded ${inserted} built-in model(s) for project ${projectId}`);
    }
    return inserted;
  }

  /**
   * Register every catalog built-in as a custom Bifrost provider (one
   * provider per TEI service, openai-compatible upstream) and assign the
   * model to the given project's virtual key. After a successful Bifrost
   * registration, stamps `gatewayModelId`, `gatewayBindingName`, and
   * `rateCardOverride._gateway` on the seeded model row so runtime callers
   * (agent-service, kb-retrieval-service) can resolve the wire-form id
   * without recomputing.
   *
   * Idempotent end-to-end: re-registering an existing model returns the
   * same Bifrost identifiers, which the row already has — the UPDATE is
   * effectively a no-op. Runs once per project on init and on every
   * config-service startup.
   *
   * Per-model failures are logged and swallowed so one bad catalog entry
   * doesn't block the others. Returns silently when the gateway client is
   * disabled (e.g., during local unit tests without a running Bifrost).
   */
  async registerBuiltinsWithGatewayForProject(projectId: string): Promise<void> {
    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) {
      logger.info(`${TAG} LLM gateway disabled; skipping built-in registration`);
      return;
    }

    const modelRepo = this.dataSource.getRepository(Model);

    // Phase 1 — create the per-model Bifrost provider keys concurrently.
    // Each built-in lives under its OWN `as-tei-<svc>` provider, so the
    // provider-key writes don't contend. Crucially we pass
    // `deferVirtualKeyAssignment` so this phase does NOT touch the shared
    // project virtual key: assigning per-model here (the old behaviour)
    // meant N concurrent read-modify-write PUTs of the SAME VK's
    // `provider_configs`, which clobbered each other (lost update) and left
    // the VK with a non-deterministic subset of the catalog. We collect
    // each resolved binding and stamp the model row here, then assign every
    // binding to the VK in a single atomic write (Phase 2).
    const bindings = (
      await Promise.all(
        this.catalog.map(async (m): Promise<BuiltinBinding | null> => {
          try {
            const result = await gateway.addModel({
              model_name: m.name,
              provider_params: {
                // Upstream model id, prefixed with `openai/` so Bifrost's
                // openai-compatible adapter sends an OpenAI-shaped request
                // body. The actual upstream call goes to `api_base`.
                model: `openai/${m.providerModelId}`,
                api_base: buildTeiEndpoint(m.teiServiceName),
                api_key: 'tei-no-auth',
              },
              model_info: {
                isBuiltin: true,
                provider: builtinGatewayProviderName(m.teiServiceName),
                providerModelId: m.providerModelId,
                modelType: 'embedding',
                dimensions: m.dimensions,
                projectId,
                // Defer VK assignment to the single batched write in Phase 2.
                deferVirtualKeyAssignment: true,
              },
            });

            if (!result) return null; // gateway disabled mid-call

            // Stamp the resolved Bifrost identifiers on the seeded row so
            // the runtime can send `gatewayModelId` verbatim. Without this,
            // runtime callers fall back to `providerModelId` (the bare HF
            // id) and Bifrost can't route.
            const gatewayProvider =
              result.gatewayProvider || builtinGatewayProviderName(m.teiServiceName);
            const gatewayBindingName =
              result.gatewayBindingName || buildBuiltinGatewayBindingName(m.providerModelId);
            const gatewayModelId = buildGatewayModelId(gatewayProvider, gatewayBindingName);

            // TypeORM's QueryDeepPartialEntity types nested JSONB columns as
            // `() => string | _QueryDeepPartialEntity<Record<string, any>>`
            // rather than the entity's declared `Record<string, any>`. Use
            // `Record<string, any>` exactly (not `unknown`) so the variable's
            // type matches the column's declared type and TypeORM's partial
            // wrapper accepts it.
            const rateCardOverride: Record<string, any> = {
              _gateway: {
                gatewayProvider,
                keyName: result.keyName,
                bifrostTeamId: result.bifrostTeamId,
                bifrostVirtualKeyId: result.bifrostVirtualKeyId,
                gatewayBindingName,
              },
            };
            await modelRepo.update(
              { projectId, name: m.name },
              {
                gatewayModelId,
                gatewayBindingName,
                rateCardOverride,
              },
            );

            return {
              provider: gatewayProvider,
              modelId: gatewayBindingName,
              providerKeyId: result.keyId,
            };
          } catch (err: any) {
            logger.error(
              `${TAG} Failed registering built-in '${m.name}' on gateway for project ${projectId}: ${err?.message || err}`,
            );
            return null;
          }
        }),
      )
    ).filter((b): b is BuiltinBinding => b !== null);

    // Phase 2 — assign every built-in binding to the project virtual key in
    // ONE atomic read-modify-write. Race-free by construction: a single PUT
    // has no concurrent writer to clobber. Idempotent, so the startup
    // backfill converges any project whose VK is missing entries.
    if (bindings.length) {
      try {
        await assignBuiltinModelsToProjectVirtualKey(projectId, bindings);
      } catch (err: any) {
        logger.error(
          `${TAG} Failed batched VK assignment of ${bindings.length} built-in(s) for project ${projectId}: ${err?.message || err}`,
        );
      }
    }
  }

  /**
   * Walk every project, seed any missing built-in rows, and re-run gateway
   * registration. Safe to run on every startup — both inner calls are
   * idempotent. New built-ins added to the catalog propagate to all
   * existing projects on next service start.
   *
   * Bounded concurrency (`BUILTIN_BACKFILL_CONCURRENCY`, default 8) so a
   * tenant with many projects doesn't serialize all the work. This runs in
   * the background (the postgres.ts startup hook is fire-and-forget), so
   * total wall-clock doesn't gate readiness, but bounded parallelism still
   * keeps the wall-clock reasonable while not stampeding Bifrost.
   */
  async ensureBuiltinsForAllProjects(): Promise<void> {
    const projectRepo = this.dataSource.getRepository(Project);
    const projects = await projectRepo.find({ select: ['id'] });
    if (projects.length === 0) {
      logger.info(`${TAG} Startup backfill: no projects yet`);
      return;
    }

    const concurrency = Math.max(
      1,
      Math.min(
        32,
        parseInt(process.env.BUILTIN_BACKFILL_CONCURRENCY || '8', 10) || 8,
      ),
    );

    let inserted = 0;
    let cursor = 0;
    const next = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= projects.length) return;
        const p = projects[idx];
        try {
          inserted += await this.seedBuiltinsForProject(p.id);
        } catch (err: any) {
          logger.error(
            `${TAG} Failed seeding built-ins for project ${p.id}: ${err?.message || err}`,
          );
        }
        try {
          await this.registerBuiltinsWithGatewayForProject(p.id);
        } catch (err: any) {
          logger.error(
            `${TAG} Failed registering built-ins on gateway for project ${p.id}: ${err?.message || err}`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => next()));

    if (inserted > 0) {
      logger.info(
        `${TAG} Startup backfill seeded ${inserted} built-in row(s) across ${projects.length} project(s) (concurrency=${concurrency})`,
      );
    } else {
      logger.info(
        `${TAG} Startup backfill: all ${projects.length} project(s) already have built-in catalog`,
      );
    }
  }

  /**
   * Resolve KB.embeddingModelId for rows that only carry the legacy string
   * `embeddingModel`. Runs once at startup after built-ins are seeded so
   * pre-port KBs gain an FK reference without a manual migration. The
   * on-disk LanceDB metadata.json is left untouched (kb-retrieval-service
   * falls back to MiniLM when metadata lacks model identity).
   */
  async backfillKnowledgeBaseEmbeddingModelId(): Promise<void> {
    // Cheap guard: skip the JOIN UPDATE on hot starts when no rows need it.
    const pending = (await this.dataSource.query(
      `SELECT 1 FROM knowledge_bases WHERE "embeddingModelId" IS NULL LIMIT 1`,
    )) as unknown[];
    if (!Array.isArray(pending) || pending.length === 0) return;

    // `RETURNING id` so the row count is accurate under TypeORM/pg (which
    // returns just the rows array, not a `[rows, count]` tuple).
    const rows = (await this.dataSource.query(`
      UPDATE knowledge_bases kb
      SET "embeddingModelId" = m.id
      FROM models m
      WHERE kb."embeddingModelId" IS NULL
        AND kb."projectId" = m."projectId"
        AND kb."embeddingModel" = m."name"
      RETURNING kb.id
    `)) as unknown[];
    const updated = Array.isArray(rows) ? rows.length : 0;
    if (updated > 0) {
      logger.info(`${TAG} Backfilled embeddingModelId for ${updated} knowledge base row(s)`);
    }
  }

  /**
   * One-shot backfill of `model_info.dimensions` for embedding models that
   * were registered before the embedding catalog existed (see
   * providers/embeddingDimensions.ts). Without this, KB creation against
   * those rows fails with EMBEDDING_DIMENSIONS_REQUIRED until the user
   * re-registers the model — bad UX.
   *
   * For each row matched, runs the same `enrichModelInfoFromCatalog` used
   * at registration so the persisted `model_info` ends up with dimensions,
   * recommendedChunkSize, category, and description filled in (only the
   * missing keys; existing values are preserved).
   *
   * Idempotent: re-running finds no candidates because every populated row
   * carries `model_info.dimensions`. Rows whose (provider, providerModelId)
   * doesn't match the static catalog are logged so operators can extend
   * the catalog or ask the user to re-register with an explicit dimension.
   *
   * Built-in rows (`isBuiltin = true`) already carry dimensions from
   * seedBuiltinsForProject's payload, so the `model_info->>'dimensions'`
   * IS NULL filter naturally skips them.
   */
  async backfillEmbeddingDimensions(): Promise<void> {
    const modelRepo = this.dataSource.getRepository(Model);
    const candidates = await modelRepo
      .createQueryBuilder('m')
      .where(`m.modelType = :t`, { t: 'embedding' })
      .andWhere(`(m.model_info IS NULL OR (m.model_info->>'dimensions') IS NULL)`)
      .getMany();

    if (candidates.length === 0) {
      logger.info(`${TAG} Embedding dimensions backfill: all rows already populated`);
      return;
    }

    let updated = 0;
    let unresolved = 0;
    for (const row of candidates) {
      const known = getKnownEmbeddingModelInfo(row.provider, row.providerModelId);
      if (!known) {
        unresolved++;
        logger.warn(
          `${TAG} No static dimensions for ${row.provider}/${row.providerModelId} ` +
          `(model id ${row.id}, project ${row.projectId}); KB creation against ` +
          `this model will return 400 until model_info.dimensions is set or ` +
          `the catalog is extended.`,
        );
        continue;
      }
      const merged = enrichModelInfoFromCatalog(
        row.model_info as Record<string, unknown> | undefined,
        row.provider,
        row.providerModelId,
      ) as Record<string, any>;
      // TypeORM update by id is atomic against any concurrent registration
      // (same row keyed update; last-writer-wins on jsonb column).
      await modelRepo.update({ id: row.id }, { model_info: merged });
      updated++;
    }
    logger.info(
      `${TAG} Embedding dimensions backfill: ${updated} row(s) updated, ` +
      `${unresolved} unresolved across ${candidates.length} candidate(s)`,
    );
  }
}

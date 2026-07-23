import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { ReferenceEdge, type EntityKind } from '../models/ReferenceEdge';
import { Project } from '../models/Project';
import { Agent } from '../models/Agent';
import { AgentTeam } from '../models/AgentTeam';
import { Model } from '../models/Model';
import { MCPServer } from '../models/MCPServer';
import { Pipeline } from '../models/Pipeline';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { DataSet } from '../models/DataSet';
import { Credential } from '../models/Credential';
import { DataSource } from '../models/DataSource';
import { referenceCatalog } from './referenceCatalog';
import { applyForEntity } from './ReferenceEdgeService';
import {
  referenceEdgesDriftTotal,
  referenceEdgesReconcilerLastSuccessTs,
  referenceEdgesReconcilerScannedTotal,
} from './referenceEdgeMetrics';

/**
 * Walk every source-row of every catalog kind in a project and rewrite
 * its outgoing edges. Reuses the synchronous write path so the reconciler
 * is a pure no-op when state is already correct (which becomes the drift
 * test, see plan §11).
 *
 * - Used at first-deploy backfill (no edges yet).
 * - Used by the Temporal-scheduled workflow as a safety net for the
 *   embedded-id slice (today: only `pipeline.graph`).
 * - Returned counts make the drift gauge (delta != 0 = code path missing
 *   a service-wrapper call).
 */

export interface ReconcileScope {
  projectId?: string;
  sourceType?: EntityKind;
  /** When true, only kinds the catalog declares as needing reconciliation. */
  graphOnly?: boolean;
  /**
   * Bound the per-tick work so a project with many pipelines doesn't
   * starve the schedule. Default 5000 rows.
   */
  maxRows?: number;
}

export interface ReconcileSummary {
  scanned: number;
  edgesBefore: number;
  edgesAfter: number;
  added: number;
  removed: number;
  byKind: Record<string, { scanned: number; added: number; removed: number }>;
  /** True when the scan stopped because `maxRows` was hit. */
  truncated: boolean;
}

// Partial: kinds omitted here are skipped by the reconciler (see the
// `if (!Entity) continue;` guard below). `evaluation` is intentionally
// omitted — it is syncOnly (edges are written on every create/update via
// applyForEntity) and the reconciler keyset-paginates on `e.id`, which the
// evaluation_templates table does not have (its PK is `templateId`).
const ENTITY_BY_KIND: Partial<Record<EntityKind, any>> = {
  agent: Agent,
  agent_team: AgentTeam,
  model: Model,
  mcp_server: MCPServer,
  pipeline: Pipeline,
  knowledge_base: KnowledgeBase,
  dataset: DataSet,
  data_source: DataSource,
  credential: Credential,
};

const PAGE_SIZE = 500;

async function listProjectIds(): Promise<string[]> {
  const rows: { id: string }[] = await AppDataSource.getRepository(Project)
    .createQueryBuilder('p')
    .select('p.id', 'id')
    .getRawMany();
  return rows.map((r) => r.id);
}

/**
 * Run the reconciler. Returns counts so callers (admin endpoint, Temporal
 * activity) can surface drift to operators.
 */
export async function reconcile(scope: ReconcileScope = {}): Promise<ReconcileSummary> {
  const projectIds = scope.projectId ? [scope.projectId] : await listProjectIds();
  const kinds = scope.sourceType
    ? [referenceCatalog.get(scope.sourceType)].filter(Boolean)
    : referenceCatalog.all().filter((d) => (scope.graphOnly ? !d.syncOnly : true));

  const summary: ReconcileSummary = {
    scanned: 0,
    edgesBefore: 0,
    edgesAfter: 0,
    added: 0,
    removed: 0,
    byKind: {},
    truncated: false,
  };
  const maxRows = scope.maxRows ?? 5000;

  for (const projectId of projectIds) {
    for (const desc of kinds) {
      if (!desc) continue;
      const Entity = ENTITY_BY_KIND[desc.sourceType];
      if (!Entity) continue;

      const ds = AppDataSource;
      const repo = ds.getRepository(Entity);

      const kindBucket = summary.byKind[desc.sourceType] ?? { scanned: 0, added: 0, removed: 0 };
      summary.byKind[desc.sourceType] = kindBucket;

      let lastId = '';
      // Keyset paginate over `id` so we don't hold a single transaction
      // open for an entire project's worth of rows.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (summary.scanned >= maxRows) {
          summary.truncated = true;
          break;
        }
        const qb = repo.createQueryBuilder('e')
          .where('e.projectId = :projectId', { projectId })
          .orderBy('e.id', 'ASC')
          .take(PAGE_SIZE);
        if (lastId) qb.andWhere('e.id > :lastId', { lastId });
        const batch: any[] = await qb.getMany();
        if (batch.length === 0) break;

        for (const row of batch) {
          if (summary.scanned >= maxRows) {
            summary.truncated = true;
            break;
          }
          const before = await countEdgesForSource(undefined, desc.sourceType, projectId, row.id);
          await applyForEntity(undefined, desc.sourceType, projectId, row);
          const after = await countEdgesForSource(undefined, desc.sourceType, projectId, row.id);

          summary.edgesBefore += before;
          summary.edgesAfter += after;
          if (after > before) {
            const delta = after - before;
            summary.added += delta;
            kindBucket.added += delta;
            referenceEdgesDriftTotal.inc({ kind: desc.sourceType, direction: 'added' }, delta);
          }
          if (before > after) {
            const delta = before - after;
            summary.removed += delta;
            kindBucket.removed += delta;
            referenceEdgesDriftTotal.inc({ kind: desc.sourceType, direction: 'removed' }, delta);
          }

          summary.scanned += 1;
          kindBucket.scanned += 1;
          referenceEdgesReconcilerScannedTotal.inc({ kind: desc.sourceType });
          lastId = row.id;
        }
        if (summary.truncated) break;
        if (batch.length < PAGE_SIZE) break;
      }
      if (summary.truncated) break;
    }
    if (summary.truncated) break;
  }

  referenceEdgesReconcilerLastSuccessTs.set(Date.now() / 1000);
  return summary;
}

async function countEdgesForSource(
  manager: EntityManager | undefined,
  sourceType: EntityKind,
  projectId: string,
  sourceId: string,
): Promise<number> {
  const r = (manager ?? AppDataSource.manager).getRepository(ReferenceEdge);
  return r.count({ where: { projectId, sourceType, sourceId } });
}

/** Per-process guard so we do not reconcile on every datasets list request. */
const coldKbEdgeRepairDone = new Set<string>();

/** Per-process guard for KB→embedding-model edge backfill on model reads. */
const coldKbModelEdgeRepairDone = new Set<string>();

/**
 * After upgrades, KB→dataset edges may never have been written while knowledge
 * bases already exist. If this project has KB rows with a real sourceDataset
 * but zero reference_edges from knowledge_base sources, run a scoped
 * reconcile once per process. Fixes empty "Used by" until the scheduled
 * workflow runs or an operator POSTs internal/reconcile.
 */
export async function ensureKbReferenceEdgesIfCold(projectId: string): Promise<void> {
  if (coldKbEdgeRepairDone.has(projectId)) return;

  const rows: { kb: string; edges: string }[] = await AppDataSource.query(
    `SELECT
       (SELECT COUNT(*)::int FROM knowledge_bases
         WHERE "projectId" = $1
           AND COALESCE(TRIM("sourceDataset"), '') <> ''
           AND "sourceDataset" NOT IN ('__unset__', '__legacy_unknown__')) AS kb,
       (SELECT COUNT(*)::int FROM reference_edges
         WHERE "projectId" = $1 AND "sourceType" = 'knowledge_base') AS edges`,
    [projectId],
  );
  const kb = Number(rows[0]?.kb ?? 0);
  const edges = Number(rows[0]?.edges ?? 0);

  if (kb === 0 || edges > 0) {
    coldKbEdgeRepairDone.add(projectId);
    return;
  }

  try {
    await reconcile({ projectId, sourceType: 'knowledge_base', maxRows: 50000 });
  } catch (err: any) {
    logger.warn(
      `[referenceEdges] Cold-start KB reconcile failed for ${projectId}:`,
      err?.message ?? err,
    );
    return;
  }
  coldKbEdgeRepairDone.add(projectId);
}

/**
 * KB rows created before the catalog tracked `embeddingModelId` may have
 * dataset edges but no model edge. If any KB in the project is missing its
 * embedding-model reference edge, reconcile knowledge bases once per process.
 */
export async function ensureKbEmbeddingModelReferenceEdgesIfMissing(
  projectId: string,
): Promise<void> {
  if (coldKbModelEdgeRepairDone.has(projectId)) return;

  const rows: { missing: string }[] = await AppDataSource.query(
    `SELECT COUNT(*)::int AS missing
       FROM knowledge_bases kb
      WHERE kb."projectId" = $1
        AND kb."embeddingModelId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM reference_edges re
           WHERE re."projectId" = $1
             AND re."sourceType" = 'knowledge_base'
             AND re."sourceId" = kb.id
             AND re."targetType" = 'model'
             AND re."targetId" = kb."embeddingModelId"::text
        )`,
    [projectId],
  );
  const missing = Number(rows[0]?.missing ?? 0);
  coldKbModelEdgeRepairDone.add(projectId);
  if (missing === 0) return;

  try {
    await reconcile({ projectId, sourceType: 'knowledge_base', maxRows: 50000 });
  } catch (err: any) {
    logger.warn(
      `[referenceEdges] KB embedding-model edge repair failed for ${projectId}:`,
      err?.message ?? err,
    );
  }
}

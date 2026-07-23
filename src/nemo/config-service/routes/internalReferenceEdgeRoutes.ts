import 'reflect-metadata';
import { Router } from 'express';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';
import { reconcile, type ReconcileScope } from '../services/ReferenceEdgeReconciler';
import { ReferenceEdge, type EntityKind } from '../models/ReferenceEdge';
import { referenceCatalog } from '../services/referenceCatalog';
import { AppDataSource } from '../db/postgres';
import { FacetService } from '../services/FacetService';
import type { FacetState } from '../models/Facet';

/**
 * Internal admin endpoint for the reference-edge reconciler.
 *
 * Called by the Temporal-scheduled `DependencyLineageSyncWorkflow` in
 * the workflow-engine, and also usable manually for backfill / drift
 * repair. Mounted at `/api/v1/internal/reference-edges` in `index.ts`.
 *
 * Mirrors the MCP health-check shape: a thin Go activity in the
 * workflow-engine just POSTs here on each tick.
 */
const router = Router();

const VALID_KINDS = new Set<EntityKind>([
  'agent',
  'agent_team',
  'model',
  'mcp_server',
  'pipeline',
  'knowledge_base',
  'dataset',
  'data_source',
  'credential',
]);

router.post('/reconcile', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Partial<ReconcileScope> & {
    sourceType?: string;
  };

  let sourceType: EntityKind | undefined;
  if (body.sourceType) {
    if (!VALID_KINDS.has(body.sourceType as EntityKind)) {
      return sendError(res, new Error(`Unknown sourceType: ${body.sourceType}`), 400);
    }
    sourceType = body.sourceType as EntityKind;
  }

  const scope: ReconcileScope = {
    projectId: body.projectId,
    sourceType,
    graphOnly: body.graphOnly,
    maxRows: body.maxRows,
  };

  const summary = await reconcile(scope);
  sendSuccess(res, summary);
}));

// ─── Lineage graph data (read) ──────────────────────────────────────────────
//
// Returns raw edges + resolved entity names grouped by projectId.
// Called by the Go BuildLineageGraphActivity to fetch input data.

router.get('/graph-data', asyncHandler(async (req, res) => {
  const projectIdFilter = req.query.projectId as string | undefined;
  const edgeRepo = AppDataSource.getRepository(ReferenceEdge);

  const qb = edgeRepo.createQueryBuilder('e');
  if (projectIdFilter) {
    qb.where('e.projectId = :pid', { pid: projectIdFilter });
  }
  const edges = await qb.getMany();

  // Group edges by project and collect distinct entity (kind, id) pairs
  const byProject = new Map<string, {
    edges: Array<{ sourceType: string; sourceId: string; targetType: string; targetId: string; relation: string }>;
    entityKeys: Set<string>;
  }>();

  for (const e of edges) {
    let bucket = byProject.get(e.projectId);
    if (!bucket) {
      bucket = { edges: [], entityKeys: new Set() };
      byProject.set(e.projectId, bucket);
    }
    bucket.edges.push({
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      targetType: e.targetType,
      targetId: e.targetId,
      relation: e.relation,
    });
    bucket.entityKeys.add(`${e.sourceType}\0${e.sourceId}`);
    bucket.entityKeys.add(`${e.targetType}\0${e.targetId}`);
  }

  // Resolve names for all entities across all projects in one pass per kind
  const allByKind = new Map<string, Set<string>>();
  for (const bucket of byProject.values()) {
    for (const key of bucket.entityKeys) {
      const [kind, id] = key.split('\0');
      let ids = allByKind.get(kind);
      if (!ids) { ids = new Set(); allByKind.set(kind, ids); }
      ids.add(id);
    }
  }

  const nameMap = new Map<string, string | null>();
  const ds = AppDataSource;
  for (const [kind, ids] of allByKind) {
    const desc = referenceCatalog.get(kind as EntityKind);
    if (!desc || ids.size === 0) {
      for (const id of ids) nameMap.set(`${kind}\0${id}`, null);
      continue;
    }
    const idArr = Array.from(ids);
    const idCol = `"${desc.idColumn}"`;
    const nameCol = `"${desc.nameColumn}"`;
    const rows: { id: string; name: string | null }[] = await ds.query(
      `SELECT ${idCol}::text AS id, ${nameCol} AS name FROM ${desc.table} WHERE ${idCol}::text = ANY($1)`,
      [idArr],
    );
    const seen = new Set<string>();
    for (const r of rows) {
      nameMap.set(`${kind}\0${r.id}`, r.name ?? null);
      seen.add(r.id);
    }
    for (const id of idArr) {
      if (!seen.has(id)) nameMap.set(`${kind}\0${id}`, null);
    }
  }

  // Total entity count per kind per project (lets the consumer compute
  // orphan = total - connected for each column placeholder).
  const totalsByProject = new Map<string, Record<string, number>>();
  for (const pid of byProject.keys()) {
    const counts: Record<string, number> = {};
    for (const desc of referenceCatalog.all()) {
      const idCol = `"${desc.idColumn}"`;
      const projectCol = `"${desc.projectColumn ?? 'projectId'}"`;
      const rows: { count: string }[] = await ds.query(
        `SELECT COUNT(${idCol})::text AS count FROM ${desc.table} WHERE ${projectCol} = $1`,
        [pid],
      );
      counts[desc.sourceType] = Number(rows[0]?.count ?? 0);
    }
    totalsByProject.set(pid, counts);
  }

  // Build response grouped by project
  const projects: Record<string, {
    edges: Array<{ sourceType: string; sourceId: string; targetType: string; targetId: string; relation: string }>;
    entities: Array<{ kind: string; id: string; name: string | null }>;
    entityTotals: Record<string, number>;
  }> = {};

  for (const [pid, bucket] of byProject) {
    const entities: Array<{ kind: string; id: string; name: string | null }> = [];
    for (const key of bucket.entityKeys) {
      const [kind, id] = key.split('\0');
      entities.push({ kind, id, name: nameMap.get(key) ?? null });
    }
    projects[pid] = {
      edges: bucket.edges,
      entities,
      entityTotals: totalsByProject.get(pid) ?? {},
    };
  }

  sendSuccess(res, { projects });
}));

// ─── Lineage facet write ────────────────────────────────────────────────────
//
// Stores a finished lineage graph as a project-scoped facet.
// Called by the Go BuildLineageGraphActivity after assembling the graph.

router.put('/lineage-facet/:projectId', asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const { state, graph } = req.body as { state?: string; graph?: Record<string, any> };

  if (!state || !['in_progress', 'ready', 'errored'].includes(state)) {
    return sendError(res, new Error('Invalid state. Must be one of: in_progress, ready, errored'), 400);
  }

  const facet = await FacetService.upsertFacet(
    projectId, 'project', projectId, 'lineage',
    { state: state as FacetState, summary: graph },
  );
  sendSuccess(res, facet);
}));

export default router;

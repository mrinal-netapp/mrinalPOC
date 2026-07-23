import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { DataSet } from '../models/DataSet';
import { ReferenceEdge, type EntityKind } from '../models/ReferenceEdge';
import { referenceCatalog, type EdgeOut } from './referenceCatalog';
import {
  referenceEdgesAppliedTotal,
  referenceEdgesRemovedTotal,
} from './referenceEdgeMetrics';

/**
 * Synchronous write path for the reference-edge store.
 *
 * Routes call these methods inside the same transaction as the entity
 * write so edge state never disagrees with row state for declared columns
 * and JSON-id arrays.
 *
 * The reconciler (workflow-engine) closes the loop for embedded
 * references such as ids hidden inside `Pipeline.graph`.
 */

const TABLE = 'reference_edges';

const repo = (manager?: EntityManager) =>
  (manager ?? AppDataSource.manager).getRepository(ReferenceEdge);

const runner = (manager?: EntityManager) =>
  (manager ?? AppDataSource.manager).connection.createQueryRunner();

/**
 * `knowledge_bases.sourceDataset` historically allowed a dataset id or name.
 * Dependent counts key edges by dataset primary key; resolve name → id when
 * the raw value matches a row by `name` but not by `id`.
 */
async function resolveKbDatasetTargetIds(
  manager: EntityManager | undefined,
  projectId: string,
  edges: EdgeOut[],
): Promise<EdgeOut[]> {
  const dsRepo = (manager ?? AppDataSource.manager).getRepository(DataSet);
  const out: EdgeOut[] = [];
  for (const e of edges) {
    if (e.targetType !== 'dataset') {
      out.push(e);
      continue;
    }
    const tid = e.targetId;
    let row = await dsRepo.findOne({ where: { projectId, id: tid } });
    if (!row) {
      row = await dsRepo.findOne({ where: { projectId, name: tid } });
    }
    if (row) {
      out.push({ ...e, targetId: row.id });
    }
    // Unmatched values are dropped — avoids orphan target ids that never
    // join to dependentsSummary on dataset list.
  }
  return out;
}

/**
 * Replace the outgoing edges for `(projectId, sourceType, sourceId)` with
 * the set produced by the catalog from `row`. Idempotent: safe to call
 * even if no fields changed.
 *
 * `row` is intentionally typed loosely: route handlers may have entities
 * inferred as `T | T[]` due to TypeORM repository overloads. The runtime
 * guards reject anything that isn't a single object with an `id`.
 */
export async function applyForEntity(
  manager: EntityManager | undefined,
  sourceType: EntityKind,
  projectId: string,
  row: unknown,
): Promise<void> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return;
  // Derive the source id from the catalog descriptor's idColumn so entities
  // whose primary key isn't named `id` (e.g. EvaluationTemplate.templateId)
  // still produce edges. Falls back to `id` for descriptor-less callers.
  const idColumn = referenceCatalog.get(sourceType)?.idColumn ?? 'id';
  const sourceId =
    ((row as Record<string, unknown>)[idColumn] as string | undefined) ??
    (row as { id?: string }).id;
  if (!sourceId) return;

  let edges = referenceCatalog.extractEdges(sourceType, sourceId, row);
  if (sourceType === 'knowledge_base') {
    edges = await resolveKbDatasetTargetIds(manager, projectId, edges);
  }

  const r = repo(manager);
  await r.delete({ projectId, sourceType, sourceId });
  referenceEdgesAppliedTotal.inc({ kind: sourceType });

  if (edges.length === 0) return;

  // Bulk insert with conflict tolerance — duplicate rows can briefly exist
  // when two writers race on the same (project, source, target, relation).
  // ON CONFLICT DO NOTHING keeps the operation idempotent.
  const values = edges.map((e: EdgeOut) => ({
    projectId,
    sourceType,
    sourceId,
    targetType: e.targetType,
    targetId: e.targetId,
    relation: e.relation,
  }));
  await r
    .createQueryBuilder()
    .insert()
    .into(ReferenceEdge)
    .values(values)
    .orIgnore()
    .execute();
}

/**
 * Drop all outgoing edges from a source row (call before/after deleting
 * the source entity). Safe to call when no edges exist.
 */
export async function removeForSource(
  manager: EntityManager | undefined,
  sourceType: EntityKind,
  projectId: string,
  sourceId: string,
): Promise<void> {
  if (!sourceId) return;
  await repo(manager).delete({ projectId, sourceType, sourceId });
  referenceEdgesRemovedTotal.inc({ kind: sourceType });
}

/**
 * Drop all incoming edges pointing at a target row (call when force-deleting
 * a target whose dependents have been resolved or are being orphaned).
 *
 * Today's delete flow blocks instead of force-deleting; this method is
 * provided for the future force-delete path and for project teardown.
 */
export async function removeForTarget(
  manager: EntityManager | undefined,
  targetType: EntityKind,
  projectId: string,
  targetId: string,
): Promise<void> {
  if (!targetId) return;
  await repo(manager).delete({ projectId, targetType, targetId });
}

/**
 * Drop all edges scoped to a project. Used by project-deletion cleanup.
 */
export async function removeForProject(
  manager: EntityManager | undefined,
  projectId: string,
): Promise<number> {
  const result = await repo(manager).delete({ projectId });
  return result.affected ?? 0;
}

/**
 * Cheap "is anything pointing at me?" probe. Used by delete-blocker
 * pre-checks before doing the heavier dependents page query.
 */
export async function hasDependents(
  targetType: EntityKind,
  projectId: string,
  targetId: string,
  manager?: EntityManager,
): Promise<boolean> {
  const found = await repo(manager).findOne({
    where: { projectId, targetType, targetId },
    select: { projectId: true } as any,
  });
  return Boolean(found);
}

/**
 * Per-target counts for a page of target ids. Returns a map of
 * targetId → { total, byKind } so list endpoints can fold the result
 * into each row.
 */
export async function summaryForTargets(
  targetType: EntityKind,
  projectId: string,
  targetIds: string[],
  manager?: EntityManager,
): Promise<Map<string, { total: number; byKind: Record<string, number> }>> {
  const out = new Map<string, { total: number; byKind: Record<string, number> }>();
  if (targetIds.length === 0) return out;

  // Chunk to keep parameter counts well under PostgreSQL's 65535 limit.
  const CHUNK = 500;
  const ds = manager?.connection ?? AppDataSource;
  for (let i = 0; i < targetIds.length; i += CHUNK) {
    const chunk = targetIds.slice(i, i + CHUNK);
    const rows: { targetId: string; sourceType: string; n: string }[] = await ds.query(
      `SELECT "targetId", "sourceType", COUNT(*) AS n
         FROM ${TABLE}
        WHERE "projectId"  = $1
          AND "targetType" = $2
          AND "targetId"   = ANY($3::text[])
        GROUP BY "targetId", "sourceType"`,
      [projectId, targetType, chunk],
    );
    for (const r of rows) {
      const bucket = out.get(r.targetId) ?? { total: 0, byKind: {} };
      const n = Number(r.n);
      bucket.byKind[r.sourceType] = (bucket.byKind[r.sourceType] ?? 0) + n;
      bucket.total += n;
      out.set(r.targetId, bucket);
    }
  }
  return out;
}

/** Convenience for the single-target case used by GET /:id/dependents. */
export async function summaryForTarget(
  targetType: EntityKind,
  projectId: string,
  targetId: string,
  manager?: EntityManager,
): Promise<{ total: number; byKind: Record<string, number> }> {
  const map = await summaryForTargets(targetType, projectId, [targetId], manager);
  return map.get(targetId) ?? { total: 0, byKind: {} };
}

/**
 * Page through dependents of a target. Cursor is the keyset
 * `(sourceType, sourceId)` from the previous page, base64-url encoded so
 * pagination is stable across concurrent inserts.
 *
 * Names are looked up via the catalog descriptor's (table, idColumn,
 * nameColumn) — one extra query per page, grouped by source kind.
 */
export interface DependentItem {
  kind: string;
  id: string;
  name: string | null;
  relation: string;
}

export interface DependentsPage {
  items: DependentItem[];
  nextCursor: string | null;
  totalByKind: Record<string, number>;
}

interface Cursor {
  st: string;
  sid: string;
}

const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

const decodeCursor = (s: string | undefined): Cursor | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof v?.st === 'string' && typeof v?.sid === 'string') return v;
  } catch {
    // fall through
  }
  return null;
};

export async function listDependents(
  targetType: EntityKind,
  projectId: string,
  targetId: string,
  opts: { limit?: number; cursor?: string; kind?: string } = {},
  manager?: EntityManager,
): Promise<DependentsPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const cursor = decodeCursor(opts.cursor);
  const ds = manager?.connection ?? AppDataSource;

  const params: any[] = [projectId, targetType, targetId];
  let where = `"projectId" = $1 AND "targetType" = $2 AND "targetId" = $3`;
  if (opts.kind) {
    params.push(opts.kind);
    where += ` AND "sourceType" = $${params.length}`;
  }
  if (cursor) {
    params.push(cursor.st, cursor.sid);
    // Strict keyset comparison on the composite (sourceType, sourceId)
    where += ` AND ("sourceType", "sourceId") > ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);

  const edgeRows: { sourceType: string; sourceId: string; relation: string }[] =
    await ds.query(
      `SELECT "sourceType", "sourceId", relation
         FROM ${TABLE}
        WHERE ${where}
        ORDER BY "sourceType" ASC, "sourceId" ASC
        LIMIT $${params.length}`,
      params,
    );

  const hasMore = edgeRows.length > limit;
  const page = hasMore ? edgeRows.slice(0, limit) : edgeRows;

  const items: DependentItem[] = await resolveNames(ds, page);

  // For totalByKind we issue one cheap aggregate. This is independent of
  // the keyset cursor so it stays accurate across pages.
  const totals: Record<string, number> = {};
  const totalRows: { sourceType: string; n: string }[] = await ds.query(
    `SELECT "sourceType", COUNT(*) AS n
       FROM ${TABLE}
      WHERE "projectId" = $1 AND "targetType" = $2 AND "targetId" = $3
      GROUP BY "sourceType"`,
    [projectId, targetType, targetId],
  );
  for (const r of totalRows) totals[r.sourceType] = Number(r.n);

  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ st: last.sourceType, sid: last.sourceId }) : null,
    totalByKind: totals,
  };
}

async function resolveNames(
  ds: { query: (sql: string, params?: any[]) => Promise<any> },
  rows: { sourceType: string; sourceId: string; relation: string }[],
): Promise<DependentItem[]> {
  if (rows.length === 0) return [];

  // Group source ids by kind so we can do one query per kind.
  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byKind.get(r.sourceType) ?? [];
    arr.push(r.sourceId);
    byKind.set(r.sourceType, arr);
  }

  const nameByKey = new Map<string, string | null>();
  for (const [kind, ids] of byKind) {
    const desc = referenceCatalog.get(kind as EntityKind);
    if (!desc || ids.length === 0) {
      for (const id of ids) nameByKey.set(`${kind}|${id}`, null);
      continue;
    }
    const idCol = `"${desc.idColumn}"`;
    const nameCol = `"${desc.nameColumn}"`;
    const nameRows: { id: string; name: string | null }[] = await ds.query(
      // Cast the id column to text: some entity tables key on uuid, and
      // comparing uuid against a text[] parameter throws "operator does not
      // exist: uuid = text". Matches the cast in internalReferenceEdgeRoutes.
      `SELECT ${idCol}::text AS id, ${nameCol} AS name
         FROM ${desc.table}
        WHERE ${idCol}::text = ANY($1::text[])`,
      [ids],
    );
    const seen = new Set<string>();
    for (const nr of nameRows) {
      nameByKey.set(`${kind}|${nr.id}`, nr.name ?? null);
      seen.add(nr.id);
    }
    for (const id of ids) {
      if (!seen.has(id)) nameByKey.set(`${kind}|${id}`, null);
    }
  }

  return rows.map((r) => ({
    kind: r.sourceType,
    id: r.sourceId,
    name: nameByKey.get(`${r.sourceType}|${r.sourceId}`) ?? null,
    relation: r.relation,
  }));
}

void runner; // reserved for future advanced flows; keeps import warm

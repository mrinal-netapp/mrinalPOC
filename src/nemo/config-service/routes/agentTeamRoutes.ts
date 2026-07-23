import 'reflect-metadata';
import { Router } from 'express';
import { AppDataSource } from '../db/postgres';
import { AgentTeam, AgentTeamManager } from '../models/AgentTeam';
import { AgentTeamHistory } from '../models/history/AgentTeamHistory';
import { Agent } from '../models/Agent';
import { Model } from '../models/Model';
import {
  createAgentTeamValidator,
  updateAgentTeamValidator,
  updateAgentTeamStatusValidator,
  validateTeamManagerModelSelection,
} from '../validators/agentTeamValidator';
import { validationResult } from 'express-validator';
import { Not, In } from 'typeorm';
import { validateProject } from '../middleware/projectValidator';
import {
  applyForEntity,
  removeForSource,
  hasDependents,
  summaryForTargets,
  listDependents,
} from '../services/ReferenceEdgeService';
import { buildGatewayModelId } from '../services/bifrost/bifrostProviderOps';
import {
  normalizeMemoryContextInput,
  deriveLegacyFromContext,
  validateMemoryContextShape,
} from '../services/MemoryContextDerivation';

/**
 * Derive the trio of memory fields (`memoryContext`, `memoryType`,
 * `memoryConfig`) that should be written to an `agent_teams` row given
 * the request body's `memoryContext` value.
 *
 * Returns:
 *   - `undefined` when the field is absent from the body — caller leaves
 *     the existing memory columns untouched on update / lets the schema
 *     default apply on create.
 *   - A patch with `memoryContext: null` when the client sent explicit
 *     `null` — caller must assign `null` (NOT `undefined`) so TypeORM
 *     writes a NULL to the jsonb column. Passing `undefined` here would
 *     silently skip the update and leave the previous value in place.
 *   - A string error message when the shape is invalid (the caller
 *     should return 400 with this message).
 *   - A partial AgentTeam patch when valid, ready to spread into the
 *     entity create / update.
 */
function buildMemoryFieldsFromBody(rawMemoryContext: unknown):
  | undefined
  | string
  | { memoryContext: ReturnType<typeof normalizeMemoryContextInput> | null; memoryType: 'none' | 'conversation' | 'sliding_window'; memoryConfig: ReturnType<typeof deriveLegacyFromContext>['memoryConfig'] } {
  if (rawMemoryContext === undefined) return undefined;
  if (rawMemoryContext === null) {
    // Explicit clear — null out memoryContext, reset legacy mirror to a
    // disabled state so the agent has consistent semantics. NULL (not
    // undefined!) is what TypeORM honors for clearing a jsonb column.
    return { memoryContext: null, memoryType: 'none', memoryConfig: {} };
  }
  const normalized = normalizeMemoryContextInput(rawMemoryContext);
  if (!normalized) {
    return 'memoryContext is not a recognised MemoryContext or AgentMemoryContext shape';
  }
  const shapeError = validateMemoryContextShape(normalized);
  if (shapeError) return shapeError;
  const legacy = deriveLegacyFromContext(normalized);
  return {
    memoryContext: normalized,
    memoryType: legacy.memoryType,
    memoryConfig: legacy.memoryConfig,
  };
}

const router = Router({ mergeParams: true });

type TeamMember = { memberType: 'agent' | 'team'; memberId: string };

interface EntityRef {
  id: string;
  name: string;
}

interface AgentTeamAssociatedResources {
  agents: EntityRef[];
  agentTeams: EntityRef[];
}

interface ModelSummary {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerModelId?: string;
  gatewayModelId?: string;
}

interface EnrichedAgentTeam extends AgentTeam {
  associatedResources: AgentTeamAssociatedResources;
}

/**
 * Resolve `members[]` into `{id, name}` pairs partitioned by memberType.
 * Two batched lookups (`agents` + `agent_teams`) regardless of list size.
 */
async function enrichAgentTeamReadShape(
  projectId: string,
  teams: AgentTeam[],
): Promise<EnrichedAgentTeam[]> {
  if (teams.length === 0) return [];

  const agentIds = new Set<string>();
  const teamIds = new Set<string>();
  // Collect manager modelIds so we can batch-resolve gatewayModelId for each
  // team's manager block, parallel to how enrichAgentReadShape expands an
  // agent's modelId. Without this, agent-service-maf's magentic orchestrator
  // receives a raw model UUID and the LLM gateway rejects the call.
  const managerModelIds = new Set<string>();
  for (const t of teams) {
    for (const m of t.members ?? []) {
      if (!m?.memberId) continue;
      if (m.memberType === 'agent') agentIds.add(m.memberId);
      else if (m.memberType === 'team') teamIds.add(m.memberId);
    }
    const mgrModelId =
      t.manager && typeof t.manager === 'object'
        ? (t.manager as { modelId?: unknown }).modelId
        : undefined;
    if (typeof mgrModelId === 'string' && mgrModelId) {
      managerModelIds.add(mgrModelId);
    }
  }

  const agentMap = new Map<string, EntityRef>();
  if (agentIds.size > 0) {
    const rows = await AppDataSource.getRepository(Agent).find({
      where: { id: In([...agentIds]), projectId },
      select: ['id', 'name'],
    });
    for (const a of rows) agentMap.set(a.id, { id: a.id, name: a.name });
  }

  const teamMap = new Map<string, EntityRef>();
  if (teamIds.size > 0) {
    const rows = await AppDataSource.getRepository(AgentTeam).find({
      where: { id: In([...teamIds]), projectId },
      select: ['id', 'name'],
    });
    for (const t of rows) teamMap.set(t.id, { id: t.id, name: t.name });
  }

  const modelMap = new Map<string, ModelSummary>();
  if (managerModelIds.size > 0) {
    const rows = await AppDataSource.getRepository(Model).find({
      where: { id: In([...managerModelIds]), projectId },
    });
    for (const m of rows) {
      // Backfill mirrors enrichAgentReadShape — legacy rows have a null
      // gatewayModelId column; synthesise it from provider + providerModelId
      // so MAF's adapter still gets a routable Bifrost name.
      const gatewayModelId =
        m.gatewayModelId
        || (m.providerModelId
          ? buildGatewayModelId(m.provider, m.providerModelId)
          : undefined);
      modelMap.set(m.id, {
        id: m.id,
        name: m.name,
        displayName: m.displayName,
        provider: m.provider,
        providerModelId: m.providerModelId,
        gatewayModelId,
      });
    }
  }

  return teams.map((t) => {
    const agents: EntityRef[] = [];
    const agentTeams: EntityRef[] = [];
    for (const m of t.members ?? []) {
      if (m?.memberType === 'agent') {
        const ref = agentMap.get(m.memberId);
        if (ref) agents.push(ref);
      } else if (m?.memberType === 'team') {
        const ref = teamMap.get(m.memberId);
        if (ref) agentTeams.push(ref);
      }
    }
    // Inject the resolved manager.model dict alongside the raw modelId so
    // the existing wire contract (manager.modelId) is preserved. The
    // `AgentTeamManager` interface only types the write-time shape; the
    // read-time annotation lives only on the wire and the cast through
    // `unknown` documents that intent.
    let enrichedManager = t.manager as AgentTeamManager | undefined;
    if (enrichedManager && typeof enrichedManager === 'object') {
      const mgrModelId =
        typeof enrichedManager.modelId === 'string' ? enrichedManager.modelId : '';
      const modelSummary = mgrModelId ? modelMap.get(mgrModelId) : undefined;
      if (modelSummary) {
        enrichedManager = { ...enrichedManager, model: modelSummary } as unknown as AgentTeamManager;
      }
    }
    return Object.assign({}, t, {
      manager: enrichedManager,
      associatedResources: { agents, agentTeams },
    }) as EnrichedAgentTeam;
  });
}

async function validateMemberRefs(projectId: string, members: TeamMember[]): Promise<string | null> {
  const agentIds = members.filter(m => m.memberType === 'agent').map(m => m.memberId);
  const teamIds = members.filter(m => m.memberType === 'team').map(m => m.memberId);

  if (agentIds.length > 0) {
    const repo = AppDataSource.getRepository(Agent);
    const found = await repo.find({ where: { id: In(agentIds), projectId } });
    const foundIds = new Set(found.map(a => a.id));
    const missing = agentIds.filter(id => !foundIds.has(id));
    if (missing.length > 0) return `Member agent(s) not found in this project: ${missing.join(', ')}`;
  }

  if (teamIds.length > 0) {
    const repo = AppDataSource.getRepository(AgentTeam);
    const found = await repo.find({ where: { id: In(teamIds), projectId } });
    const foundIds = new Set(found.map(t => t.id));
    const missing = teamIds.filter(id => !foundIds.has(id));
    if (missing.length > 0) return `Member team(s) not found in this project: ${missing.join(', ')}`;
  }

  return null;
}

/**
 * When `manager.agent_id` is provided, ensure it references an existing
 * agent in the same project. Mirrors `validateMemberRefs` semantics —
 * returns an error message string on failure, or null on success.
 */
async function validateManagerAgentRef(
  projectId: string,
  manager: unknown,
): Promise<string | null> {
  if (!manager || typeof manager !== 'object') return null;
  const m = manager as Record<string, unknown>;
  if (typeof m.agent_id !== 'string' || m.agent_id.trim() === '') return null;

  const repo = AppDataSource.getRepository(Agent);
  const found = await repo.findOne({ where: { id: m.agent_id, projectId } });
  if (!found) {
    return `Manager agent_id '${m.agent_id}' not found in this project`;
  }
  return null;
}

async function hasCycle(projectId: string, rootId: string, members: TeamMember[]): Promise<boolean> {
  const repo = AppDataSource.getRepository(AgentTeam);
  const edges = new Map<string, string[]>();
  const teams = await repo.find({ where: { projectId } });
  for (const team of teams) {
    edges.set(team.id, (team.members || []).filter(m => m.memberType === 'team').map(m => m.memberId));
  }
  edges.set(rootId, members.filter(m => m.memberType === 'team').map(m => m.memberId));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const nxt of edges.get(id) || []) {
      if (dfs(nxt)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return dfs(rootId);
}

router.post('/', validateProject, createAgentTeamValidator, validateTeamManagerModelSelection('create'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(AgentTeam);
    const exists = await repo.findOne({ where: { projectId, name: req.body.name.trim() } });
    if (exists) {
      return res.status(409).json({ error: 'Agent team with this name already exists in this project' });
    }

    const memberError = await validateMemberRefs(projectId, req.body.members || []);
    if (memberError) {
      return res.status(400).json({ error: memberError });
    }

    const managerError = await validateManagerAgentRef(projectId, req.body.manager);
    if (managerError) {
      return res.status(400).json({ error: managerError });
    }

    // memoryContext normalization + legacy derivation. When the client
    // sends `memoryContext` (new schema, possibly the legacy AgentMemoryContext
    // shape), we normalize it to the unified shape and overwrite the legacy
    // `memoryType` + `memoryConfig` fields from it. agent-service reads the
    // legacy fields; MAF reads memoryContext. Both stay in sync.
    const memoryFields = buildMemoryFieldsFromBody(req.body.memoryContext);
    if (typeof memoryFields === 'string') {
      return res.status(400).json({ error: memoryFields });
    }

    const team = repo.create({
      ...req.body,
      ...(memoryFields ?? {}),
      projectId,
      orchestrationPolicy: req.body.orchestrationPolicy || 'coordinate',
    } as Partial<AgentTeam>);
    const saved = await repo.save(team);

    if (await hasCycle(projectId, saved.id, saved.members || [])) {
      await repo.delete({ id: saved.id, projectId });
      return res.status(400).json({ error: 'Team member graph contains a cycle' });
    }
    await applyForEntity(undefined, 'agent_team', projectId, saved);
    res.status(201).json(saved);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { limit = 20, skip = 0, nameRegex } = req.query;
    const repo = AppDataSource.getRepository(AgentTeam);
    const queryBuilder = repo.createQueryBuilder('team');
    queryBuilder.where('team.projectId = :projectId', { projectId });

    if (nameRegex) {
      queryBuilder.andWhere('team.name ILIKE :name', { name: `%${nameRegex}%` });
    }

    const items = await queryBuilder
      .skip(Number(skip))
      .take(Number(limit))
      .orderBy('team.updatedAt', 'DESC')
      .getMany();

    if (items.length === 0) {
      return res.json(items);
    }

    const enriched = await enrichAgentTeamReadShape(projectId, items);

    const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary) {
      return res.json(enriched);
    }
    const summary = await summaryForTargets('agent_team', projectId, items.map((t) => t.id));
    res.json(enriched.map((t) => ({
      ...t,
      dependentsSummary: summary.get(t.id) ?? { total: 0, byKind: {} },
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(AgentTeam);
    const item = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!item) return res.status(404).json({ error: 'Agent team not found' });
    const [enriched] = await enrichAgentTeamReadShape(projectId, [item]);
    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', validateProject, updateAgentTeamValidator, validateTeamManagerModelSelection('update'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(AgentTeam);
    const current = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!current) {
      return res.status(404).json({ error: 'Agent team not found' });
    }

    if (req.body.name !== undefined && req.body.name !== null && req.body.name.trim() !== '') {
      if (current.name !== req.body.name.trim()) {
        const exists = await repo.findOne({
          where: { projectId, name: req.body.name.trim(), id: Not(req.params.id) },
        });
        if (exists) {
          return res.status(409).json({ error: 'Agent team with this name already exists in this project' });
        }
      }
    }

    if (req.body.members) {
      const memberError = await validateMemberRefs(projectId, req.body.members);
      if (memberError) {
        return res.status(400).json({ error: memberError });
      }
    }

    if (req.body.manager !== undefined) {
      const managerError = await validateManagerAgentRef(projectId, req.body.manager);
      if (managerError) {
        return res.status(400).json({ error: managerError });
      }
    }

    const updateData: any = {};
    Object.keys(req.body).forEach(key => {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    });

    // memoryContext normalization + legacy derivation on update. When
    // `memoryContext` is present in the patch we replace its raw value
    // with the normalized shape AND overwrite the legacy `memoryType` +
    // `memoryConfig` fields from it. When absent, all three columns are
    // left alone.
    if ('memoryContext' in updateData) {
      const memoryFields = buildMemoryFieldsFromBody(updateData.memoryContext);
      if (typeof memoryFields === 'string') {
        return res.status(400).json({ error: memoryFields });
      }
      if (memoryFields !== undefined) {
        updateData.memoryContext = memoryFields.memoryContext;
        updateData.memoryType = memoryFields.memoryType;
        updateData.memoryConfig = memoryFields.memoryConfig;
      }
    }

    if (Object.keys(updateData).length > 0) {
      if (updateData.orchestration) {
        updateData.orchestrationPolicy = updateData.orchestration;
        delete updateData.orchestration;
      }
      await repo.update({ id: req.params.id, projectId }, { ...updateData, projectId } as any);
    }

    const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Agent team not found' });
    if (await hasCycle(projectId, updated.id, updated.members || [])) {
      return res.status(400).json({ error: 'Team member graph contains a cycle' });
    }
    await applyForEntity(undefined, 'agent_team', projectId, updated);
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(AgentTeam);
    const item = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!item) return res.status(404).json({ error: 'Agent team not found' });

    if (await hasDependents('agent_team', projectId, req.params.id)) {
      const page = await listDependents('agent_team', projectId, req.params.id, { limit: 50 });
      return res.status(409).json({
        error:
          'Cannot delete this team because it is still in use. Update or remove those references, then try again.',
        code: 'HAS_DEPENDENTS',
        dependents: page,
      });
    }
    // Legacy textual member-id check is preserved as a defense-in-depth
    // signal until member references are first-class edges in the catalog.
    const referenced = await repo
      .createQueryBuilder('team')
      .where('team.projectId = :projectId', { projectId })
      .andWhere(`team.members::text LIKE :memberRef`, { memberRef: `%\"memberId\":\"${req.params.id}\"%` })
      .getOne();
    if (referenced) {
      return res.status(409).json({
        error: `Team is referenced by team ${referenced.id}`,
        code: 'HAS_DEPENDENTS',
      });
    }
    await removeForSource(undefined, 'agent_team', projectId, req.params.id);
    const deleted = await repo.delete({ id: req.params.id, projectId });
    if (deleted.affected === 0) return res.status(404).json({ error: 'Agent team not found' });
    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/dependents', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(AgentTeam);
    const exists = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!exists) return res.status(404).json({ error: 'Agent team not found' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    const page = await listDependents('agent_team', projectId, req.params.id, { limit, cursor, kind });
    res.json(page);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/history', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const teamRepo = AppDataSource.getRepository(AgentTeam);
    const team = await teamRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }
    const repo = AppDataSource.getRepository(AgentTeamHistory);
    const history = await repo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });
    if (!history || history.length === 0) return res.status(404).json({ error: 'No history found for this Agent team' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Update lifecycle / deployment status fields only. Body accepts any subset
 * of `status`, `statusMessage`, `deploymentStatus` — at least one field is
 * required. Returns the updated agent team.
 *
 * Mirrors `PUT /agents/{id}/status`. Workflow / deployment callers should
 * prefer this endpoint over the regular `PUT /:id`.
 */
router.put('/:id/status', validateProject, updateAgentTeamStatusValidator, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { status, statusMessage, deploymentStatus } = req.body ?? {};
  if (status === undefined && statusMessage === undefined && deploymentStatus === undefined) {
    return res.status(400).json({
      error: 'At least one of status, statusMessage, or deploymentStatus is required',
    });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(AgentTeam);
    const existing = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!existing) return res.status(404).json({ error: 'Agent team not found' });

    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (statusMessage !== undefined) updateData.statusMessage = statusMessage;
    if (deploymentStatus !== undefined) updateData.deploymentStatus = deploymentStatus;

    await repo.update({ id: req.params.id, projectId }, updateData);
    const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Agent team not found' });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/restore-version', validateProject, async (req, res) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body' });
  }
  try {
    const projectId = req.params.projectId;
    const historyRepo = AppDataSource.getRepository(AgentTeamHistory);
    const teamRepo = AppDataSource.getRepository(AgentTeam);
    const team = await teamRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!team) {
      return res.status(404).json({ error: 'Agent team not found' });
    }
    const history = await historyRepo.findOne({
      where: { entityId: req.params.id, version },
    });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });

    const { data } = history;
    const { id, createdAt, updatedAt, ...restoreData } = data;

    await teamRepo.update({ id: req.params.id, projectId }, { ...restoreData, projectId });
    const updated = await teamRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Agent team not found' });
    res.json({ restored: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

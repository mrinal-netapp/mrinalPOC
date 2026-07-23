import 'reflect-metadata';
import { Router } from 'express';
import { AppDataSource } from '../db/postgres';
import { Agent, AgentRequirements } from '../models/Agent';
import { AgentHistory } from '../models/history/AgentHistory';
import { AgentTeam } from '../models/AgentTeam';
import { MCPServer } from '../models/MCPServer';
import { Model } from '../models/Model';
import { KnowledgeBase } from '../models/KnowledgeBase';
import {
  createAgentValidator,
  updateAgentValidator,
  updateAgentStatusValidator,
  validateAgentModelSelection,
} from '../validators/agentValidator';
import { validationResult } from 'express-validator';
import { Not, In } from 'typeorm';
import { validateProject } from '../middleware/projectValidator';
import { getCatalogEntry } from '../catalog/mcpServerCatalog';
import { isPlatformMcpAutoAttachable } from '../catalog/platformMcpDefaults';
import {
  applyForEntity,
  removeForSource,
  hasDependents,
  summaryForTargets,
  listDependents,
} from '../services/ReferenceEdgeService';
import { GuardrailCatalogService } from '../services/GuardrailCatalogService';
import { buildGatewayModelId } from '../services/bifrost/bifrostProviderOps';
import {
  normalizeMemoryContextInput,
  deriveLegacyFromContext,
  validateMemoryContextShape,
} from '../services/MemoryContextDerivation';

/**
 * Build the trio of memory fields (`memoryContext`, `memoryType`,
 * `memoryConfig`) for persistence on an `agents` row, given the request
 * body's `memoryContext` value. Returns:
 *
 *   - `undefined` when the field is absent from the body — caller leaves
 *     the row's memory columns untouched on update / lets the schema
 *     default apply on create.
 *   - A patch object with `memoryContext: null` when the client sent an
 *     explicit `null` — caller assigns `null` so TypeORM writes a NULL
 *     to the jsonb column (don't pass `undefined`; TypeORM skips it).
 *   - A string error message when the shape is invalid (the caller
 *     should return 400).
 *   - The patch object with the normalized memoryContext otherwise.
 */
function buildMemoryFieldsFromBody(rawMemoryContext: unknown):
  | undefined
  | string
  | { memoryContext: ReturnType<typeof normalizeMemoryContextInput> | null; memoryType: 'none' | 'conversation' | 'sliding_window'; memoryConfig: ReturnType<typeof deriveLegacyFromContext>['memoryConfig'] } {
  if (rawMemoryContext === undefined) return undefined;
  if (rawMemoryContext === null) {
    // Explicit clear — write NULL to memory_context, reset legacy mirror
    // to a disabled state so the agent has consistent semantics.
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

interface ModelSummary {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerModelId?: string;
  gatewayModelId?: string;
}

interface EntityRef {
  id: string;
  name: string;
}

interface AgentAssociatedResources {
  knowledgeBases: EntityRef[];
  agentTeams: EntityRef[];
}

interface EnrichedAgent extends Agent {
  model: ModelSummary | null;
  fallbackModels: ModelSummary[];
  associatedResources: AgentAssociatedResources;
}

/**
 * Resolve primary + fallback models, attached KBs, and parent teams into
 * read-only annotations on each agent. Uses three batched queries (models,
 * KBs, agent_teams membership) regardless of the list size.
 */
async function enrichAgentReadShape(
  projectId: string,
  agents: Agent[],
): Promise<EnrichedAgent[]> {
  if (agents.length === 0) return [];

  // 1. Models — primary + fallback
  const modelIds = new Set<string>();
  for (const a of agents) {
    if (a.modelId) modelIds.add(a.modelId);
    for (const id of a.fallbackModelIds ?? []) {
      if (typeof id === 'string' && id) modelIds.add(id);
    }
  }
  const modelMap = new Map<string, ModelSummary>();
  if (modelIds.size > 0) {
    // Scope the lookup to the current project so a stale or
    // attacker-supplied `fallbackModelIds` entry from another project does
    // not leak that model's name / provider metadata through this read
    // path. Mirrors the project-scoping the KB and team enrichment queries
    // below already do.
    const rows = await AppDataSource.getRepository(Model).find({
      where: { id: In([...modelIds]), projectId },
    });
    for (const m of rows) {
      // Mirror the backfill in modelRoutes.ts GET /:id — the stored
      // gatewayModelId is null for legacy rows that pre-date the column,
      // but agent-service-maf now requires the field. Synthesize from
      // provider + providerModelId when the column is empty so existing
      // catalogs work without a migration.
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

  // 2. Knowledge bases referenced by any agent in the list
  const kbIds = new Set<string>();
  for (const a of agents) {
    for (const id of a.knowledgeBaseIds ?? []) {
      if (typeof id === 'string' && id) kbIds.add(id);
    }
  }
  const kbMap = new Map<string, EntityRef>();
  if (kbIds.size > 0) {
    const rows = await AppDataSource.getRepository(KnowledgeBase).find({
      where: { id: In([...kbIds]), projectId },
      select: ['id', 'name'],
    });
    for (const k of rows) {
      kbMap.set(k.id, { id: k.id, name: k.name });
    }
  }

  // 3. Agent teams that include any of these agents as a member.
  //    Single project-scoped scan; partitioned in code per agent.
  const agentTeamRows: Array<Pick<AgentTeam, 'id' | 'name' | 'members'>> = (await AppDataSource
    .getRepository(AgentTeam)
    .createQueryBuilder('t')
    .select(['t.id', 't.name', 't.members'])
    .where('t.projectId = :projectId', { projectId })
    .getMany()) as any;

  const teamsByAgent = new Map<string, EntityRef[]>();
  for (const team of agentTeamRows) {
    for (const member of team.members ?? []) {
      if (member?.memberType === 'agent' && typeof member.memberId === 'string') {
        const arr = teamsByAgent.get(member.memberId) ?? [];
        arr.push({ id: team.id, name: team.name });
        teamsByAgent.set(member.memberId, arr);
      }
    }
  }

  return agents.map((a) => {
    const model = a.modelId ? modelMap.get(a.modelId) ?? null : null;
    const fallbackModels: ModelSummary[] = [];
    for (const id of a.fallbackModelIds ?? []) {
      const m = modelMap.get(id);
      if (m) fallbackModels.push(m);
    }
    const knowledgeBases: EntityRef[] = [];
    for (const id of a.knowledgeBaseIds ?? []) {
      const k = kbMap.get(id);
      if (k) knowledgeBases.push(k);
    }
    const agentTeams = teamsByAgent.get(a.id) ?? [];
    return Object.assign({}, a, {
      model,
      fallbackModels,
      associatedResources: { knowledgeBases, agentTeams },
    }) as EnrichedAgent;
  });
}

/**
 * Enforce the strict 1:1 mapping between `knowledgeBaseIds` and the per-KB
 * `ragConfig` map: every attached KB must have a `ragConfig` entry, and there
 * must be no orphan keys (a `ragConfig` key not present in `knowledgeBaseIds`).
 * An absent / empty `ragConfig` (`null` / `undefined` / `{}`) is valid only
 * when there are no attached KBs. Throws on violation so the route's catch
 * maps it to `400 { error }`.
 *
 * Callers pass the *effective merged* state (body value when the field is
 * present in the request body, otherwise the stored value) so partial PATCH
 * updates are validated against what will actually be persisted.
 */
function assertRagConfigCoverage(knowledgeBaseIds: unknown, ragConfig: unknown): void {
  const kbSet = new Set(
    Array.isArray(knowledgeBaseIds)
      ? knowledgeBaseIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
  );

  const ragKeys =
    ragConfig && typeof ragConfig === 'object' && !Array.isArray(ragConfig)
      ? Object.keys(ragConfig as Record<string, unknown>)
      : [];

  const missing = [...kbSet].filter((id) => !ragKeys.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `ragConfig is missing an entry for knowledgeBaseId(s): ${missing.join(', ')}`,
    );
  }

  const orphans = ragKeys.filter((key) => !kbSet.has(key));
  if (orphans.length > 0) {
    throw new Error(
      `ragConfig has ${orphans.length === 1 ? 'an entry' : 'entries'} for unknown knowledgeBaseId(s): ${orphans.join(', ')}`,
    );
  }
}

/**
 * Shape of one entry in the deployment-gate 400 body's
 * `unmetRequirements` array. Structured (rather than a colon-joined
 * string) so the UI can render each entry without parsing — labels
 * can contain colons, which a string-encoded form would split on.
 */
type UnmetRequirement = {
  kind: 'knowledgeBases' | 'mcpServers';
  id: string;
  label: string;
};

/**
 * Collect placeholders with `required: true` still on the agent.
 * Returns an empty array when there are no unmet requirements (the
 * happy path) — the deployment gate short-circuits on `.length === 0`.
 *
 * Each entry carries `kind` (which placeholder list it came from),
 * the placeholder `id` (for in-place patch / delete), and the human
 * `label` (for the error message the UI shows). Order is stable:
 * `knowledgeBases` entries first, then `mcpServers`, preserving
 * within-list array order.
 */
function unmetRequiredRequirements(
  requirements: AgentRequirements | null | undefined,
): UnmetRequirement[] {
  if (!requirements || typeof requirements !== 'object') return [];
  const out: UnmetRequirement[] = [];
  for (const kind of ['knowledgeBases', 'mcpServers'] as const) {
    const entries = requirements[kind];
    if (!Array.isArray(entries)) continue;
    for (const r of entries) {
      if (
        r
        && r.required === true
        && typeof r.id === 'string'
        && typeof r.label === 'string'
      ) {
        out.push({ kind, id: r.id, label: r.label });
      }
    }
  }
  return out;
}

const router = Router({ mergeParams: true });
const AUTO_ATTACH_PLATFORM_WEB_SEARCH = String(
  process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP || '',
).toLowerCase() === 'true';
const AUTO_ATTACH_PLATFORM_ANALYTICS = String(
  process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP || '',
).toLowerCase() === 'true';

router.post('/', validateProject, createAgentValidator, validateAgentModelSelection('create'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Agent);
    const exists = await repo.findOne({ where: { projectId, name: req.body.name.trim() } });
    if (exists) {
      return res.status(409).json({ error: 'Agent with this name already exists in this project' });
    }

    // Catalog-aware guardrails validation (stage-match + config_schema).
    // await GuardrailCatalogService.validateAgentGuardrails(req.body.guardrails);

    // Strict 1:1: every attached knowledgeBaseId must have a ragConfig entry
    // (and no orphan keys). On create the body is the full state.
    assertRagConfigCoverage(req.body.knowledgeBaseIds, req.body.ragConfig);

    const createPayload = { ...req.body } as Record<string, unknown>;
    delete createPayload.datasetIds;

    // memoryContext normalization + legacy derivation. When the body
    // supplies `memoryContext` (new schema or legacy AgentMemoryContext),
    // we overwrite memoryType + memoryConfig from the normalized value so
    // agent-service continues to read its expected fields while MAF
    // reads memoryContext directly.
    const memoryFields = buildMemoryFieldsFromBody(createPayload.memoryContext);
    if (typeof memoryFields === 'string') {
      return res.status(400).json({ error: memoryFields });
    }
    if (memoryFields !== undefined) {
      createPayload.memoryContext = memoryFields.memoryContext;
      createPayload.memoryType = memoryFields.memoryType;
      createPayload.memoryConfig = memoryFields.memoryConfig;
    }

    const agent = repo.create({ ...createPayload, projectId });
    const saved = await repo.save(agent);
    await applyForEntity(undefined, 'agent', projectId, saved);
    res.status(201).json(saved);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { limit = 20, skip = 0, field, value, nameRegex } = req.query;
    const repo = AppDataSource.getRepository(Agent);
    const queryBuilder = repo.createQueryBuilder('agent');
    queryBuilder.where('agent.projectId = :projectId', { projectId });

    if (field && value) {
      queryBuilder.andWhere(`agent.${field as string} = :value`, { value });
    }
    if (nameRegex) {
      queryBuilder.andWhere('agent.name ILIKE :name', { name: `%${nameRegex}%` });
    }

    const items = await queryBuilder
      .skip(Number(skip))
      .take(Number(limit))
      .orderBy('agent.updatedAt', 'DESC')
      .getMany();

    if (items.length === 0) {
      return res.json(items);
    }

    const enriched = await enrichAgentReadShape(projectId, items);

    const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary) {
      return res.json(enriched);
    }
    const summary = await summaryForTargets('agent', projectId, items.map((a) => a.id));
    res.json(enriched.map((a) => ({
      ...a,
      dependentsSummary: summary.get(a.id) ?? { total: 0, byKind: {} },
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Agent);
    const item = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!item) return res.status(404).json({ error: 'Agent not found' });

    const mcpRepo = AppDataSource.getRepository(MCPServer);
    const resolved: Record<string, any> = {};

    if (item.mcpServerIds?.length) {
      const servers = await mcpRepo.find({ where: { id: In(item.mcpServerIds) } });
      for (const s of servers) {
        if (s.status === 'error') continue;
        const catalogEntry = s.catalogId ? getCatalogEntry(s.catalogId) : undefined;
        resolved[s.id] = {
          name: s.name,
          llmproxyGatewayServerName: s.llmproxyGatewayServerName,
          llmproxyGatewayServerId: s.llmproxyGatewayServerId,
          transport: s.transport,
          syncStatus: s.syncStatus,
          status: s.status,
          timeout: s.timeout,
          catalogId: s.catalogId || null,
          serverInstructions: s.serverInstructions || null,
          promptFragment: catalogEntry?.promptFragment || null,
        };
      }
    }

    const platformServers = await mcpRepo.find({ where: { deploymentType: 'platform' } });
    const platformAutoAttachFlags = {
      webSearch: AUTO_ATTACH_PLATFORM_WEB_SEARCH,
      analytics: AUTO_ATTACH_PLATFORM_ANALYTICS,
    };
    for (const s of platformServers) {
      if (s.status === 'error') continue;
      // Same rollout gates that decide whether the platform MCP is attached to
      // the project's Bifrost VK (see attachPlatformMcpServersToProjectVirtualKey)
      // so the agent is never told about a server its VK can't reach.
      if (!isPlatformMcpAutoAttachable(s.catalogId, platformAutoAttachFlags)) {
        continue;
      }
      if (!resolved[s.id]) {
        const catalogEntry = s.catalogId ? getCatalogEntry(s.catalogId) : undefined;
        resolved[s.id] = {
          name: s.name,
          llmproxyGatewayServerName: s.llmproxyGatewayServerName,
          llmproxyGatewayServerId: s.llmproxyGatewayServerId,
          transport: s.transport,
          syncStatus: s.syncStatus,
          status: s.status,
          timeout: s.timeout,
          catalogId: s.catalogId || null,
          serverInstructions: s.serverInstructions || null,
          promptFragment: catalogEntry?.promptFragment || null,
        };
      }
    }

    if (Object.keys(resolved).length > 0) {
      (item as any)._resolvedMCPServers = resolved;
    }

    const [enriched] = await enrichAgentReadShape(projectId, [item]);
    // Preserve _resolvedMCPServers if it was attached above.
    if ((item as any)._resolvedMCPServers) {
      (enriched as any)._resolvedMCPServers = (item as any)._resolvedMCPServers;
    }

    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', validateProject, updateAgentValidator, validateAgentModelSelection('update'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Agent);
    const currentAgent = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!currentAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (req.body.name !== undefined && req.body.name !== null && req.body.name.trim() !== '') {
      if (currentAgent.name !== req.body.name.trim()) {
        const exists = await repo.findOne({
          where: { projectId, name: req.body.name.trim(), id: Not(req.params.id) },
        });
        if (exists) {
          return res.status(409).json({ error: 'Agent with this name already exists in this project' });
        }
      }
    }

    // Catalog-aware guardrails validation (stage-match + config_schema).
    // if (req.body.guardrails !== undefined) {
    //   await GuardrailCatalogService.validateAgentGuardrails(req.body.guardrails);
    // }

    // Strict 1:1 ragConfig <-> knowledgeBaseIds. Update is a partial merge, so
    // validate the effective merged state by key presence (not `??`, which
    // would mask an explicit `null` clear). Run whenever either field is in the
    // body — changing only knowledgeBaseIds can break coverage vs the stored
    // ragConfig.
    if ('knowledgeBaseIds' in req.body || 'ragConfig' in req.body) {
      const mergedKbIds =
        'knowledgeBaseIds' in req.body ? req.body.knowledgeBaseIds : currentAgent.knowledgeBaseIds;
      const mergedRagConfig =
        'ragConfig' in req.body ? req.body.ragConfig : currentAgent.ragConfig;
      assertRagConfigCoverage(mergedKbIds, mergedRagConfig);
    }

    // Deployment gate (mirrors PUT /:id/status). When a full PUT also
    // tries to flip deploymentStatus to `deployed`, validate the
    // effective requirements — a single body can legitimately clear
    // the last placeholder and flip to deployed atomically, so we
    // look at the merged state, not just the stored one.
    if (req.body.deploymentStatus === 'deployed') {
      const effectiveRequirements =
        'requirements' in req.body ? req.body.requirements : currentAgent.requirements;
      const unmet = unmetRequiredRequirements(effectiveRequirements);
      if (unmet.length > 0) {
        return res.status(400).json({
          error:
            'Cannot transition to deployed: required resource placeholders remain unresolved',
          unmetRequirements: unmet,
        });
      }
    }

    const IMMUTABLE_FIELDS = new Set(['id', 'projectId', 'createdAt', 'updatedAt']);
    const updateData: any = {};
    Object.keys(req.body).forEach(key => {
      if (key === 'datasetIds') {
        return;
      }
      if (req.body[key] !== undefined && !IMMUTABLE_FIELDS.has(key)) {
        updateData[key] = req.body[key];
      }
    });

    // memoryContext normalization + legacy derivation on update. When
    // `memoryContext` is present in the patch we replace its raw value
    // with the normalized shape AND overwrite the legacy `memoryType` +
    // `memoryConfig` fields from it.
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
      await repo.update({ id: req.params.id, projectId }, { ...updateData, projectId });
    }

    const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Agent not found' });
    await applyForEntity(undefined, 'agent', projectId, updated);
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Agent);
    const item = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!item) return res.status(404).json({ error: 'Agent not found' });

    if (await hasDependents('agent', projectId, req.params.id)) {
      const page = await listDependents('agent', projectId, req.params.id, { limit: 50 });
      return res.status(409).json({
        error:
          'Cannot delete this agent because it is still in use. Update or remove those references, then try again.',
        code: 'HAS_DEPENDENTS',
        dependents: page,
      });
    }

    await removeForSource(undefined, 'agent', projectId, req.params.id);
    const deleted = await repo.delete({ id: req.params.id, projectId });
    if (deleted.affected === 0) return res.status(404).json({ error: 'Agent not found' });
    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/dependents', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Agent);
    const exists = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!exists) return res.status(404).json({ error: 'Agent not found' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    const page = await listDependents('agent', projectId, req.params.id, { limit, cursor, kind });
    res.json(page);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/history', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const repo = AppDataSource.getRepository(AgentHistory);
    const history = await repo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });
    if (!history || history.length === 0) return res.status(404).json({ error: 'No history found for this Agent' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Update lifecycle / deployment status fields only. Body accepts any subset
 * of `status`, `statusMessage`, `deploymentStatus` — at least one field is
 * required. Returns the updated agent.
 *
 * This endpoint exists alongside the regular `PUT /:id` (which can also
 * update these fields). Workflow / deployment callers should prefer this
 * endpoint because it carries a focused contract and never re-validates
 * the rest of the agent configuration.
 */
router.put('/:id/status', validateProject, updateAgentStatusValidator, async (req, res) => {
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
    const repo = AppDataSource.getRepository(Agent);
    const existing = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!existing) return res.status(404).json({ error: 'Agent not found' });

    // Deployment gate: a transition to `deployed` requires every
    // `required: true` placeholder in `requirements` to be resolved
    // first. Other deploymentStatus transitions (draft, preview,
    // not_deployed, deploying, failed, terminating, terminated) are
    // allowed to carry unresolved requirements — that's the entire
    // point of the field. The gate fires even on a deployed→deployed
    // re-deploy so a requirement added after the original deploy can't
    // be bypassed.
    if (deploymentStatus === 'deployed') {
      const unmet = unmetRequiredRequirements(existing.requirements);
      if (unmet.length > 0) {
        return res.status(400).json({
          error:
            'Cannot transition to deployed: required resource placeholders remain unresolved',
          unmetRequirements: unmet,
        });
      }
    }

    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (statusMessage !== undefined) updateData.statusMessage = statusMessage;
    if (deploymentStatus !== undefined) updateData.deploymentStatus = deploymentStatus;

    await repo.update({ id: req.params.id, projectId }, updateData);
    const updated = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Agent not found' });
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
    const historyRepo = AppDataSource.getRepository(AgentHistory);
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const history = await historyRepo.findOne({
      where: { entityId: req.params.id, version },
    });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });

    const { data } = history;
    const { id, createdAt, updatedAt, ...restoreData } = data;

    await agentRepo.update({ id: req.params.id, projectId }, { ...restoreData, projectId });
    const updated = await agentRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Agent not found' });
    res.json({ restored: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

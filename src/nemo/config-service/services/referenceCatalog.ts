import type { Agent } from '../models/Agent';
import type { AgentTeam, AgentTeamMember } from '../models/AgentTeam';
import type { Model } from '../models/Model';
import type { MCPServer } from '../models/MCPServer';
import type { Pipeline } from '../models/Pipeline';
import type { KnowledgeBase } from '../models/KnowledgeBase';
import type { DataSet } from '../models/DataSet';
import type { DataSource } from '../models/DataSource';
import type { Credential } from '../models/Credential';
import type { EvaluationTemplate } from '../models/EvaluationTemplate';
import type { EntityKind, EdgeRelation } from '../models/ReferenceEdge';

/**
 * One declarative place that knows, for each entity kind:
 *   - the SQL table / id / name columns (used to resolve dependent names)
 *   - how to derive its outgoing edges from a row in memory
 *
 * Adding a reference field anywhere in the codebase becomes a one-line
 * change to the appropriate descriptor's `extract` function.
 */

/** Outgoing edge produced by a source row. */
export interface EdgeOut {
  targetType: EntityKind;
  targetId: string;
  relation: EdgeRelation;
}

/** Static metadata about a participating entity kind. */
export interface SourceDescriptor<Row = unknown> {
  /** Stable id used in the edge table and API responses. */
  sourceType: EntityKind;
  /** Table name in the config-service Postgres database. */
  table: string;
  /** Primary-key column on `table`. */
  idColumn: string;
  /** Human-readable name column on `table` (used in dependents popover). */
  nameColumn: string;
  /**
   * Project-scoping column on `table`. Most tables use the TypeORM default
   * camelCase identifier `"projectId"`; `data_sources` is the historical
   * outlier with snake_case `project_id`.
   */
  projectColumn?: string;
  /**
   * Optional additional columns to project into the dependents response.
   * Reserved for future use; today only `nameColumn` is fetched.
   */
  extraColumns?: string[];
  /**
   * Pure: given the row in memory, return the edges this row should have.
   * Must be deterministic. Self-references and duplicate (source, target,
   * relation) tuples are filtered upstream by the caller.
   */
  extract: (row: Row) => EdgeOut[];
  /**
   * If true, the synchronous write path is sufficient — the reconciler
   * does not need to scan this kind for embedded references.
   * If false, the reconciler walks rows of this kind on its tick (today
   * only `pipeline`, whose graph JSONB hides ids the synchronous path
   * cannot enumerate cheaply).
   */
  syncOnly: boolean;
}

const cleanIds = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v): v is string => v.length > 0);
};

const agent: SourceDescriptor<Agent> = {
  sourceType: 'agent',
  table: 'agents',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    if (row.modelId) {
      out.push({ targetType: 'model', targetId: row.modelId, relation: 'uses_model' });
    }
    // Fallback models are real references too -- without these edges,
    // `DELETE /models/{id}` would succeed for a model that's only referenced
    // as a fallback, leaving agents with a dangling fallback ID.
    for (const id of cleanIds(row.fallbackModelIds)) {
      if (id === row.modelId) continue; // avoid duplicate primary edge
      out.push({ targetType: 'model', targetId: id, relation: 'uses_model' });
    }
    for (const id of cleanIds(row.mcpServerIds)) {
      out.push({ targetType: 'mcp_server', targetId: id, relation: 'uses_mcp' });
    }
    for (const id of cleanIds(row.knowledgeBaseIds)) {
      out.push({ targetType: 'knowledge_base', targetId: id, relation: 'uses_kb' });
    }
    for (const id of cleanIds(row.datasetIds)) {
      out.push({ targetType: 'dataset', targetId: id, relation: 'uses_dataset' });
    }
    return out;
  },
};

const agentTeam: SourceDescriptor<AgentTeam> = {
  sourceType: 'agent_team',
  table: 'agent_teams',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    // Manager-by-reference: when the team delegates to an existing agent
    // (`manager.agent_id`), that agent is a real dependency -- without this
    // edge the agent could be deleted out from under the team, leaving a
    // dangling manager reference.
    const managerAgentId = row.manager?.agent_id;
    if (typeof managerAgentId === 'string' && managerAgentId.trim()) {
      out.push({ targetType: 'agent', targetId: managerAgentId.trim(), relation: 'uses_manager_agent' });
    }
    const managerModelId = row.manager?.modelId;
    if (managerModelId) {
      out.push({ targetType: 'model', targetId: managerModelId, relation: 'uses_team_model' });
    }
    for (const id of cleanIds(row.sharedKnowledgeBaseIds)) {
      out.push({ targetType: 'knowledge_base', targetId: id, relation: 'shares_kb' });
    }
    for (const id of cleanIds(row.sharedDatasetIds)) {
      out.push({ targetType: 'dataset', targetId: id, relation: 'shares_dataset' });
    }
    const members = row.members as AgentTeamMember[] | undefined;
    if (Array.isArray(members)) {
      for (const m of members) {
        if (m.memberId) {
          const targetType: EntityKind = m.memberType === 'team' ? 'agent_team' : 'agent';
          out.push({ targetType, targetId: m.memberId, relation: 'has_member' });
        }
      }
    }
    return out;
  },
};

const model: SourceDescriptor<Model> = {
  sourceType: 'model',
  table: 'models',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    if (row.credentialId) {
      out.push({ targetType: 'credential', targetId: row.credentialId, relation: 'uses_credential' });
    }
    return out;
  },
};

const mcpServer: SourceDescriptor<MCPServer> = {
  sourceType: 'mcp_server',
  table: 'mcp_servers',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    if (row.credentialId) {
      out.push({ targetType: 'credential', targetId: row.credentialId, relation: 'uses_credential' });
    }
    if (row.runtimeCredentialId && row.runtimeCredentialId !== row.credentialId) {
      out.push({ targetType: 'credential', targetId: row.runtimeCredentialId, relation: 'uses_credential' });
    }
    return out;
  },
};

/**
 * Extract entity references embedded in a pipeline graph node's
 * `config.params`. The shape of `params` mirrors a block's `subBlocks`
 * ids in [`src/nemo/gui/src/blocks/blocks/`]; field names are stable
 * because they're stored verbatim in the database.
 *
 * Cross-project safety: the agent and (future) workflow blocks expose a
 * `projectId` selector, so a pipeline in project A could nominally point
 * at an agent in project B. The reference-edge schema is project-scoped,
 * so we only emit an edge when the target lives in the *same* project as
 * the source pipeline. Cross-project references are silently ignored —
 * they're tracked elsewhere (deployments, tenancy) and don't participate
 * in the in-project "Used by" surface.
 */
const extractPipelineGraphEdges = (row: Pipeline): EdgeOut[] => {
  const out: EdgeOut[] = [];
  const nodes = row.graph?.nodes;
  if (!Array.isArray(nodes)) return out;

  const ownerProjectId = row.projectId;
  for (const node of nodes) {
    const type = node?.type;
    const config = (node?.config ?? {}) as Record<string, unknown>;
    // Pipelines saved by the editor wrap user-editable fields in
    // `config.params`; older graphs may store them flat. Prefer params,
    // fall back to top-level so backfills work on legacy rows.
    const params = ((config.params ?? config) as Record<string, unknown>) ?? {};

    const refProjectId =
      typeof params.projectId === 'string' ? params.projectId.trim() : '';
    if (refProjectId && refProjectId !== ownerProjectId) continue;

    switch (type) {
      case 'agent': {
        const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
        if (agentId) {
          out.push({ targetType: 'agent', targetId: agentId, relation: 'graph_ref' });
        }
        break;
      }
      case 'knowledge':
      case 'publish_to_kb': {
        const kbId =
          typeof params.knowledgeBaseId === 'string' ? params.knowledgeBaseId.trim() : '';
        if (kbId) {
          out.push({ targetType: 'knowledge_base', targetId: kbId, relation: 'graph_ref' });
        }
        break;
      }
      case 'mcp': {
        const serverId = typeof params.server === 'string' ? params.server.trim() : '';
        if (serverId) {
          out.push({ targetType: 'mcp_server', targetId: serverId, relation: 'graph_ref' });
        }
        break;
      }
      case 'dataset_reader': {
        const datasetId =
          typeof params.dataset_id === 'string' ? params.dataset_id.trim() : '';
        if (datasetId) {
          out.push({ targetType: 'dataset', targetId: datasetId, relation: 'graph_ref' });
        }
        break;
      }
      case 'workflow': {
        const workflowId =
          typeof params.workflowId === 'string' ? params.workflowId.trim() : '';
        if (workflowId) {
          out.push({ targetType: 'pipeline', targetId: workflowId, relation: 'graph_ref' });
        }
        break;
      }
      default:
        // Unknown / non-referencing block type — no edges.
        break;
    }
  }
  return out;
};

const pipeline: SourceDescriptor<Pipeline> = {
  sourceType: 'pipeline',
  table: 'pipelines',
  idColumn: 'id',
  nameColumn: 'name',
  // Pipelines write edges synchronously via the wrapper (see
  // pipelineRoutes); the reconciler still walks them so newly-added block
  // types or graph-shape drift converge without code changes.
  syncOnly: false,
  extract: extractPipelineGraphEdges,
};

const PLACEHOLDER_SOURCE_DATASET = new Set(['', '__unset__', '__legacy_unknown__']);

const knowledgeBase: SourceDescriptor<KnowledgeBase> = {
  sourceType: 'knowledge_base',
  table: 'knowledge_bases',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    const raw = row.sourceDataset;
    const sid = typeof raw === 'string' ? raw.trim() : '';
    // KB stores the backing dataset id (same selector as dataset FK elsewhere).
    if (sid && !PLACEHOLDER_SOURCE_DATASET.has(sid)) {
      out.push({ targetType: 'dataset', targetId: sid, relation: 'uses_dataset' });
    }
    const embeddingModelId = row.embeddingModelId;
    if (typeof embeddingModelId === 'string' && embeddingModelId.trim()) {
      out.push({
        targetType: 'model',
        targetId: embeddingModelId.trim(),
        relation: 'uses_embedding_model',
      });
    }
    return out;
  },
};

const dataset: SourceDescriptor<DataSet> = {
  sourceType: 'dataset',
  table: 'data_sets',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    if (row.originConnector) {
      out.push({ targetType: 'data_source', targetId: row.originConnector, relation: 'uses_data_source' });
    }
    if (row.originVolume && row.originVolume !== row.originConnector) {
      out.push({ targetType: 'data_source', targetId: row.originVolume, relation: 'uses_data_source' });
    }
    return out;
  },
};

const dataSource: SourceDescriptor<DataSource> = {
  sourceType: 'data_source',
  table: 'data_sources',
  idColumn: 'id',
  nameColumn: 'name',
  projectColumn: 'project_id',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    // Routes pass DataSourceModel (snake_case credential_id); reconciler passes TypeORM rows (credentialId).
    const credentialId = row.credentialId ?? (row as { credential_id?: string }).credential_id;
    if (credentialId) {
      out.push({ targetType: 'credential', targetId: credentialId, relation: 'uses_credential' });
    }
    return out;
  },
};

const credential: SourceDescriptor<Credential> = {
  sourceType: 'credential',
  table: 'credentials',
  idColumn: 'id',
  nameColumn: 'name',
  syncOnly: true,
  extract: () => [],
};

const evaluation: SourceDescriptor<EvaluationTemplate> = {
  sourceType: 'evaluation',
  table: 'evaluation_templates',
  idColumn: 'templateId',
  nameColumn: 'evalName',
  syncOnly: true,
  extract: (row) => {
    const out: EdgeOut[] = [];
    const agentId = row.agent?.agentId;
    if (typeof agentId === 'string' && agentId.trim()) {
      out.push({ targetType: 'agent', targetId: agentId.trim(), relation: 'evaluates_agent' });
    }
    for (const id of cleanIds(row.evaluators?.aiJudge?.models)) {
      out.push({ targetType: 'model', targetId: id, relation: 'uses_judge_model' });
    }
    return out;
  },
};

const descriptors: ReadonlyArray<SourceDescriptor<any>> = [
  agent,
  agentTeam,
  model,
  mcpServer,
  pipeline,
  knowledgeBase,
  dataset,
  dataSource,
  credential,
  evaluation,
];

const byKind: ReadonlyMap<EntityKind, SourceDescriptor<any>> = new Map(
  descriptors.map((d) => [d.sourceType, d]),
);

export const referenceCatalog = {
  /** All declared descriptors (for reconciler iteration). */
  all(): ReadonlyArray<SourceDescriptor<any>> {
    return descriptors;
  },

  /**
   * Look up a descriptor by kind. Returns undefined for unknown kinds so
   * callers can decide whether to ignore (e.g. dependents request for an
   * entity not yet in the catalog) or throw.
   */
  get(kind: EntityKind): SourceDescriptor<any> | undefined {
    return byKind.get(kind);
  },

  /**
   * Return canonical, deduplicated edges for a row. Self-references are
   * filtered. The same (target, relation) pair appearing twice in input
   * arrays produces one edge.
   */
  extractEdges<Row>(
    sourceType: EntityKind,
    sourceId: string,
    row: Row,
  ): EdgeOut[] {
    const desc = byKind.get(sourceType);
    if (!desc) return [];
    const seen = new Set<string>();
    const out: EdgeOut[] = [];
    for (const edge of desc.extract(row as any)) {
      if (!edge.targetId) continue;
      if (edge.targetType === sourceType && edge.targetId === sourceId) continue;
      const key = `${edge.targetType}\u0000${edge.targetId}\u0000${edge.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(edge);
    }
    return out;
  },
};

export type { EntityKind, EdgeRelation } from '../models/ReferenceEdge';

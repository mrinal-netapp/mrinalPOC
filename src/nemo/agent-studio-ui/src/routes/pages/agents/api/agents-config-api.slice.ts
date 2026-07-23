/**
 * RTK Query endpoints for the Agent Config Service — injected into the shared
 * `apiSlice` so tags cross-invalidate correctly with the rest of the codebase.
 *
 * Source of truth: config-service OpenAPI spec
 *   `src/nemo/config-service/openapi.yaml` › /api/v1/projects/{projectId}/agents
 *
 * All URLs are absolute so that in production (where AGENTS_CONFIG_BASE_URL
 * differs from the default BASE_URL) `fetchBaseQuery` routes requests to the
 * correct service while still applying the shared auth / context headers.
 *
 * ── Resilience / future-proofing ────────────────────────────────────────────
 * To handle API changes with minimal code churn:
 *
 *  • Path changes  → update `AGENTS_API_VERSION` or the sub-path in `agentsBase`.
 *    Every endpoint derives its URL from that one function, so nothing else moves.
 *
 *  • Field renames → update `agents-config.types.ts` (API contract) and
 *    `agents-api-mapper.ts` (form ↔ API transformation). Components only read
 *    the mapper's output — they are insulated from raw wire format changes.
 *
 *  • New optional fields → RTK Query returns the raw response; components must
 *    use optional chaining (`?.`) when reading fields not guaranteed by the spec.
 *    Use `transformResponse` in the builder if normalization is needed before
 *    the data reaches the cache.
 *
 *  • Base URL changes → set `VITE_AGENTS_CONFIG_API_BASE_URL` in `.env.local`
 *    or `.env`; no code change required.
 */
import { apiSlice } from '@/api/api.slice';
import { AGENTS_CONFIG_BASE_URL } from '@/consts/api.consts';
import type {
  Agent,
  AgentTeam,
  AgentVersion,
  AgentTeamVersion,
  CreateAgentParams,
  CreateAgentTeamParams,
  DeleteAgentParams,
  DeleteAgentTeamParams,
  DependentsPage,
  GetAgentParams,
  GetAgentTeamParams,
  ListAgentDependentsParams,
  ListAgentTeamDependentsParams,
  ListAgentTeamsParams,
  ListAgentTeamVersionsParams,
  ListAgentVersionsParams,
  ListAgentsParams,
  ListMcpServersParams,
  ListMcpServerDependentsParams,
  ListKnowledgeBasesParams,
  ListProjectModelsParams,
  GetMcpServerToolsParams,
  GuardrailCatalogSummary,
  KnowledgeBaseSummary,
  McpServerSummary,
  McpServerTool,
  ProjectModelSummary,
  RestoreAgentResponse,
  RestoreAgentTeamResponse,
  RestoreAgentTeamVersionParams,
  RestoreAgentVersionParams,
  UpdateAgentParams,
  UpdateAgentStatusParams,
  UpdateAgentTeamParams,
  UpdateAgentTeamStatusParams,
} from './agents-config.types';

/** Bump this when the config-service API version changes (e.g. v1 → v2). */
const AGENTS_API_VERSION = 'v1';

function agentsBase(projectId: string): string {
  const base = AGENTS_CONFIG_BASE_URL.replace(/\/$/, '');
  return `${base}/api/${AGENTS_API_VERSION}/projects/${projectId}`;
}

function configBase(): string {
  const base = AGENTS_CONFIG_BASE_URL.replace(/\/$/, '');
  return `${base}/api/${AGENTS_API_VERSION}`;
}

const agentsConfigApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({

    // ── Guardrails catalog ────────────────────────────────────────────────────

    listGuardrailCatalog: builder.query<GuardrailCatalogSummary[], void>({
      query: () => `${configBase()}/guardrails`,
      providesTags: [{ type: 'Agent', id: 'GUARDRAILS_CATALOG' }],
    }),

    // ── Project models (model picker) ──────────────────────────────────────────

    /**
     * Lists the project's registered models for the agent form pickers.
     * Maps to `GET /api/v1/projects/{projectId}/models`. The picker stores the
     * returned `id` (a UUID) as the agent's `modelId`; sending a display name
     * like `gpt-4-turbo` is rejected by the server's UUID column.
     */
    listProjectModels: builder.query<ProjectModelSummary[], ListProjectModelsParams>({
      query: ({ projectId, modelType }) => ({
        url: `${agentsBase(projectId)}/models`,
        params: {
          ...(modelType ? { modelType } : {}),
          // The dependents lookup is irrelevant to the picker; skip it.
          include: 'dependentsSummary=false',
        },
      }),
      providesTags: (result) =>
        result
          ? [
            { type: 'Model', id: 'LIST' },
            ...result.map(({ id }) => ({ type: 'Model' as const, id })),
          ]
          : [{ type: 'Model', id: 'LIST' }],
    }),

    // ── Project MCP servers (toolset picker) ────────────────────────────────────

    /**
     * Lists the project's MCP servers for the agent form's toolset picker.
     * Maps to `GET /api/v1/projects/{projectId}/mcp-servers`. The picker stores
     * the returned `id` (a UUID) as an entry in the agent's `mcpServerIds`.
     */
    listMcpServers: builder.query<McpServerSummary[], ListMcpServersParams>({
      query: ({ projectId, include }) => ({
        url: `${agentsBase(projectId)}/mcp-servers`,
        params: {
          // The dependents lookup is irrelevant to the picker; skip it.
          include: include ?? 'dependentsSummary=false',
        },
      }),
      providesTags: (result) =>
        result
          ? [
            { type: 'Tool', id: 'LIST' },
            ...result.map(({ id }) => ({ type: 'Tool' as const, id })),
          ]
          : [{ type: 'Tool', id: 'LIST' }],
    }),

    /**
     * Lists the live tool catalog for one MCP server (name + description) via
     * `GET /api/v1/projects/{projectId}/mcp-servers/{id}/tools`. Used by the
     * toolset dialog once a toolset is selected, so users see real tools and
     * descriptions rather than just the `allowedTools` name allowlist.
     */
    listMcpServerTools: builder.query<McpServerTool[], GetMcpServerToolsParams>({
      query: ({ projectId, id }) => `${agentsBase(projectId)}/mcp-servers/${id}/tools`,
      providesTags: (_result, _error, { id }) => [{ type: 'Tool', id: `${id}-tools` }],
    }),

    listMcpServerDependents: builder.query<DependentsPage, ListMcpServerDependentsParams>({
      query: ({ projectId, id, limit, cursor, kind }) => ({
        url: `${agentsBase(projectId)}/mcp-servers/${id}/dependents`,
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(kind ? { kind } : {}),
        },
      }),
    }),

    // ── Project knowledge bases (KB picker) ─────────────────────────────────────

    /**
     * Lists the project's knowledge bases for the agent form's KB picker.
     * Maps to `GET /api/v1/projects/{projectId}/knowledgebases` (config-service),
     * which returns a bare array of camelCase `KnowledgeBase` rows. The picker
     * stores the returned `id` (a short `kb<8>` id) on the agent's
     * `knowledgeBaseIds`. A dedicated id namespace is used for the provided tag
     * so this read-only list isn't cross-invalidated by the standalone KB
     * management feature's data-platform slice.
     */
    listProjectKnowledgeBases: builder.query<KnowledgeBaseSummary[], ListKnowledgeBasesParams>({
      query: ({ projectId, include }) => ({
        url: `${agentsBase(projectId)}/knowledgebases`,
        params: {
          // The dependents lookup is irrelevant to the picker; skip it.
          include: include ?? 'dependentsSummary=false',
        },
      }),
      providesTags: (result) =>
        result
          ? [
            { type: 'KnowledgeBase', id: 'CONFIG_LIST' },
            ...result.map(({ id }) => ({ type: 'KnowledgeBase' as const, id })),
          ]
          : [{ type: 'KnowledgeBase', id: 'CONFIG_LIST' }],
    }),

    // ── Agents ────────────────────────────────────────────────────────────────

    listAgents: builder.query<Agent[], ListAgentsParams>({
      query: ({ projectId, limit, skip, field, value, nameRegex, include }) => ({
        url: `${agentsBase(projectId)}/agents`,
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(skip !== undefined ? { skip } : {}),
          ...(field ? { field } : {}),
          ...(value ? { value } : {}),
          ...(nameRegex ? { nameRegex } : {}),
          ...(include ? { include } : {}),
        },
      }),
      providesTags: (result) =>
        result
          ? [
            { type: 'Agent', id: 'LIST' },
            ...result.map(({ id }) => ({ type: 'Agent' as const, id })),
          ]
          : [{ type: 'Agent', id: 'LIST' }],
    }),

    getAgent: builder.query<Agent, GetAgentParams>({
      query: ({ projectId, id }) => `${agentsBase(projectId)}/agents/${id}`,
      providesTags: (_result, _error, { id }) => [{ type: 'AgentDetail', id }],
    }),

    createAgent: builder.mutation<Agent, CreateAgentParams>({
      query: ({ projectId, body }) => ({
        url: `${agentsBase(projectId)}/agents`,
        method: 'POST',
        body,
      }),
      invalidatesTags: [{ type: 'Agent', id: 'LIST' }],
    }),

    updateAgent: builder.mutation<Agent, UpdateAgentParams>({
      query: ({ projectId, id, body }) => ({
        url: `${agentsBase(projectId)}/agents/${id}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'Agent', id: 'LIST' },
        { type: 'Agent', id },
        { type: 'AgentDetail', id },
      ],
    }),

    deleteAgent: builder.mutation<void, DeleteAgentParams>({
      query: ({ projectId, id }) => ({
        url: `${agentsBase(projectId)}/agents/${id}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'Agent', id: 'LIST' },
        { type: 'Agent', id },
        { type: 'AgentDetail', id },
      ],
    }),

    /**
     * Transitions `status`, `statusMessage`, and/or `deploymentStatus` on the
     * agent without touching its configuration fields.
     * Uses the dedicated `/status` sub-resource — not the general PUT endpoint.
     */
    updateAgentStatus: builder.mutation<Agent, UpdateAgentStatusParams>({
      query: ({ projectId, id, body }) => ({
        url: `${agentsBase(projectId)}/agents/${id}/status`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, error, { id }) =>
        error
          ? []
          : [
              { type: 'Agent', id: 'LIST' },
              { type: 'Agent', id },
              { type: 'AgentDetail', id },
            ],
    }),

    // ── Agent history ─────────────────────────────────────────────────────────

    listAgentVersions: builder.query<AgentVersion[], ListAgentVersionsParams>({
      query: ({ projectId, id }) =>
        `${agentsBase(projectId)}/agents/${id}/history`,
    }),

    restoreAgentVersion: builder.mutation<RestoreAgentResponse, RestoreAgentVersionParams>({
      query: ({ projectId, id, version }) => ({
        url: `${agentsBase(projectId)}/agents/${id}/restore-version`,
        method: 'POST',
        body: { version },
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'Agent', id: 'LIST' },
        { type: 'Agent', id },
        { type: 'AgentDetail', id },
      ],
    }),

    // ── Agent dependents ──────────────────────────────────────────────────────

    listAgentDependents: builder.query<DependentsPage, ListAgentDependentsParams>({
      query: ({ projectId, id, limit, cursor, kind }) => ({
        url: `${agentsBase(projectId)}/agents/${id}/dependents`,
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(kind ? { kind } : {}),
        },
      }),
    }),

    // ── Agent Teams ───────────────────────────────────────────────────────────

    listAgentTeams: builder.query<AgentTeam[], ListAgentTeamsParams>({
      query: ({ projectId, limit, skip, nameRegex, include }) => ({
        url: `${agentsBase(projectId)}/agent-teams`,
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(skip !== undefined ? { skip } : {}),
          ...(nameRegex ? { nameRegex } : {}),
          ...(include ? { include } : {}),
        },
      }),
      providesTags: (result) =>
        result
          ? [
            { type: 'AgentTeam', id: 'LIST' },
            ...result.map(({ id }) => ({ type: 'AgentTeam' as const, id })),
          ]
          : [{ type: 'AgentTeam', id: 'LIST' }],
    }),

    getAgentTeam: builder.query<AgentTeam, GetAgentTeamParams>({
      query: ({ projectId, id }) =>
        `${agentsBase(projectId)}/agent-teams/${id}`,
      providesTags: (_result, _error, { id }) => [{ type: 'AgentTeamDetail', id }],
    }),

    createAgentTeam: builder.mutation<AgentTeam, CreateAgentTeamParams>({
      query: ({ projectId, body }) => ({
        url: `${agentsBase(projectId)}/agent-teams`,
        method: 'POST',
        body,
      }),
      invalidatesTags: [{ type: 'AgentTeam', id: 'LIST' }],
    }),

    updateAgentTeam: builder.mutation<AgentTeam, UpdateAgentTeamParams>({
      query: ({ projectId, id, body }) => ({
        url: `${agentsBase(projectId)}/agent-teams/${id}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'AgentTeam', id: 'LIST' },
        { type: 'AgentTeam', id },
        { type: 'AgentTeamDetail', id },
      ],
    }),

    deleteAgentTeam: builder.mutation<void, DeleteAgentTeamParams>({
      query: ({ projectId, id }) => ({
        url: `${agentsBase(projectId)}/agent-teams/${id}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'AgentTeam', id: 'LIST' },
        { type: 'AgentTeam', id },
        { type: 'AgentTeamDetail', id },
      ],
    }),

    /**
     * Transitions `status`, `statusMessage`, and/or `deploymentStatus` on the
     * team without touching its configuration fields.
     * Uses the dedicated `/status` sub-resource — not the general PUT endpoint.
     */
    updateAgentTeamStatus: builder.mutation<AgentTeam, UpdateAgentTeamStatusParams>({
      query: ({ projectId, id, body }) => ({
        url: `${agentsBase(projectId)}/agent-teams/${id}/status`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (_result, error, { id }) =>
        error
          ? []
          : [
              { type: 'AgentTeam', id: 'LIST' },
              { type: 'AgentTeam', id },
              { type: 'AgentTeamDetail', id },
            ],
    }),

    // ── Agent Team history ────────────────────────────────────────────────────

    listAgentTeamVersions: builder.query<AgentTeamVersion[], ListAgentTeamVersionsParams>({
      query: ({ projectId, id }) =>
        `${agentsBase(projectId)}/agent-teams/${id}/history`,
    }),

    restoreAgentTeamVersion: builder.mutation<RestoreAgentTeamResponse, RestoreAgentTeamVersionParams>({
      query: ({ projectId, id, version }) => ({
        url: `${agentsBase(projectId)}/agent-teams/${id}/restore-version`,
        method: 'POST',
        body: { version },
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'AgentTeam', id: 'LIST' },
        { type: 'AgentTeam', id },
        { type: 'AgentTeamDetail', id },
      ],
    }),

    // ── Agent Team dependents ─────────────────────────────────────────────────

    listAgentTeamDependents: builder.query<DependentsPage, ListAgentTeamDependentsParams>({
      query: ({ projectId, id, limit, cursor, kind }) => ({
        url: `${agentsBase(projectId)}/agent-teams/${id}/dependents`,
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(kind ? { kind } : {}),
        },
      }),
    }),
  }),
});

export { agentsConfigApi };

export const {
  useListGuardrailCatalogQuery,
  useListProjectModelsQuery,
  useListMcpServersQuery,
  useListMcpServerToolsQuery,
  useListMcpServerDependentsQuery,
  useListProjectKnowledgeBasesQuery,
  useListAgentsQuery,
  useGetAgentQuery,
  useCreateAgentMutation,
  useUpdateAgentMutation,
  useDeleteAgentMutation,
  useUpdateAgentStatusMutation,
  useListAgentVersionsQuery,
  useRestoreAgentVersionMutation,
  useListAgentDependentsQuery,
  useListAgentTeamsQuery,
  useGetAgentTeamQuery,
  useCreateAgentTeamMutation,
  useUpdateAgentTeamMutation,
  useDeleteAgentTeamMutation,
  useUpdateAgentTeamStatusMutation,
  useListAgentTeamVersionsQuery,
  useRestoreAgentTeamVersionMutation,
  useListAgentTeamDependentsQuery,
} = agentsConfigApi;

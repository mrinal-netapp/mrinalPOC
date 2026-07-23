/**
 * RTK Query endpoints for the Agent Runtime Service — injected into the shared
 * `apiSlice` so tags cross-invalidate correctly with the rest of the codebase.
 *
 * Source of truth: agent-service FastAPI (`src/nemo/agent-service/src/main.py`)
 * Runtime paths include the project id in the URL via `agentsRuntimePath()`.
 *
 * All URLs are absolute so that AGENT_RUNTIME_BASE_URL (which may differ
 * from BASE_URL) is always respected while still using the shared auth headers.
 */
import { apiSlice } from '@/api/api.slice';
import { AGENT_RUNTIME_BASE_URL } from '@/consts/api.consts';
import { agentsRuntimePath, appendQueryParams, type RuntimeQueryParams } from './agents-api.paths';
import type { RootState } from '@/store/store.types';
import type {
  AgentInvokeRequest,
  AgentInvokeResponse,
  AgentSessionDetailResponse,
  AgentSessionListResponse,
  AgentTraceSpan,
  AgentTraceSpansResponse,
} from './agents.types';

function runtimeUrl(suffix: string, getState: () => unknown): string {
  const projectId = (getState() as RootState).projectContext.activeProject.id;
  return `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, '')}${agentsRuntimePath(suffix, projectId)}`;
}

/**
 * Runtime resources live under `/agents/{id}` for single agents and
 * `/agent-teams/{id}` for teams. Callers pass `isTeam` (derived from the id
 * prefix) so sessions/traces hit the correct endpoint.
 */
function runtimeResourceBase(id: string, isTeam: boolean): string {
  return isTeam ? `/agent-teams/${id}` : `/agents/${id}`;
}

const agentsRuntimeApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    listAgentSessions: builder.query<
      AgentSessionListResponse,
      { id: string; isTeam: boolean }
    >({
      async queryFn({ id, isTeam }, api, _extraOptions, baseQuery) {
        const result = await baseQuery(
          runtimeUrl(`${runtimeResourceBase(id, isTeam)}/sessions`, api.getState),
        );
        if (result.error) return { error: result.error };
        return { data: result.data as AgentSessionListResponse };
      },
      providesTags: (_result, _error, { id }) => [
        { type: 'AgentSession', id: `LIST-${id}` },
      ],
    }),

    getAgentSession: builder.query<
      AgentSessionDetailResponse,
      { id: string; sessionId: string; isTeam: boolean }
    >({
      async queryFn({ id, sessionId, isTeam }, api, _extraOptions, baseQuery) {
        const result = await baseQuery(
          runtimeUrl(`${runtimeResourceBase(id, isTeam)}/sessions/${sessionId}`, api.getState),
        );
        if (result.error) return { error: result.error };
        return { data: result.data as AgentSessionDetailResponse };
      },
      providesTags: (_result, _error, { sessionId }) => [
        { type: 'AgentSession', id: sessionId },
      ],
    }),

    invokeAgent: builder.mutation<
      AgentInvokeResponse,
      { agentId: string; body: AgentInvokeRequest; queryParams?: RuntimeQueryParams }
    >({
      async queryFn({ agentId, body, queryParams }, api, _extraOptions, baseQuery) {
        const result = await baseQuery({
          url: appendQueryParams(
            runtimeUrl(`/agents/${agentId}/invoke`, api.getState),
            queryParams,
          ),
          method: 'POST',
          body,
        });
        if (result.error) return { error: result.error };
        return { data: result.data as AgentInvokeResponse };
      },
      // Declare every cache this mutation makes stale: the session LIST and,
      // once we know the (possibly new) session id from the response, that
      // session's detail cache. Keeping this on the mutation means callers
      // never hand-invalidate after invoking — see state-management guide §3.6.
      invalidatesTags: (result, _error, { agentId }) => [
        { type: 'AgentSession', id: `LIST-${agentId}` },
        ...(result?.sessionId
          ? [{ type: 'AgentSession' as const, id: result.sessionId }]
          : []),
      ],
    }),

    getTraceSpans: builder.query<AgentTraceSpan[], string>({
      async queryFn(traceId, api, _extraOptions, baseQuery) {
        const result = await baseQuery(runtimeUrl(`/traces/${traceId}/spans`, api.getState));
        if (result.error) return { error: result.error };
        const response = result.data as AgentTraceSpansResponse | AgentTraceSpan[];
        return { data: Array.isArray(response) ? response : (response.data ?? []) };
      },
    }),
  }),
});

export function invalidateAgentSessionsCache(
  dispatch: (action: ReturnType<typeof agentsRuntimeApi.util.invalidateTags>) => void,
  agentId: string,
  sessionId?: string,
): void {
  dispatch(
    agentsRuntimeApi.util.invalidateTags([
      { type: 'AgentSession', id: `LIST-${agentId}` },
      ...(sessionId ? [{ type: 'AgentSession' as const, id: sessionId }] : []),
    ]),
  );
}

export { agentsRuntimeApi };

export const {
  useListAgentSessionsQuery,
  useGetAgentSessionQuery,
  useInvokeAgentMutation,
  useLazyGetAgentSessionQuery,
  useGetTraceSpansQuery,
} = agentsRuntimeApi;

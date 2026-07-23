import { apiSlice } from '@/api/api.slice';
import type { PaginatedResponse } from '@/api/api.types';
import type {
  AuditEvent,
  CaseValidationResponse,
  EvalListItem,
  EvalListParams,
  EvalTemplateCreateRequest,
  EvalTemplateUpdateRequest,
  EvaluationRun,
  EvaluationTemplate,
  RunOptions,
  TestCase,
} from './eval.types';

// ---------------------------------------------------------------------------
// URL helpers
//
// The eval backend routes are project-scoped (mirrors the KB slice pattern):
//   /projects/{projectId}/evaluation/agents/templates
//   /projects/{projectId}/evaluation/agents/runs
//
// projectId is threaded from the active project context at each call site.
// ---------------------------------------------------------------------------

type ProjectScopedArgs = {
  projectId: string;
};

function evalBase(projectId: string): string {
  return `/projects/${projectId}/evaluation/agents`;
}

function templatesBase(projectId: string): string {
  return `${evalBase(projectId)}/templates`;
}

function runsBase(projectId: string): string {
  return `${evalBase(projectId)}/runs`;
}

/** Normalizes plain-array responses today while preserving backend pagination if added later. */
function paginate<T>(raw: T[] | PaginatedResponse<T> | null | undefined): PaginatedResponse<T> {
  if (raw && !Array.isArray(raw) && Array.isArray(raw.data) && raw.pagination) {
    return raw;
  }

  const items = Array.isArray(raw) ? raw : [];
  return {
    data: items ?? [],
    pagination: { limit: (items ?? []).length, offset: 0, total_count: (items ?? []).length },
  };
}

const evalApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    // ── Templates ────────────────────────────────────────────

    listEvaluations: builder.query<PaginatedResponse<EvalListItem>, ProjectScopedArgs & Partial<EvalListParams>>({
      query: ({ projectId, ...params }) => ({
        url: templatesBase(projectId),
        params: Object.keys(params).length ? params : undefined,
      }),
      // Backend returns EvaluationTemplateListItem[] today; keep paginated responses intact if added later.
      transformResponse: (raw: EvalListItem[] | PaginatedResponse<EvalListItem>) => paginate(raw),
      providesTags: (result) =>
        result
          ? [
              { type: 'EvalTemplate', id: 'LIST' },
              ...result.data.map(({ templateId }) => ({
                type: 'EvalTemplate' as const,
                id: templateId,
              })),
            ]
          : [{ type: 'EvalTemplate', id: 'LIST' }],
    }),

    getEvaluation: builder.query<EvaluationTemplate, ProjectScopedArgs & { templateId: string }>({
      query: ({ projectId, templateId }) => `${templatesBase(projectId)}/${templateId}`,
      providesTags: (_result, _error, { templateId }) => [
        { type: 'EvalTemplate', id: templateId },
      ],
    }),

    createEvaluation: builder.mutation<EvaluationTemplate, ProjectScopedArgs & { body: EvalTemplateCreateRequest }>({
      query: ({ projectId, body }) => ({
        url: templatesBase(projectId),
        method: 'POST',
        body,
      }),
      invalidatesTags: [{ type: 'EvalTemplate', id: 'LIST' }],
    }),

    updateEvaluation: builder.mutation<EvaluationTemplate, ProjectScopedArgs & { templateId: string; body: EvalTemplateUpdateRequest }>({
      query: ({ projectId, templateId, body }) => ({
        url: `${templatesBase(projectId)}/${templateId}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: (_result, _error, { templateId }) => [
        { type: 'EvalTemplate', id: 'LIST' },
        { type: 'EvalTemplate', id: templateId },
      ],
    }),

    deleteEvaluation: builder.mutation<void, ProjectScopedArgs & { templateId: string; hard?: boolean }>({
      query: ({ projectId, templateId, hard }) => ({
        url: `${templatesBase(projectId)}/${templateId}`,
        method: 'DELETE',
        params: hard ? { hard: true } : undefined,
      }),
      invalidatesTags: (_result, _error, { templateId }) => [
        { type: 'EvalTemplate', id: 'LIST' },
        { type: 'EvalTemplate', id: templateId },
      ],
    }),

    // ── Test Cases ───────────────────────────────────────────

    listTestCases: builder.query<TestCase[], ProjectScopedArgs & { templateId: string; category?: string }>({
      query: ({ projectId, templateId, ...params }) => ({
        url: `${templatesBase(projectId)}/${templateId}/cases`,
        params,
      }),
      providesTags: (_result, _error, { templateId }) => [
        { type: 'TestCase', id: `LIST-${templateId}` },
      ],
    }),

    bulkAddTestCases: builder.mutation<TestCase[], ProjectScopedArgs & { templateId: string; cases: Partial<TestCase>[]; replace?: boolean }>({
      query: ({ projectId, templateId, cases, replace }) => ({
        url: `${templatesBase(projectId)}/${templateId}/cases`,
        method: 'POST',
        body: { cases },
        params: replace ? { replace: true } : undefined,
      }),
      invalidatesTags: (_result, _error, { templateId }) => [
        { type: 'TestCase', id: `LIST-${templateId}` },
        { type: 'EvalTemplate', id: templateId },
      ],
    }),

    validateTestCases: builder.mutation<CaseValidationResponse, ProjectScopedArgs & { templateId: string; cases: Partial<TestCase>[] }>({
      query: ({ projectId, templateId, cases }) => ({
        url: `${templatesBase(projectId)}/${templateId}/cases/validate`,
        method: 'POST',
        body: { cases },
      }),
    }),

    // ── Runs ─────────────────────────────────────────────────

    triggerRun: builder.mutation<{ runId: string; workflowId: string; status: string }, ProjectScopedArgs & { templateId: string; options: RunOptions }>({
      query: ({ projectId, templateId, options }) => ({
        url: `${templatesBase(projectId)}/${templateId}/runs`,
        method: 'POST',
        body: options,
      }),
      invalidatesTags: [{ type: 'EvalRun', id: 'LIST' }],
    }),

    listRuns: builder.query<PaginatedResponse<EvaluationRun>, ProjectScopedArgs & { templateId?: string; status?: string }>({
      query: ({ projectId, ...params }) => ({
        url: runsBase(projectId),
        params: Object.keys(params).length ? params : undefined,
      }),
      // Backend returns EvaluationRun[] today; keep paginated responses intact if added later.
      transformResponse: (raw: EvaluationRun[] | PaginatedResponse<EvaluationRun>) => paginate(raw),
      providesTags: (result) =>
        result
          ? [
              { type: 'EvalRun', id: 'LIST' },
              ...result.data.map(({ runId }) => ({
                type: 'EvalRun' as const,
                id: runId,
              })),
            ]
          : [{ type: 'EvalRun', id: 'LIST' }],
    }),

    getRun: builder.query<EvaluationRun, ProjectScopedArgs & { runId: string }>({
      query: ({ projectId, runId }) => `${runsBase(projectId)}/${runId}`,
      providesTags: (_result, _error, { runId }) => [
        { type: 'EvalRun', id: runId },
      ],
    }),

    cancelRun: builder.mutation<void, ProjectScopedArgs & { runId: string }>({
      query: ({ projectId, runId }) => ({
        url: `${runsBase(projectId)}/${runId}/cancel`,
        method: 'POST',
      }),
      invalidatesTags: (_result, _error, { runId }) => [
        { type: 'EvalRun', id: 'LIST' },
        { type: 'EvalRun', id: runId },
      ],
    }),

    setBaseline: builder.mutation<EvaluationRun, ProjectScopedArgs & { runId: string }>({
      query: ({ projectId, runId }) => ({
        url: `${runsBase(projectId)}/${runId}/baseline`,
        method: 'POST',
      }),
      invalidatesTags: (_result, _error, { runId }) => [
        { type: 'EvalRun', id: 'LIST' },
        { type: 'EvalRun', id: runId },
      ],
    }),

    // ── Audit ────────────────────────────────────────────────

    listAuditEvents: builder.query<AuditEvent[], ProjectScopedArgs & { runId: string }>({
      query: ({ projectId, runId }) => `${runsBase(projectId)}/${runId}/audit-events`,
    }),
  }),
});

export { evalApi };

export const {
  useListEvaluationsQuery,
  useGetEvaluationQuery,
  useCreateEvaluationMutation,
  useUpdateEvaluationMutation,
  useDeleteEvaluationMutation,
  useListTestCasesQuery,
  useBulkAddTestCasesMutation,
  useValidateTestCasesMutation,
  useTriggerRunMutation,
  useListRunsQuery,
  useGetRunQuery,
  useCancelRunMutation,
  useSetBaselineMutation,
  useListAuditEventsQuery,
} = evalApi;

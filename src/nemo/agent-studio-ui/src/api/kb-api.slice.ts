import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react';

import { KB_RETRIEVAL_BASE_URL } from '@/consts/api.consts';
import { apiSlice, createBaseQueryWithReauth } from './api.slice';
import { kbSearchResultsToAgentChunks } from './kb-search.adapter';
import type { AgentChunk } from './agent.types';
import type { NameValidateRequest, NameValidateResponse, PaginatedResponse } from './api.types';
import type { KbSearchRequest, KbSearchResponse } from './kb-search.types';
import type { BackendDataSet, BackendKB, BackendKBMutationResponse } from './kb-mappers';
import {
  toBackendCreateBody,
  toBackendUpdateBody,
  toKBAssignedDatasetResponse,
  toKBDetail,
  toKBListItem,
  toKBMutationResult,
} from './kb-mappers';
import type {
  KBAssignedDatasetResponse,
  KBCreateRequest,
  KBDetail,
  KBListItem,
  KBListParams,
  KBListSnapshotsParams,
  KBSnapshot,
  KBSnapshotCreateRequest,
  KBSnapshotDetail,
  KBSnapshotUpdateRequest,
  KBManualSyncResponse,
  KBMutationResult,
  KBUpdateRequest,
} from './kb.types';

export interface KbSearchMutationArgs extends KbSearchRequest {
  projectId: string;
  kbId: string;
}

const kbRetrievalBaseQuery = createBaseQueryWithReauth(
  KB_RETRIEVAL_BASE_URL,
) as BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError>;

function urlBase(projectId: string): string {
  return `/projects/${projectId}/knowledgebases`;
}

const kbApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    listKnowledgeBases: builder.query<
      PaginatedResponse<KBListItem>,
      { projectId: string } & Partial<KBListParams>
    >({
      query: ({ projectId, ...params }) => ({
        url: urlBase(projectId),
        params: Object.keys(params).length ? params : undefined,
      }),
      transformResponse: (raw: BackendKB[]): PaginatedResponse<KBListItem> => {
        const data = (raw ?? []).map(toKBListItem);
        return {
          data,
          // Backend doesn't paginate yet — surface a single-page result.
          pagination: {
            limit: data.length,
            offset: 0,
            total_count: data.length,
          },
        };
      },
      providesTags: (result) =>
        result
          ? [
            { type: 'KnowledgeBase', id: 'LIST' },
            ...result.data.map(({ kb_id }) => ({
              type: 'KnowledgeBase' as const,
              id: kb_id,
            })),
          ]
          : [{ type: 'KnowledgeBase', id: 'LIST' }],
    }),

    getKnowledgeBase: builder.query<KBDetail, { projectId: string; kbId: string }>({
      query: ({ projectId, kbId }) => `${urlBase(projectId)}/${kbId}`,
      transformResponse: (raw: BackendKB) => toKBDetail(raw),
      providesTags: (_result, _error, { kbId }) => [
        { type: 'KBDetail', id: kbId },
      ],
    }),

    getKBAssignedDataset: builder.query<
      KBAssignedDatasetResponse,
      { projectId: string; kbId: string }
    >({
      async queryFn({ projectId, kbId }, _api, _extraOptions, baseQuery) {
        const kbRes = await baseQuery(`${urlBase(projectId)}/${kbId}`);
        if (kbRes.error) return { error: kbRes.error };
        const kb = kbRes.data as BackendKB;

        if (!kb.sourceDataset) {
          return { data: toKBAssignedDatasetResponse(kbId, undefined) };
        }

        const dsRes = await baseQuery(
          `/projects/${projectId}/datasets/${kb.sourceDataset}`,
        );
        if (dsRes.error) return { error: dsRes.error };
        const dataset = dsRes.data as BackendDataSet;

        return { data: toKBAssignedDatasetResponse(kbId, dataset) };
      },
      providesTags: (_result, _error, { kbId }) => [
        { type: 'KBDetail', id: kbId },
      ],
    }),

    listKBSnapshots: builder.query<PaginatedResponse<KBSnapshot>, KBListSnapshotsParams>({
      // No project scoping — backend route is /knowledge-bases/:kbId/snapshots.
      query: ({ kbId, status, includeExpired, limit, offset }) => ({
        url: `/knowledge-bases/${kbId}/snapshots`,
        params: {
          ...(status !== undefined ? { status } : {}),
          ...(includeExpired !== undefined ? { include_expired: includeExpired } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        },
      }),
      providesTags: (_result, _error, { kbId }) => [
        { type: 'KBSnapshots', id: kbId },
      ],
    }),

    validateKBName: builder.mutation<NameValidateResponse, NameValidateRequest>({
      queryFn: ({ name }) => ({ data: { name, available: true } }),
    }),

    createKnowledgeBase: builder.mutation<
      KBMutationResult,
      { projectId: string; body: KBCreateRequest }
    >({
      query: ({ projectId, body }) => ({
        url: urlBase(projectId),
        method: 'POST',
        body: toBackendCreateBody(body),
      }),
      transformResponse: (raw: BackendKBMutationResponse) => toKBMutationResult(raw),
      invalidatesTags: () => [{ type: 'KnowledgeBase', id: 'LIST' }],
    }),

    updateKnowledgeBase: builder.mutation<
      KBMutationResult,
      { projectId: string; kbId: string; body: KBUpdateRequest }
    >({
      query: ({ projectId, kbId, body }) => ({
        url: `${urlBase(projectId)}/${kbId}`,
        method: 'PUT',
        body: toBackendUpdateBody(body),
      }),
      transformResponse: (raw: BackendKBMutationResponse) => toKBMutationResult(raw),
      invalidatesTags: (_result, _error, { kbId }) => [
        { type: 'KnowledgeBase', id: 'LIST' },
        { type: 'KnowledgeBase', id: kbId },
        { type: 'KBDetail', id: kbId },
      ],
    }),

    deleteKnowledgeBase: builder.mutation<void, { projectId: string; kbId: string }>({
      query: ({ projectId, kbId }) => ({
        url: `${urlBase(projectId)}/${kbId}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { kbId }) => [
        { type: 'KnowledgeBase', id: 'LIST' },
        { type: 'KBDetail', id: kbId },
      ],
    }),

    createKBSnapshot: builder.mutation<
      KBSnapshotDetail,
      { kbId: string; body?: KBSnapshotCreateRequest }
    >({
      // No project scoping — backend route is /knowledge-bases/:kbId/snapshots.
      query: ({ kbId, body }) => ({
        url: `/knowledge-bases/${kbId}/snapshots`,
        method: 'POST',
        body: body ?? {},
      }),
      invalidatesTags: (_result, _error, { kbId }) => [
        { type: 'KBSnapshots', id: kbId },
        { type: 'KBDetail', id: kbId },
      ],
    }),

    updateKBSnapshot: builder.mutation<
      KBSnapshotDetail,
      { kbId: string; snapshotId: string; body: KBSnapshotUpdateRequest }
    >({
      query: ({ kbId, snapshotId, body }) => ({
        url: `/knowledge-bases/${kbId}/snapshots/${snapshotId}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: (_result, _error, { kbId }) => [
        { type: 'KBSnapshots', id: kbId },
        { type: 'KBDetail', id: kbId },
      ],
    }),

    manualSyncKB: builder.mutation<
      KBManualSyncResponse,
      { projectId: string; kbId: string }
    >({
      query: ({ projectId, kbId }) => ({
        url: `${urlBase(projectId)}/${kbId}/create`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: (_result, _error, { kbId }) => [
        { type: 'KnowledgeBase', id: 'LIST' },
        { type: 'KnowledgeBase', id: kbId },
        { type: 'KBDetail', id: kbId },
        { type: 'KBSnapshots', id: kbId },
      ],
    }),

    searchKnowledgeBase: builder.mutation<AgentChunk[], KbSearchMutationArgs>({
      queryFn: async (
        { projectId, kbId, query, topK = 10, minScore, searchMode = 'hybrid', distanceMetric, rerankerType },
        api,
        extraOptions,
      ) => {
        const result = await kbRetrievalBaseQuery(
          {
            url: `/projects/${projectId}/knowledgebases/${kbId}/search`,
            method: 'POST',
            body: {
              query,
              topK,
              ...(minScore != null ? { minScore } : {}),
              searchMode,
              ...(distanceMetric ? { distanceMetric } : {}),
              ...(rerankerType ? { rerankerType } : {}),
            },
          },
          api,
          extraOptions,
        );
        if (result.error) {
          return { error: result.error };
        }
        return {
          data: kbSearchResultsToAgentChunks(
            (result.data as KbSearchResponse).results ?? [],
          ),
        };
      },
    }),
  }),
});

// ── Project-context-aware public hooks (only for project-scoped endpoints) ─

// Endpoints that need a project segment now require `projectId` in args.
// Snapshot endpoints are not project-scoped at the backend.
// manualSync uses POST /projects/{projectId}/knowledgebases/{id}/create.
// Search uses kb-retrieval-service at /kb/api/v1/projects/{projectId}/knowledgebases/{kbId}/search.

export { kbApi };
export const {
  useListKnowledgeBasesQuery,
  useGetKnowledgeBaseQuery,
  useLazyGetKnowledgeBaseQuery,
  useGetKBAssignedDatasetQuery,
  useListKBSnapshotsQuery,
  useValidateKBNameMutation,
  useCreateKnowledgeBaseMutation,
  useUpdateKnowledgeBaseMutation,
  useDeleteKnowledgeBaseMutation,
  useCreateKBSnapshotMutation,
  useUpdateKBSnapshotMutation,
  useManualSyncKBMutation,
  useSearchKnowledgeBaseMutation,
} = kbApi;

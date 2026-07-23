import { apiSlice } from "@/api/api.slice";
import type {
  Credential,
  CredentialCreateRequest,
  CredentialListParams,
  CredentialRotateRequest,
  CredentialUpdateRequest,
  CredentialValidateResponse,
} from "./credential.types";

function urlBase(projectId: string): string {
  return `/projects/${projectId}/credentials`;
}

const credentialApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    // -- Queries --

    listCredentials: builder.query<
      Credential[],
      { projectId: string } & Partial<CredentialListParams>
    >({
      query: ({ projectId, ...params }) => ({
        url: urlBase(projectId),
        params: Object.keys(params).length ? params : undefined,
      }),
      providesTags: (result) =>
        result
          ? [
            { type: "Credential", id: "LIST" },
            ...result.map(({ id }) => ({ type: "Credential" as const, id })),
          ]
          : [{ type: "Credential", id: "LIST" }],
      transformResponse: (response: Credential[] | { data: Credential[] }) =>
        Array.isArray(response) ? response : (response.data ?? []),
    }),

    getCredential: builder.query<Credential, { projectId: string; id: string }>({
      query: ({ projectId, id }) => `${urlBase(projectId)}/${id}`,
      providesTags: (_result, _error, { id }) => [{ type: "CredentialDetail", id }],
    }),

    // -- Mutations --

    createCredential: builder.mutation<
      Credential,
      { projectId: string; body: CredentialCreateRequest }
    >({
      query: ({ projectId, body }) => ({
        url: urlBase(projectId),
        method: "POST",
        body,
      }),
      invalidatesTags: [{ type: "Credential", id: "LIST" }],
    }),

    updateCredential: builder.mutation<
      Credential,
      { projectId: string; id: string; body: CredentialUpdateRequest }
    >({
      query: ({ projectId, id, body }) => ({
        url: `${urlBase(projectId)}/${id}`,
        method: "PATCH",
        body,
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Credential", id: "LIST" },
        { type: "CredentialDetail", id },
      ],
    }),

    deleteCredential: builder.mutation<void, { projectId: string; id: string }>({
      query: ({ projectId, id }) => ({
        url: `${urlBase(projectId)}/${id}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Credential", id: "LIST" },
        { type: "CredentialDetail", id },
      ],
    }),

    validateCredential: builder.mutation<
      CredentialValidateResponse,
      { projectId: string; id: string }
    >({
      query: ({ projectId, id }) => ({
        url: `${urlBase(projectId)}/${id}/validate`,
        method: "POST",
      }),
    }),

    // Dry-run: validate raw credentials against the live provider WITHOUT
    // persisting. Backs the "validate before save" flow so a bad/unreachable
    // credential is never stored. No tag invalidation — nothing changes.
    validateCredentialDraft: builder.mutation<
      CredentialValidateResponse,
      {
        projectId: string;
        provider: string;
        secretData: Record<string, string>;
        metadata?: Record<string, string>;
      }
    >({
      query: ({ projectId, provider, secretData, metadata }) => ({
        url: `${urlBase(projectId)}/validate`,
        method: "POST",
        body: { provider, secretData, ...(metadata ? { metadata } : {}) },
      }),
    }),

    rotateCredential: builder.mutation<
      Credential,
      { projectId: string; id: string; body: CredentialRotateRequest }
    >({
      query: ({ projectId, id, body }) => ({
        url: `${urlBase(projectId)}/${id}/rotate`,
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Credential", id: "LIST" },
        { type: "CredentialDetail", id },
      ],
    }),
  }),
});

// Endpoints now require `projectId` in args. Call sites read activeProjectId
// from the project-context slice and pass it explicitly.

export { credentialApi };
export const {
  useListCredentialsQuery,
  useGetCredentialQuery,
  useCreateCredentialMutation,
  useUpdateCredentialMutation,
  useDeleteCredentialMutation,
  useValidateCredentialMutation,
  useValidateCredentialDraftMutation,
  useRotateCredentialMutation,
} = credentialApi;

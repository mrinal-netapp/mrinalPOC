import { apiSlice, createBaseQueryWithReauth } from "@/api/api.slice"
import { PROJECTS_BASE_URL } from "@/consts/api.consts"

type ValidateManagedMcpConfigParams = {
  projectId: string
  body: Record<string, unknown>
}

type ValidateManagedMcpConfigResponse = {
  success: boolean
  message?: string
  status?: "connected" | "error"
}

type ValidateMcpConnectionParams = {
  projectId: string
  body: Record<string, unknown>
}

type CreateMcpServerParams = {
  projectId: string
  body: Record<string, unknown>
}

type GetMcpServerParams = {
  projectId: string
  id: string
}

type UpdateMcpServerParams = {
  projectId: string
  id: string
  body: Record<string, unknown>
}

/** Full MCP server record returned by GET /mcp-servers/:id (config-service entity). */
export type McpServerRecord = {
  id: string
  name: string
  description?: string | null
  labels?: string[] | null
  url?: string | null
  transport?: string | null
  authType?: string | null
  deploymentType?: string | null
  staticHeaders?: Record<string, string> | null
  extraHeaders?: string[] | null
  allowedTools?: string[] | null
  disallowedTools?: string[] | null
}

type RefreshMcpServersParams = {
  projectId: string
}

type ValidateMcpConnectionResponse = {
  success: boolean
  message?: string
  status?: "connected" | "error"
}

type RefreshMcpServersResponse = {
  success: boolean
  refreshed: number
  failed: number
  /** Total servers in the project. Older backends omit this. */
  total?: number
  /** Servers not yet synced to the gateway (e.g. managed pods still provisioning). */
  pending?: number
}

/**
 * Builds a human-readable summary of an MCP refresh result and the toast tone
 * to use. Shared by the toolset list and detail pages so messaging stays
 * consistent and is meaningful even when no server is connected (e.g. a managed
 * MCP whose runtime failed or is still provisioning).
 */
export function summarizeMcpRefresh(
  result: RefreshMcpServersResponse,
): { message: string; tone: "success" | "info" } {
  const total = result.total ?? result.refreshed + result.failed + (result.pending ?? 0)

  if (total === 0) {
    return { message: "No tools to refresh yet.", tone: "info" }
  }

  const parts = [`${result.refreshed} healthy`]
  if (result.failed > 0) parts.push(`${result.failed} unhealthy`)
  if (result.pending && result.pending > 0) parts.push(`${result.pending} still provisioning`)

  const message = `Health refreshed: ${parts.join(", ")} of ${total} tool${total === 1 ? "" : "s"}.`
  return { message, tone: result.refreshed > 0 ? "success" : "info" }
}

type DeleteMcpServerParams = {
  projectId: string
  id: string
}

type DeleteMcpServerResponse = {
  deleted: boolean
}

/** Map config-service DELETE /mcp-servers/:id errors to user-facing copy. */
export function formatMcpServerDeleteError(err: unknown): string {
  const data = (err as { data?: { error?: string; code?: string } } | undefined)?.data
  if (data?.code === "HAS_DEPENDENTS") {
    return "This tool is still assigned to one or more agents. Remove those assignments, then try again."
  }
  if (typeof data?.error === "string" && data.error.length > 0) {
    return data.error
  }
  return "Couldn't delete this tool. Please try again."
}

const projectsBaseQuery = createBaseQueryWithReauth(PROJECTS_BASE_URL)

const toolsetApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    createMcpServer: builder.mutation<Record<string, unknown>, CreateMcpServerParams>({
      queryFn: async ({ projectId, body }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers`,
            method: "POST",
            body,
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: result.data as Record<string, unknown> }
      },
      invalidatesTags: [{ type: "Tool", id: "LIST" }],
    }),
    getMcpServer: builder.query<McpServerRecord, GetMcpServerParams>({
      queryFn: async ({ projectId, id }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers/${id}`,
            method: "GET",
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: result.data as McpServerRecord }
      },
      providesTags: (_result, _error, { id }) => [{ type: "Tool", id }],
    }),
    updateMcpServer: builder.mutation<McpServerRecord, UpdateMcpServerParams>({
      queryFn: async ({ projectId, id, body }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers/${id}`,
            method: "PUT",
            body,
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: result.data as McpServerRecord }
      },
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Tool", id: "LIST" },
        { type: "Tool", id },
      ],
    }),
    refreshMcpServers: builder.mutation<RefreshMcpServersResponse, RefreshMcpServersParams>({
      queryFn: async ({ projectId }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers/refresh`,
            method: "POST",
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: result.data as RefreshMcpServersResponse }
      },
      invalidatesTags: [{ type: "Tool", id: "LIST" }],
    }),
    validateManagedMcpConfig: builder.mutation<ValidateManagedMcpConfigResponse, ValidateManagedMcpConfigParams>({
      queryFn: async ({ projectId, body }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers/validate-managed-config`,
            method: "POST",
            body,
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: result.data as ValidateManagedMcpConfigResponse }
      },
    }),
    validateMcpConnection: builder.mutation<ValidateMcpConnectionResponse, ValidateMcpConnectionParams>({
      queryFn: async ({ projectId, body }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers/validate-connection`,
            method: "POST",
            body,
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: result.data as ValidateMcpConnectionResponse }
      },
    }),
    deleteMcpServer: builder.mutation<DeleteMcpServerResponse, DeleteMcpServerParams>({
      queryFn: async ({ projectId, id }, api, extraOptions) => {
        const result = await projectsBaseQuery(
          {
            url: `/projects/${projectId}/mcp-servers/${id}`,
            method: "DELETE",
          },
          api,
          extraOptions,
        )
        if (result.error) {
          return { error: result.error }
        }
        return { data: (result.data ?? { deleted: true }) as DeleteMcpServerResponse }
      },
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Tool", id: "LIST" },
        { type: "Tool", id },
        { type: "Tool", id: `${id}-tools` },
      ],
    }),
  }),
})

export type { RefreshMcpServersResponse }

export const {
  useCreateMcpServerMutation,
  useValidateManagedMcpConfigMutation,
  useValidateMcpConnectionMutation,
  useRefreshMcpServersMutation,
  useGetMcpServerQuery,
  useUpdateMcpServerMutation,
  useDeleteMcpServerMutation,
} = toolsetApi

import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
} from "@reduxjs/toolkit/query/react";

import { PROJECTS_BASE_URL, WORKFLOW_BASE_URL } from "@/consts/api.consts";
import { apiSlice, createBaseQueryWithReauth } from "./api.slice";
import type {
  AddProjectMemberRequest,
  CreateProjectRequest,
  Project,
  ProjectListResponse,
  ProjectMemberListResponse,
  ProjectMembershipWorkflowResponse,
  RemoveProjectMemberRequest,
  UpdateProjectMemberRoleRequest,
  UpdateProjectRequest,
  UserProjectsResponse,
} from "./project.types";
import {
  normalizeProjectMemberListResponse,
  normalizeUserProjectsResponse,
} from "./project.types";

const configBaseQuery = createBaseQueryWithReauth(PROJECTS_BASE_URL);
const workflowBaseQuery = createBaseQueryWithReauth(WORKFLOW_BASE_URL);

function projectMembersListTag(projectId: string) {
  return { type: "ProjectMembers" as const, id: projectId };
}

function projectMemberItemTag(projectId: string, userId: string) {
  return { type: "ProjectMembers" as const, id: `${projectId}:${userId}` };
}

function userProjectsListTag() {
  return { type: "UserProjects" as const, id: "LIST" };
}

function userProjectsUserTag(userId: string) {
  return { type: "UserProjects" as const, id: userId };
}

function userProjectsEntryTag(projectId: string) {
  return { type: "UserProjects" as const, id: projectId };
}

function invalidateMembershipTags(projectId: string) {
  // Email-based writes can't pre-resolve the userId, so granular per-user tags
  // are no longer populated here. Project-level invalidation forces a refetch
  // of the members list, which carries the canonical user records.
  return [
    projectMembersListTag(projectId),
    userProjectsListTag(),
    userProjectsEntryTag(projectId),
  ];
}

async function runConfigQuery<T>(
  args: string | FetchArgs,
  api: Parameters<BaseQueryFn>[1],
  extraOptions: Parameters<BaseQueryFn>[2],
): Promise<{ data: T } | { error: FetchBaseQueryError }> {
  const result = await configBaseQuery(args, api, extraOptions);
  if (result.error) {
    return { error: result.error };
  }
  return { data: result.data as T };
}

const projectsApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    listProjects: builder.query<ProjectListResponse, void>({
      queryFn: async (_arg, api, extraOptions) =>
        runConfigQuery<ProjectListResponse>("/projects", api, extraOptions),
      providesTags: (result) => {
        const projects = result?.projects ?? [];
        return projects.length > 0
          ? [
            { type: "ProjectList", id: "LIST" },
            ...projects.map(({ id }) => ({
              type: "Project" as const,
              id,
            })),
          ]
          : [{ type: "ProjectList", id: "LIST" }];
      },
    }),

    getProject: builder.query<Project, string>({
      queryFn: async (projectId, api, extraOptions) =>
        runConfigQuery<Project>(`/projects/${projectId}`, api, extraOptions),
      providesTags: (_result, _error, projectId) => [
        { type: "Project", id: projectId },
      ],
    }),

    createProject: builder.mutation<Project, CreateProjectRequest>({
      queryFn: async (body, api, extraOptions) =>
        runConfigQuery<Project>(
          { url: "/projects", method: "POST", body },
          api,
          extraOptions,
        ),
      invalidatesTags: [
        { type: "ProjectList", id: "LIST" },
        userProjectsListTag(),
      ],
    }),

    updateProject: builder.mutation<Project, { projectId: string; body: UpdateProjectRequest }>({
      queryFn: async ({ projectId, body }, api, extraOptions) =>
        runConfigQuery<Project>(
          { url: `/projects/${projectId}`, method: "PUT", body },
          api,
          extraOptions,
        ),
      invalidatesTags: (_result, _error, { projectId }) => [
        { type: "ProjectList", id: "LIST" },
        { type: "Project", id: projectId },
      ],
    }),

    deleteProject: builder.mutation<void, string>({
      queryFn: async (projectId, api, extraOptions) => {
        const result = await configBaseQuery(
          { url: `/projects/${projectId}`, method: "DELETE" },
          api,
          extraOptions,
        );
        if (result.error) {
          return { error: result.error };
        }
        return { data: undefined };
      },
      invalidatesTags: (_result, _error, projectId) => [
        { type: "ProjectList", id: "LIST" },
        { type: "Project", id: projectId },
        projectMembersListTag(projectId),
      ],
    }),

    listProjectMembers: builder.query<ProjectMemberListResponse, string>({
      queryFn: async (projectId, api, extraOptions) => {
        const result = await runConfigQuery<ProjectMemberListResponse>(
          `/projects/${projectId}/members`,
          api,
          extraOptions,
        );
        if ("error" in result) {
          return result;
        }
        return {
          data: normalizeProjectMemberListResponse(result.data as unknown as Record<string, unknown>),
        };
      },
      providesTags: (result, _error, projectId) => {
        const members = result?.members ?? [];
        return members.length > 0
          ? [
            projectMembersListTag(projectId),
            ...members.map(({ userId }) => projectMemberItemTag(projectId, userId)),
          ]
          : [projectMembersListTag(projectId)];
      },
    }),

    listUserProjects: builder.query<UserProjectsResponse, string>({
      queryFn: async (userId, api, extraOptions) => {
        const result = await runConfigQuery<UserProjectsResponse>(
          `/users/${userId}/projects`,
          api,
          extraOptions,
        );
        if ("error" in result) {
          return result;
        }
        return {
          data: normalizeUserProjectsResponse(result.data as unknown as Record<string, unknown>),
        };
      },
      providesTags: (result, _error, userId) => {
        const projects = result?.projects ?? [];
        return projects.length > 0
          ? [
            userProjectsListTag(),
            userProjectsUserTag(userId),
            ...projects.map(({ projectId }) => userProjectsEntryTag(projectId)),
          ]
          : [userProjectsListTag(), userProjectsUserTag(userId)];
      },
    }),

    addProjectMember: builder.mutation<
      ProjectMembershipWorkflowResponse,
      { projectId: string; body: AddProjectMemberRequest }
    >({
      queryFn: async ({ projectId, body }, api, extraOptions) => {
        const result = await workflowBaseQuery(
          {
            url: `/projects/${projectId}/members`,
            method: "POST",
            body: { email: body.email, role: body.role },
          },
          api,
          extraOptions,
        );
        if (result.error) {
          return { error: result.error };
        }
        return { data: result.data as ProjectMembershipWorkflowResponse };
      },
      invalidatesTags: (_result, _error, { projectId }) =>
        invalidateMembershipTags(projectId),
    }),

    removeProjectMember: builder.mutation<
      ProjectMembershipWorkflowResponse,
      { projectId: string; body: RemoveProjectMemberRequest }
    >({
      queryFn: async ({ projectId, body }, api, extraOptions) => {
        const result = await workflowBaseQuery(
          {
            url: `/projects/${projectId}/members`,
            method: "DELETE",
            body: { email: body.email },
          },
          api,
          extraOptions,
        );
        if (result.error) {
          return { error: result.error };
        }
        return { data: result.data as ProjectMembershipWorkflowResponse };
      },
      invalidatesTags: (_result, _error, { projectId }) =>
        invalidateMembershipTags(projectId),
    }),

    updateProjectMemberRole: builder.mutation<
      ProjectMembershipWorkflowResponse,
      { projectId: string; body: UpdateProjectMemberRoleRequest }
    >({
      queryFn: async ({ projectId, body }, api, extraOptions) => {
        const result = await workflowBaseQuery(
          {
            url: `/projects/${projectId}/members/role`,
            method: "PUT",
            body: { email: body.email, role: body.role },
          },
          api,
          extraOptions,
        );
        if (result.error) {
          return { error: result.error };
        }
        return { data: result.data as ProjectMembershipWorkflowResponse };
      },
      invalidatesTags: (_result, _error, { projectId }) =>
        invalidateMembershipTags(projectId),
    }),
  }),
});

export { projectsApi };

export const {
  useListProjectsQuery,
  useGetProjectQuery,
  useLazyGetProjectQuery,
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useListProjectMembersQuery,
  useListUserProjectsQuery,
  useAddProjectMemberMutation,
  useRemoveProjectMemberMutation,
  useUpdateProjectMemberRoleMutation,
} = projectsApi;

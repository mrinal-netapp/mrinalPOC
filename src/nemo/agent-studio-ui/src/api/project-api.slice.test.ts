import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/consts/api.consts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PROJECTS_BASE_URL: "http://localhost:9999/config/api/v1",
    WORKFLOW_BASE_URL: "http://localhost:9999/workflow/api/v1",
  };
});

import { createMockStore } from "@test/mocks";
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock";
import { apiSlice } from "./api.slice";
import { projectsApi } from "./project-api.slice";
import type { CreateProjectRequest, UpdateProjectRequest } from "./project.types";

type TestStore = ReturnType<typeof createMockStore>;

function calledUrl(mock: Mock, callIndex = 0): string {
  const arg = mock.mock.calls[callIndex]?.[0];
  if (typeof arg === "string") return arg;
  return arg?.url ?? String(arg);
}

function calledMethod(mock: Mock, callIndex = 0): string {
  const arg = mock.mock.calls[callIndex]?.[0];
  return arg?.method ?? "GET";
}

async function calledBodyJson(mock: Mock, callIndex = 0): Promise<unknown> {
  const arg = mock.mock.calls[callIndex]?.[0];
  if (arg instanceof Request) return arg.json();
  return arg?.body;
}

const PROJECT = {
  id: "projk3m9x2ab",
  name: "Marketing Analytics",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Team workspace" },
  home_dir: "s3://default-nemo/projects/projk3m9x2ab",
};

const LIST_RESPONSE = {
  projects: [PROJECT],
};

const CREATE_BODY: CreateProjectRequest = {
  name: "New Project",
  metadata: { description: "A new project" },
};

const UPDATE_BODY: UpdateProjectRequest = {
  name: "Renamed Project",
  metadata: { description: "Updated description" },
};

const MEMBER = {
  userId: "user-123",
  role: "admin" as const,
};

const MEMBERS_RESPONSE = {
  projectId: PROJECT.id,
  members: [MEMBER],
};

const USER_PROJECTS_RESPONSE = {
  userId: "user-123",
  projects: [{ projectId: PROJECT.id, role: "admin" as const }],
};

const WORKFLOW_RESPONSE = {
  workflowId: "wf-1",
  status: "running",
  projectId: PROJECT.id,
  userId: MEMBER.userId,
  role: "member" as const,
};

describe("projectsApi", () => {
  let store: TestStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    store.dispatch(apiSlice.util.resetApiState());
    restoreAllMocks();
  });

  describe("listProjects", () => {
    it("[tag:project-api] should GET /projects", async () => {
      const mock = mockFetchByUrl([
        { match: "/config/api/v1/projects", data: LIST_RESPONSE },
      ]);

      await store.dispatch(projectsApi.endpoints.listProjects.initiate());

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain("/config/api/v1/projects");
      expect(calledMethod(mock)).toBe("GET");
    });
  });

  describe("getProject", () => {
    it("[tag:project-api] should GET /projects/{projectId}", async () => {
      const mock = mockFetchByUrl([
        { match: `/config/api/v1/projects/${PROJECT.id}`, data: PROJECT },
      ]);

      await store.dispatch(projectsApi.endpoints.getProject.initiate(PROJECT.id));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/config/api/v1/projects/${PROJECT.id}`);
      expect(calledMethod(mock)).toBe("GET");
    });
  });

  describe("createProject", () => {
    it("[tag:project-api] should POST /projects with request body", async () => {
      const mock = mockFetchByUrl([
        { match: "/config/api/v1/projects", data: PROJECT },
      ]);

      await store.dispatch(projectsApi.endpoints.createProject.initiate(CREATE_BODY));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain("/config/api/v1/projects");
      expect(calledMethod(mock)).toBe("POST");
      expect(await calledBodyJson(mock)).toMatchObject(CREATE_BODY);
    });
  });

  describe("updateProject", () => {
    it("[tag:project-api] should PUT /projects/{projectId} with request body", async () => {
      const mock = mockFetchByUrl([
        { match: `/config/api/v1/projects/${PROJECT.id}`, data: { ...PROJECT, name: UPDATE_BODY.name } },
      ]);

      await store.dispatch(
        projectsApi.endpoints.updateProject.initiate({
          projectId: PROJECT.id,
          body: UPDATE_BODY,
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/config/api/v1/projects/${PROJECT.id}`);
      expect(calledMethod(mock)).toBe("PUT");
      expect(await calledBodyJson(mock)).toMatchObject(UPDATE_BODY);
    });
  });

  describe("deleteProject", () => {
    it("[tag:project-api] should DELETE /projects/{projectId}", async () => {
      const mock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve(null),
          text: () => Promise.resolve(""),
          headers: new Headers(),
          clone: function () { return this; },
        }),
      );
      vi.stubGlobal("fetch", mock);

      await store.dispatch(projectsApi.endpoints.deleteProject.initiate(PROJECT.id));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/config/api/v1/projects/${PROJECT.id}`);
      expect(calledMethod(mock)).toBe("DELETE");
    });
  });

  describe("listProjectMembers", () => {
    it("[tag:project-api] should GET /projects/{projectId}/members on config base", async () => {
      const mock = mockFetchByUrl([
        { match: `/config/api/v1/projects/${PROJECT.id}/members`, data: MEMBERS_RESPONSE },
      ]);

      await store.dispatch(projectsApi.endpoints.listProjectMembers.initiate(PROJECT.id));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/config/api/v1/projects/${PROJECT.id}/members`);
      expect(calledMethod(mock)).toBe("GET");
    });
  });

  describe("listUserProjects", () => {
    it("[tag:project-api] should GET /users/{userId}/projects on config base", async () => {
      const mock = mockFetchByUrl([
        { match: `/config/api/v1/users/${MEMBER.userId}/projects`, data: USER_PROJECTS_RESPONSE },
      ]);

      await store.dispatch(projectsApi.endpoints.listUserProjects.initiate(MEMBER.userId));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/config/api/v1/users/${MEMBER.userId}/projects`);
      expect(calledMethod(mock)).toBe("GET");
    });
  });

  describe("addProjectMember", () => {
    it("[tag:project-api] should POST /projects/{projectId}/members with { email, role }", async () => {
      const mock = mockFetchByUrl([
        {
          match: `/workflow/api/v1/projects/${PROJECT.id}/members`,
          data: WORKFLOW_RESPONSE,
          status: 202,
        },
      ]);

      const result = await store.dispatch(
        projectsApi.endpoints.addProjectMember.initiate({
          projectId: PROJECT.id,
          body: { email: "user@example.com", role: "member" },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/workflow/api/v1/projects/${PROJECT.id}/members`);
      expect(calledMethod(mock)).toBe("POST");
      expect(await calledBodyJson(mock)).toEqual({ email: "user@example.com", role: "member" });
      expect(result.data).toMatchObject(WORKFLOW_RESPONSE);
    });
  });

  describe("removeProjectMember", () => {
    it("[tag:project-api] should DELETE /projects/{projectId}/members with { email } in body", async () => {
      const mock = mockFetchByUrl([
        {
          match: `/workflow/api/v1/projects/${PROJECT.id}/members`,
          data: WORKFLOW_RESPONSE,
          status: 202,
        },
      ]);

      await store.dispatch(
        projectsApi.endpoints.removeProjectMember.initiate({
          projectId: PROJECT.id,
          body: { email: "user@example.com" },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/workflow/api/v1/projects/${PROJECT.id}/members`);
      expect(calledMethod(mock)).toBe("DELETE");
      expect(await calledBodyJson(mock)).toEqual({ email: "user@example.com" });
    });
  });

  describe("updateProjectMemberRole", () => {
    it("[tag:project-api] should PUT /projects/{projectId}/members/role with { email, role }", async () => {
      const mock = mockFetchByUrl([
        {
          match: `/workflow/api/v1/projects/${PROJECT.id}/members/role`,
          data: { ...WORKFLOW_RESPONSE, role: "member" },
          status: 202,
        },
      ]);

      await store.dispatch(
        projectsApi.endpoints.updateProjectMemberRole.initiate({
          projectId: PROJECT.id,
          body: { email: "user@example.com", role: "member" },
        }),
      );

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain(`/workflow/api/v1/projects/${PROJECT.id}/members/role`);
      expect(calledMethod(mock)).toBe("PUT");
      expect(await calledBodyJson(mock)).toEqual({ email: "user@example.com", role: "member" });
    });
  });
});

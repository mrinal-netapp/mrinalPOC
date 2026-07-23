import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

import { createMockStore } from "@test/mocks";
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock";

import { agentsConfigApi } from "./agents-config-api.slice";

type TestStore = ReturnType<typeof createMockStore>;

const P = "p1";

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0];
  if (typeof arg === "string") return arg;
  return arg?.url ?? String(arg);
}

function calledMethod(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0];
  return arg?.method ?? "GET";
}

async function calledBodyJson(mock: Mock): Promise<unknown> {
  const arg = mock.mock.calls[0]?.[0];
  if (arg instanceof Request) return arg.json();
  return arg?.body;
}

function providedTags(store: TestStore): Record<string, Record<string, unknown>> {
  return store.getState().api.provided.tags as Record<
    string,
    Record<string, unknown>
  >;
}

describe("agentsConfigApi", () => {
  let store: TestStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    store.dispatch(agentsConfigApi.util.resetApiState());
    restoreAllMocks();
  });

  it("[tag:agents-config-api] injects into the shared apiSlice (reducerPath 'api')", () => {
    expect(agentsConfigApi.reducerPath).toBe("api");
  });

  // ── Pickers ────────────────────────────────────────────────────────────────

  describe("listProjectModels", () => {
    it("[tag:agents-config-api] GETs /models with dependents skipped and provides Model tags", async () => {
      const mock = mockFetchSuccess([{ id: "m1" }, { id: "m2" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listProjectModels.initiate({ projectId: P }),
      );
      const url = calledUrl(mock);
      expect(url).toContain(`/projects/${P}/models`);
      expect(url).toContain("dependentsSummary%3Dfalse");
      const tags = providedTags(store);
      expect(tags.Model?.LIST).toBeDefined();
      expect(tags.Model?.m1).toBeDefined();
    });

    it("[tag:agents-config-api] adds modelType when provided", async () => {
      const mock = mockFetchSuccess([{ id: "m1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listProjectModels.initiate({
          projectId: P,
          modelType: "llm",
        }),
      );
      expect(calledUrl(mock)).toContain("modelType=llm");
    });

    it("[tag:agents-config-api] provides only the LIST tag when the query errors", async () => {
      mockFetchError(500);
      await store.dispatch(
        agentsConfigApi.endpoints.listProjectModels.initiate({ projectId: P }),
      );
      const tags = providedTags(store);
      expect(tags.Model?.LIST).toBeDefined();
      expect(tags.Model?.m1).toBeUndefined();
    });
  });

  describe("listMcpServers", () => {
    it("[tag:agents-config-api] GETs /mcp-servers and provides Tool tags", async () => {
      const mock = mockFetchSuccess([{ id: "s1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listMcpServers.initiate({ projectId: P }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/mcp-servers`);
      expect(providedTags(store).Tool?.s1).toBeDefined();
    });

    it("[tag:agents-config-api] honours an explicit include param + error branch", async () => {
      const mock = mockFetchSuccess([{ id: "s1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listMcpServers.initiate({
          projectId: P,
          include: "dependentsSummary=true",
        }),
      );
      expect(calledUrl(mock)).toContain("dependentsSummary%3Dtrue");

      const errStore = createMockStore();
      mockFetchError(500);
      await errStore.dispatch(
        agentsConfigApi.endpoints.listMcpServers.initiate({ projectId: P }),
      );
      expect(providedTags(errStore).Tool?.LIST).toBeDefined();
    });
  });

  describe("listMcpServerTools", () => {
    it("[tag:agents-config-api] GETs /mcp-servers/:id/tools and tags the per-server catalog", async () => {
      const mock = mockFetchSuccess([{ name: "t1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listMcpServerTools.initiate({
          projectId: P,
          id: "s9",
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/mcp-servers/s9/tools`);
      expect(providedTags(store).Tool?.["s9-tools"]).toBeDefined();
    });
  });

  describe("listProjectKnowledgeBases", () => {
    it("[tag:agents-config-api] GETs /knowledgebases and provides CONFIG_LIST + per-item KB tags", async () => {
      const mock = mockFetchSuccess([{ id: "kb1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listProjectKnowledgeBases.initiate({
          projectId: P,
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/knowledgebases`);
      const tags = providedTags(store);
      expect(tags.KnowledgeBase?.CONFIG_LIST).toBeDefined();
      expect(tags.KnowledgeBase?.kb1).toBeDefined();
    });

    it("[tag:agents-config-api] falls back to CONFIG_LIST only on error", async () => {
      mockFetchError(500);
      await store.dispatch(
        agentsConfigApi.endpoints.listProjectKnowledgeBases.initiate({
          projectId: P,
        }),
      );
      expect(providedTags(store).KnowledgeBase?.CONFIG_LIST).toBeDefined();
    });
  });

  // ── Agents ───────────────────────────────────────────────────────────────

  describe("listAgents", () => {
    it("[tag:agents-config-api] GETs /agents with every supported query param", async () => {
      const mock = mockFetchSuccess([{ id: "a1" }, { id: "a2" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listAgents.initiate({
          projectId: P,
          limit: 10,
          skip: 5,
          field: "name",
          value: "x",
          nameRegex: "^x",
          include: "dependentsSummary=false",
        }),
      );
      const url = calledUrl(mock);
      expect(url).toContain(`/projects/${P}/agents`);
      expect(url).toContain("limit=10");
      expect(url).toContain("skip=5");
      expect(url).toContain("nameRegex=");
      const tags = providedTags(store);
      expect(tags.Agent?.LIST).toBeDefined();
      expect(tags.Agent?.a1).toBeDefined();
    });

    it("[tag:agents-config-api] GETs /agents with no optional params + provides LIST-only on error", async () => {
      const mock = mockFetchSuccess([{ id: "a1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listAgents.initiate({ projectId: P }),
      );
      expect(calledUrl(mock)).not.toContain("limit=");

      const errStore = createMockStore();
      mockFetchError(500);
      await errStore.dispatch(
        agentsConfigApi.endpoints.listAgents.initiate({ projectId: P }),
      );
      const tags = providedTags(errStore);
      expect(tags.Agent?.LIST).toBeDefined();
      expect(tags.Agent?.a1).toBeUndefined();
    });
  });

  describe("getAgent", () => {
    it("[tag:agents-config-api] GETs /agents/:id and provides AgentDetail", async () => {
      const mock = mockFetchSuccess({ id: "a1" });
      await store.dispatch(
        agentsConfigApi.endpoints.getAgent.initiate({ projectId: P, id: "a1" }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents/a1`);
      expect(providedTags(store).AgentDetail?.a1).toBeDefined();
    });
  });

  describe("agent mutations", () => {
    it("[tag:agents-config-api] createAgent POSTs /agents", async () => {
      const mock = mockFetchSuccess({ id: "a1" });
      await store.dispatch(
        agentsConfigApi.endpoints.createAgent.initiate({
          projectId: P,
          body: { name: "n" } as never,
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents`);
      expect(calledMethod(mock)).toBe("POST");
    });

    it("[tag:agents-config-api] updateAgent PUTs /agents/:id", async () => {
      const mock = mockFetchSuccess({ id: "a1" });
      await store.dispatch(
        agentsConfigApi.endpoints.updateAgent.initiate({
          projectId: P,
          id: "a1",
          body: { name: "n" } as never,
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents/a1`);
      expect(calledMethod(mock)).toBe("PUT");
    });

    it("[tag:agents-config-api] updateAgentStatus PUTs /agents/:id/status with the deployment body", async () => {
      const mock = mockFetchSuccess({ id: "a1" });
      await store.dispatch(
        agentsConfigApi.endpoints.updateAgentStatus.initiate({
          projectId: P,
          id: "a1",
          body: { deploymentStatus: "deployed" },
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents/a1/status`);
      expect(calledMethod(mock)).toBe("PUT");
      expect(await calledBodyJson(mock)).toMatchObject({
        deploymentStatus: "deployed",
      });
    });

    it("[tag:agents-config-api] deleteAgent DELETEs /agents/:id", async () => {
      const mock = mockFetchSuccess(null);
      await store.dispatch(
        agentsConfigApi.endpoints.deleteAgent.initiate({ projectId: P, id: "a1" }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents/a1`);
      expect(calledMethod(mock)).toBe("DELETE");
    });
  });

  describe("agent history + dependents", () => {
    it("[tag:agents-config-api] listAgentVersions GETs /agents/:id/history", async () => {
      const mock = mockFetchSuccess([{ version: 1 }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listAgentVersions.initiate({
          projectId: P,
          id: "a1",
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents/a1/history`);
    });

    it("[tag:agents-config-api] restoreAgentVersion POSTs /agents/:id/restore-version", async () => {
      const mock = mockFetchSuccess({ id: "a1" });
      await store.dispatch(
        agentsConfigApi.endpoints.restoreAgentVersion.initiate({
          projectId: P,
          id: "a1",
          version: 3,
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agents/a1/restore-version`);
      expect(calledMethod(mock)).toBe("POST");
      expect(await calledBodyJson(mock)).toMatchObject({ version: 3 });
    });

    it("[tag:agents-config-api] listAgentDependents GETs /agents/:id/dependents with paging params", async () => {
      const mock = mockFetchSuccess({ items: [], nextCursor: null });
      await store.dispatch(
        agentsConfigApi.endpoints.listAgentDependents.initiate({
          projectId: P,
          id: "a1",
          limit: 5,
          cursor: "c1",
          kind: "agent",
        }),
      );
      const url = calledUrl(mock);
      expect(url).toContain(`/projects/${P}/agents/a1/dependents`);
      expect(url).toContain("limit=5");
      expect(url).toContain("cursor=c1");
    });
  });

  // ── Agent teams ────────────────────────────────────────────────────────────

  describe("agent teams", () => {
    it("[tag:agents-config-api] listAgentTeams GETs /agent-teams and provides AgentTeam tags", async () => {
      const mock = mockFetchSuccess([{ id: "t1" }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listAgentTeams.initiate({
          projectId: P,
          limit: 2,
          skip: 0,
          nameRegex: "^t",
          include: "dependentsSummary=false",
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams`);
      expect(providedTags(store).AgentTeam?.t1).toBeDefined();
    });

    it("[tag:agents-config-api] listAgentTeams provides LIST-only on error", async () => {
      mockFetchError(500);
      await store.dispatch(
        agentsConfigApi.endpoints.listAgentTeams.initiate({ projectId: P }),
      );
      expect(providedTags(store).AgentTeam?.LIST).toBeDefined();
    });

    it("[tag:agents-config-api] getAgentTeam GETs /agent-teams/:id and provides AgentTeamDetail", async () => {
      const mock = mockFetchSuccess({ id: "t1" });
      await store.dispatch(
        agentsConfigApi.endpoints.getAgentTeam.initiate({ projectId: P, id: "t1" }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams/t1`);
      expect(providedTags(store).AgentTeamDetail?.t1).toBeDefined();
    });

    it("[tag:agents-config-api] createAgentTeam POSTs /agent-teams", async () => {
      const mock = mockFetchSuccess({ id: "t1" });
      await store.dispatch(
        agentsConfigApi.endpoints.createAgentTeam.initiate({
          projectId: P,
          body: { name: "n" } as never,
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams`);
      expect(calledMethod(mock)).toBe("POST");
    });

    it("[tag:agents-config-api] updateAgentTeam PUTs /agent-teams/:id", async () => {
      const mock = mockFetchSuccess({ id: "t1" });
      await store.dispatch(
        agentsConfigApi.endpoints.updateAgentTeam.initiate({
          projectId: P,
          id: "t1",
          body: { name: "n" } as never,
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams/t1`);
      expect(calledMethod(mock)).toBe("PUT");
    });

    it("[tag:agents-config-api] updateAgentTeamStatus PUTs /agent-teams/:id/status", async () => {
      const mock = mockFetchSuccess({ id: "t1" });
      await store.dispatch(
        agentsConfigApi.endpoints.updateAgentTeamStatus.initiate({
          projectId: P,
          id: "t1",
          body: { deploymentStatus: "draft" },
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams/t1/status`);
      expect(calledMethod(mock)).toBe("PUT");
    });

    it("[tag:agents-config-api] deleteAgentTeam DELETEs /agent-teams/:id", async () => {
      const mock = mockFetchSuccess(null);
      await store.dispatch(
        agentsConfigApi.endpoints.deleteAgentTeam.initiate({
          projectId: P,
          id: "t1",
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams/t1`);
      expect(calledMethod(mock)).toBe("DELETE");
    });

    it("[tag:agents-config-api] listAgentTeamVersions GETs /agent-teams/:id/history", async () => {
      const mock = mockFetchSuccess([{ version: 1 }]);
      await store.dispatch(
        agentsConfigApi.endpoints.listAgentTeamVersions.initiate({
          projectId: P,
          id: "t1",
        }),
      );
      expect(calledUrl(mock)).toContain(`/projects/${P}/agent-teams/t1/history`);
    });

    it("[tag:agents-config-api] restoreAgentTeamVersion POSTs /agent-teams/:id/restore-version", async () => {
      const mock = mockFetchSuccess({ id: "t1" });
      await store.dispatch(
        agentsConfigApi.endpoints.restoreAgentTeamVersion.initiate({
          projectId: P,
          id: "t1",
          version: 2,
        }),
      );
      expect(calledUrl(mock)).toContain(
        `/projects/${P}/agent-teams/t1/restore-version`,
      );
      expect(await calledBodyJson(mock)).toMatchObject({ version: 2 });
    });

    it("[tag:agents-config-api] listAgentTeamDependents GETs /agent-teams/:id/dependents", async () => {
      const mock = mockFetchSuccess({ items: [], nextCursor: null });
      await store.dispatch(
        agentsConfigApi.endpoints.listAgentTeamDependents.initiate({
          projectId: P,
          id: "t1",
          limit: 3,
          cursor: "c2",
          kind: "agent_team",
        }),
      );
      const url = calledUrl(mock);
      expect(url).toContain(`/projects/${P}/agent-teams/t1/dependents`);
      expect(url).toContain("cursor=c2");
      expect(url).toContain("kind=agent_team");
    });
  });
});

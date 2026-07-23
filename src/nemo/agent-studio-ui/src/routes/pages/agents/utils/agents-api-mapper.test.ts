import { describe, it, expect } from "vitest";

import type {
  Agent,
  AgentTeam,
  AgentTeamOrchestrationPolicy,
} from "@/routes/pages/agents/api/agents-config.types";
import { buildAgentDefaultValues } from "../create-edit/form/agent-form.consts";
import type { AgentFormValues } from "../create-edit/form/agent-form.consts";
import type { SaveAgentValues } from "../create-edit/configure-dialogs/save-agent-dialog";
import {
  buildSingleAgentDetail,
  buildTeamAgentDetail,
  isTeamAgentId,
  mapAgentToFormValues,
  mapFormToCreateRequest,
  mapFormToCreateTeamRequest,
  mapTeamToFormValues,
  mapTemplateAgentInstanceToCreateRequest,
  mapTemplateToCreateTeamRequest,
  toSingleAgent,
  toTeamAgent,
} from "./agents-api-mapper";
import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
} from "../create-edit/form/agent-templates.consts";
import {
  buildAgentInstanceFromTemplate,
  buildManagerInstanceFromTemplate,
} from "../create-edit/form/template-agent.utils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Tiny factory so each test states only the fields it actually cares
// about. The defaults match the most permissive `Agent` shape from the
// OpenAPI: required fields populated, optionals omitted.
function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "ag-1",
    projectId: "p-1",
    name: "Test agent",
    role: "Specialist",
    systemPrompt: "Be helpful.",
    status: "Healthy",
    deploymentStatus: "draft",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function makeTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "agr-1",
    projectId: "p-1",
    name: "Test team",
    members: [],
    status: "Healthy",
    deploymentStatus: "draft",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isTeamAgentId
// ---------------------------------------------------------------------------

describe("isTeamAgentId", () => {
  it("[tag:agents-mapper] returns true for the team prefix", () => {
    expect(isTeamAgentId("agr-mockt001")).toBe(true);
  });

  it("[tag:agents-mapper] returns false for the single-agent prefix", () => {
    expect(isTeamAgentId("ag-mock0001")).toBe(false);
  });

  it("[tag:agents-mapper] returns false for arbitrary strings", () => {
    expect(isTeamAgentId("agent-1")).toBe(false);
    expect(isTeamAgentId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toSingleAgent
// ---------------------------------------------------------------------------

describe("toSingleAgent", () => {
  it(
    "[tag:agents-mapper] prefers the enriched model display name over the raw id",
    () => {
      const row = toSingleAgent(
        makeAgent({
          modelId: "mdl-abc",
          model: { id: "mdl-abc", name: "GPT-4", displayName: "GPT-4 Turbo" },
        }),
      );
      expect(row.models).toEqual(["GPT-4 Turbo"]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to model.name when displayName is absent",
    () => {
      const row = toSingleAgent(
        makeAgent({ model: { id: "mdl-abc", name: "GPT-4" } }),
      );
      expect(row.models).toEqual(["GPT-4"]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to modelId when the enrichment is missing",
    () => {
      const row = toSingleAgent(makeAgent({ modelId: "mdl-fallback" }));
      expect(row.models).toEqual(["mdl-fallback"]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to modelClass when both model + modelId are missing",
    () => {
      const row = toSingleAgent(makeAgent({ modelClass: "openai-gpt" }));
      expect(row.models).toEqual(["openai-gpt"]);
    },
  );

  it("[tag:agents-mapper] returns an empty models array when nothing resolves", () => {
    const row = toSingleAgent(makeAgent());
    expect(row.models).toEqual([]);
  });

  it("[tag:agents-mapper] flags a blocking required requirement", () => {
    const row = toSingleAgent(
      makeAgent({
        requirements: {
          knowledgeBases: [
            { id: "kb-r", label: "Req KB", description: "", required: true },
          ],
        },
      }),
    );
    expect(row.hasBlockingRequirements).toBe(true);
  });

  it("[tag:agents-mapper] is not blocked when requirements are absent or optional", () => {
    expect(toSingleAgent(makeAgent()).hasBlockingRequirements).toBe(false);
    const optional = toSingleAgent(
      makeAgent({
        requirements: {
          mcpServers: [
            { id: "mcp-o", label: "Opt MCP", description: "", required: false },
          ],
        },
      }),
    );
    expect(optional.hasBlockingRequirements).toBe(false);
  });

  it(
    "[tag:agents-mapper] maps enriched associated knowledge bases by id + name",
    () => {
      const row = toSingleAgent(
        makeAgent({
          associatedResources: {
            knowledgeBases: [{ id: "kb-1", name: "kb-product-docs" }],
            agentTeams: [],
          },
        }),
      );
      expect(row.associatedResources).toEqual([
        { id: "kb-1", name: "kb-product-docs", kind: "knowledge-base" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to raw knowledgeBaseIds when enrichment is missing",
    () => {
      const row = toSingleAgent(
        makeAgent({ knowledgeBaseIds: ["kb-raw-1", "kb-raw-2"] }),
      );
      expect(row.associatedResources).toEqual([
        { id: "kb-raw-1", name: "kb-raw-1", kind: "knowledge-base" },
        { id: "kb-raw-2", name: "kb-raw-2", kind: "knowledge-base" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to raw knowledgeBaseIds when the enriched KB list is present but empty",
    () => {
      // The server always ships the enrichment block; an empty `knowledgeBases`
      // array means it couldn't resolve names, not that nothing is attached.
      const row = toSingleAgent(
        makeAgent({
          knowledgeBaseIds: ["kb-raw-1"],
          associatedResources: { knowledgeBases: [], agentTeams: [] },
        }),
      );
      expect(row.associatedResources).toEqual([
        { id: "kb-raw-1", name: "kb-raw-1", kind: "knowledge-base" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] surfaces parent teams alongside knowledge bases",
    () => {
      const row = toSingleAgent(
        makeAgent({
          associatedResources: {
            knowledgeBases: [{ id: "kb-1", name: "kb-product-docs" }],
            agentTeams: [{ id: "agr-1", name: "support-team" }],
          },
        }),
      );
      expect(row.associatedResources).toEqual([
        { id: "kb-1", name: "kb-product-docs", kind: "knowledge-base" },
        { id: "agr-1", name: "support-team", kind: "agent-team" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] surfaces parent teams even when no KBs are attached",
    () => {
      const row = toSingleAgent(
        makeAgent({
          associatedResources: {
            knowledgeBases: [],
            agentTeams: [{ id: "agr-9", name: "ops-team" }],
          },
        }),
      );
      expect(row.associatedResources).toEqual([
        { id: "agr-9", name: "ops-team", kind: "agent-team" },
      ]);
    },
  );

  it("[tag:agents-mapper] returns an empty associated array when nothing is wired", () => {
    expect(toSingleAgent(makeAgent()).associatedResources).toEqual([]);
  });

  it(
    "[tag:agents-mapper] surfaces attached MCP toolsets, resolving names via the resolver",
    () => {
      const row = toSingleAgent(
        makeAgent({ mcpServerIds: ["ms-1", "ms-2"] }),
        (id) => (id === "ms-1" ? "Amazon_FSxN" : id === "ms-2" ? "testmcp" : undefined),
      );
      expect(row.associatedResources).toEqual([
        { id: "ms-1", name: "Amazon_FSxN", kind: "mcp-server" },
        { id: "ms-2", name: "testmcp", kind: "mcp-server" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to the MCP server id when the name can't be resolved",
    () => {
      // No resolver at all, and a resolver that returns undefined, both keep the
      // toolset visible using its id rather than dropping it.
      expect(
        toSingleAgent(makeAgent({ mcpServerIds: ["ms-x"] })).associatedResources,
      ).toEqual([{ id: "ms-x", name: "ms-x", kind: "mcp-server" }]);
      expect(
        toSingleAgent(makeAgent({ mcpServerIds: ["ms-x"] }), () => undefined)
          .associatedResources,
      ).toEqual([{ id: "ms-x", name: "ms-x", kind: "mcp-server" }]);
    },
  );

  it(
    "[tag:agents-mapper] orders associations as knowledge bases, then toolsets, then teams",
    () => {
      const row = toSingleAgent(
        makeAgent({
          mcpServerIds: ["ms-1"],
          associatedResources: {
            knowledgeBases: [{ id: "kb-1", name: "kb-docs" }],
            agentTeams: [{ id: "agr-1", name: "support-team" }],
          },
        }),
        () => "Amazon_FSxN",
      );
      expect(row.associatedResources).toEqual([
        { id: "kb-1", name: "kb-docs", kind: "knowledge-base" },
        { id: "ms-1", name: "Amazon_FSxN", kind: "mcp-server" },
        { id: "agr-1", name: "support-team", kind: "agent-team" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] defaults status to Healthy when the payload omits it",
    () => {
      // Cast through `unknown` so we can express the pre-migration
      // payload shape without violating TS-001. `status` is non-null on
      // fresh rows but might be missing on legacy serialized data.
      const legacy = { ...makeAgent(), status: undefined } as unknown as Agent;
      const row = toSingleAgent(legacy);
      expect(row.status).toBe("Healthy");
    },
  );

  it(
    "[tag:agents-mapper] defaults deploymentStatus to draft when omitted",
    () => {
      const legacy = {
        ...makeAgent(),
        deploymentStatus: undefined,
      } as unknown as Agent;
      const row = toSingleAgent(legacy);
      expect(row.deploymentStatus).toBe("draft");
    },
  );

  it(
    "[tag:agents-mapper] preserves the row id, name, and updatedAt",
    () => {
      const row = toSingleAgent(
        makeAgent({
          id: "ag-keep",
          name: "Keeper",
          updatedAt: "2026-03-15T01:02:03Z",
        }),
      );
      expect(row.id).toBe("ag-keep");
      expect(row.name).toBe("Keeper");
      expect(row.lastUpdated).toBe("2026-03-15T01:02:03Z");
    },
  );
});

// ---------------------------------------------------------------------------
// toTeamAgent
// ---------------------------------------------------------------------------

describe("toTeamAgent", () => {
  it(
    "[tag:agents-mapper] maps enriched member agents by id + name",
    () => {
      const row = toTeamAgent(
        makeTeam({
          associatedResources: {
            agents: [{ id: "ag-1", name: "support-bot" }],
            agentTeams: [],
          },
          members: [{ memberType: "agent", memberId: "ag-1" }],
        }),
      );
      expect(row.associatedAgents).toEqual([
        { id: "ag-1", name: "support-bot", kind: "agent" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] maps enriched member single agents and nested team agents",
    () => {
      const row = toTeamAgent(
        makeTeam({
          associatedResources: {
            agents: [{ id: "ag-1", name: "support-bot" }],
            agentTeams: [{ id: "agr-2", name: "triage-team" }],
          },
          members: [
            { memberType: "agent", memberId: "ag-1" },
            { memberType: "team", memberId: "agr-2" },
          ],
        }),
      );
      expect(row.associatedAgents).toEqual([
        { id: "ag-1", name: "support-bot", kind: "agent" },
        { id: "agr-2", name: "triage-team", kind: "agent-team" },
      ]);
    },
  );

  it(
    "[tag:agents-mapper] falls back to raw members (kinded by memberType) when enrichment is missing",
    () => {
      const row = toTeamAgent(
        makeTeam({
          members: [
            { memberType: "agent", memberId: "ag-raw-1" },
            { memberType: "team", memberId: "agr-raw-2" },
          ],
        }),
      );
      expect(row.associatedAgents).toEqual([
        { id: "ag-raw-1", name: "ag-raw-1", kind: "agent" },
        { id: "agr-raw-2", name: "agr-raw-2", kind: "agent-team" },
      ]);
    },
  );

  it("[tag:agents-mapper] returns empty models when manager has neither id nor class", () => {
    const row = toTeamAgent(makeTeam());
    expect(row.models).toEqual([]);
  });

  it("[tag:agents-mapper] prefers the enriched manager.model name over the raw modelId", () => {
    const row = toTeamAgent(
      makeTeam({
        manager: {
          modelId: "29890a7f-0522-46f8-867c-e4796904efd7",
          model: {
            id: "29890a7f-0522-46f8-867c-e4796904efd7",
            name: "gpt-4-turbo-jp",
          },
        },
      }),
    );
    expect(row.models).toEqual(["gpt-4-turbo-jp"]);
  });

  it("[tag:agents-mapper] falls back to manager.modelId when model enrichment is absent", () => {
    const row = toTeamAgent(
      makeTeam({ manager: { modelId: "mdl-manager" } }),
    );
    expect(row.models).toEqual(["mdl-manager"]);
  });

  it("[tag:agents-mapper] falls back to manager.modelClass when modelId is absent", () => {
    const row = toTeamAgent(
      makeTeam({ manager: { modelClass: "anthropic" } }),
    );
    expect(row.models).toEqual(["anthropic"]);
  });

  it("[tag:agents-mapper] defaults status + deploymentStatus when omitted", () => {
    const legacy = {
      ...makeTeam(),
      status: undefined,
      deploymentStatus: undefined,
    } as unknown as AgentTeam;
    const row = toTeamAgent(legacy);
    expect(row.status).toBe("Healthy");
    expect(row.deploymentStatus).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// buildSingleAgentDetail
// ---------------------------------------------------------------------------

describe("buildSingleAgentDetail", () => {
  it(
    "[tag:agents-mapper] prefers the new `goal` field over the deprecated outcomeDescription",
    () => {
      const detail = buildSingleAgentDetail(
        makeAgent({
          goal: "Be helpful.",
          outcomeDescription: "Old goal.",
        }),
      );
      expect(detail.profile.goal).toBe("Be helpful.");
    },
  );

  it(
    "[tag:agents-mapper] falls back to outcomeDescription when goal is null",
    () => {
      const detail = buildSingleAgentDetail(
        makeAgent({ goal: null, outcomeDescription: "Legacy goal." }),
      );
      expect(detail.profile.goal).toBe("Legacy goal.");
    },
  );

  it("[tag:agents-mapper] carries the blocking-requirements flag", () => {
    expect(buildSingleAgentDetail(makeAgent()).hasBlockingRequirements).toBe(false);
    const blocked = buildSingleAgentDetail(
      makeAgent({
        requirements: {
          mcpServers: [
            { id: "mcp-r", label: "Req MCP", description: "", required: true },
          ],
        },
      }),
    );
    expect(blocked.hasBlockingRequirements).toBe(true);
  });

  it("[tag:agents-mapper] uses empty strings when goal and outcomeDescription are both missing", () => {
    const detail = buildSingleAgentDetail(makeAgent());
    expect(detail.profile.goal).toBe("");
  });

  it(
    "[tag:agents-mapper] wraps the systemPrompt into a single-line instructions array",
    () => {
      const detail = buildSingleAgentDetail(
        makeAgent({ systemPrompt: "Greet first." }),
      );
      expect(detail.profile.instructions).toEqual(["Greet first."]);
    },
  );

  it("[tag:agents-mapper] returns an empty instructions array when there is no systemPrompt", () => {
    const detail = buildSingleAgentDetail(makeAgent({ systemPrompt: "" }));
    expect(detail.profile.instructions).toEqual([]);
  });

  it(
    "[tag:agents-mapper] populates related.toolsets from mcpServerIds",
    () => {
      const detail = buildSingleAgentDetail(
        makeAgent({ mcpServerIds: ["m-1", "m-2", "m-3"] }),
      );
      expect(detail.related.toolsets).toBe(3);
    },
  );

  it(
    "[tag:agents-mapper] populates related.assignedKnowledgeBases from enrichment when present",
    () => {
      const detail = buildSingleAgentDetail(
        makeAgent({
          associatedResources: {
            knowledgeBases: [
              { id: "kb-1", name: "kb-one" },
              { id: "kb-2", name: "kb-two" },
            ],
            agentTeams: [],
          },
        }),
      );
      expect(detail.related.assignedKnowledgeBases).toBe(2);
    },
  );

  it(
    "[tag:agents-mapper] falls back to raw knowledgeBaseIds for the count",
    () => {
      const detail = buildSingleAgentDetail(
        makeAgent({ knowledgeBaseIds: ["kb-x", "kb-y"] }),
      );
      expect(detail.related.assignedKnowledgeBases).toBe(2);
    },
  );

  it("[tag:agents-mapper] zero-fills the metrics block when there is no telemetry", () => {
    const detail = buildSingleAgentDetail(makeAgent());
    expect(detail.metrics).toEqual({
      activeUsers: 0,
      conversations: 0,
      successRatePercent: 0,
    });
  });

  it("[tag:agents-mapper] sets type to Single-agent", () => {
    const detail = buildSingleAgentDetail(makeAgent());
    expect(detail.type).toBe("Single-agent");
  });

  it("[tag:agents-mapper] passes through createdAt and updatedAt as ISO strings", () => {
    const detail = buildSingleAgentDetail(
      makeAgent({
        createdAt: "2026-01-15T00:00:00Z",
        updatedAt: "2026-02-20T00:00:00Z",
      }),
    );
    expect(detail.createdISO).toBe("2026-01-15T00:00:00Z");
    expect(detail.lastUpdatedISO).toBe("2026-02-20T00:00:00Z");
  });

  it("[tag:agents-mapper] defaults description and labels when absent", () => {
    const detail = buildSingleAgentDetail(makeAgent());
    expect(detail.description).toBe("");
    expect(detail.labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildTeamAgentDetail
// ---------------------------------------------------------------------------

describe("buildTeamAgentDetail", () => {
  it("[tag:agents-mapper] sets type to Team-agent", () => {
    const detail = buildTeamAgentDetail(makeTeam());
    expect(detail.type).toBe("Team-agent");
  });

  it(
    "[tag:agents-mapper] derives the profile role from manager.role",
    () => {
      const detail = buildTeamAgentDetail(
        makeTeam({ manager: { role: "Coordinator" } }),
      );
      expect(detail.profile.role).toBe("Coordinator");
    },
  );

  it(
    "[tag:agents-mapper] wraps manager systemPrompt into instructions",
    () => {
      const detail = buildTeamAgentDetail(
        makeTeam({ manager: { systemPrompt: "Route messages." } }),
      );
      expect(detail.profile.instructions).toEqual(["Route messages."]);
    },
  );

  it(
    "[tag:agents-mapper] counts assignedKnowledgeBases from sharedKnowledgeBaseIds",
    () => {
      const detail = buildTeamAgentDetail(
        makeTeam({ sharedKnowledgeBaseIds: ["kb-1", "kb-2"] }),
      );
      expect(detail.related.assignedKnowledgeBases).toBe(2);
    },
  );

  it(
    "[tag:agents-mapper] sets goal to an empty string for teams (no manager.goal field today)",
    () => {
      const detail = buildTeamAgentDetail(makeTeam());
      expect(detail.profile.goal).toBe("");
    },
  );

  it("[tag:agents-mapper] zero-fills metrics and counts when manager is absent", () => {
    const detail = buildTeamAgentDetail(makeTeam());
    expect(detail.profile.role).toBe("");
    expect(detail.profile.instructions).toEqual([]);
    expect(detail.related.toolsets).toBe(0);
    expect(detail.related.assignedKnowledgeBases).toBe(0);
  });

  it("[tag:agents-mapper] prefers the enriched manager.model name over the raw modelId", () => {
    const detail = buildTeamAgentDetail(
      makeTeam({
        manager: {
          modelId: "29890a7f-0522-46f8-867c-e4796904efd7",
          model: {
            id: "29890a7f-0522-46f8-867c-e4796904efd7",
            name: "gpt-4-turbo-jp",
          },
        },
      }),
    );
    expect(detail.models).toEqual(["gpt-4-turbo-jp"]);
  });

  it("[tag:agents-mapper] falls back to the raw manager.modelId when model enrichment is absent", () => {
    const detail = buildTeamAgentDetail(
      makeTeam({ manager: { modelId: "mdl-manager" } }),
    );
    expect(detail.models).toEqual(["mdl-manager"]);
  });
});

// ---------------------------------------------------------------------------
// mapFormToCreateTeamRequest
// ---------------------------------------------------------------------------

function makeTeamFormValues(
  team: Partial<AgentFormValues["team"]> = {},
): AgentFormValues {
  const base = buildAgentDefaultValues();
  return {
    ...base,
    configuration: "team",
    team: { ...base.team, ...team },
  };
}

function makeIdentity(overrides: Partial<SaveAgentValues> = {}): SaveAgentValues {
  return { name: "My team", description: "", labels: [], ...overrides };
}

describe("mapFormToCreateTeamRequest", () => {
  it("[tag:agents-mapper] maps agentIds and teamIds into typed members", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({ agentIds: ["ag-aaaa1111"], teamIds: ["agr-bbbb2222"] }),
      makeIdentity(),
    );

    expect(body.members).toEqual([
      { memberType: "agent", memberId: "ag-aaaa1111" },
      { memberType: "team", memberId: "agr-bbbb2222" },
    ]);
  });

  it("[tag:agents-mapper] sends the inline manager config when orchestration is coordinate and managerModel is set", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "coordinate",
        managerName: "Coordinator",
        managerModel: "mdl-cccc3333",
        managerInstructions: "Be concise and delegate efficiently.",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
    );

    expect(body.manager).toEqual({
      name: "Coordinator",
      modelId: "mdl-cccc3333",
      systemPrompt: "Be concise and delegate efficiently.",
    });
  });

  it("[tag:agents-mapper] merges existing manager JSONB on edit so role and extra keys survive", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "coordinate",
        managerName: "Updated",
        managerModel: "mdl-cccc3333",
        managerInstructions: "New instructions.",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
      { existingManager: { role: "Coordinator", temperature: 0.5 } },
    );

    expect(body.manager).toEqual({
      role: "Coordinator",
      temperature: 0.5,
      name: "Updated",
      modelId: "mdl-cccc3333",
      systemPrompt: "New instructions.",
    });
  });

  it("[tag:agents-mapper] preserves reference-only manager on edit when inline form fields are empty", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "coordinate",
        managerName: "",
        managerModel: "",
        managerInstructions: "",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
      { existingManager: { agent_id: "ag-manager-1" } },
    );

    expect(body.manager).toEqual({ agent_id: "ag-manager-1" });
  });

  it("[tag:agents-mapper] does not carry agent_id into inline manager payload on edit merge", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "coordinate",
        managerName: "Updated",
        managerModel: "mdl-cccc3333",
        managerInstructions: "New instructions.",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
      {
        existingManager: {
          agent_id: "ag-old-manager",
          role: "Coordinator",
          temperature: 0.5,
        },
      },
    );

    expect(body.manager).toEqual({
      role: "Coordinator",
      temperature: 0.5,
      name: "Updated",
      modelId: "mdl-cccc3333",
      systemPrompt: "New instructions.",
    });
    expect(body.manager).not.toHaveProperty("agent_id");
  });

  it("[tag:agents-mapper] omits manager on edit when orchestration does not require one", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "sequential",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
      { existingManager: { agent_id: "ag-manager-1" } },
    );

    expect(body.manager).toBeUndefined();
  });

  it("[tag:agents-mapper] trims surrounding whitespace from managerInstructions", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "coordinate",
        managerModel: "mdl-cccc3333",
        managerInstructions: "  Be concise.  \n",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
    );

    expect(body.manager).toEqual({ modelId: "mdl-cccc3333", systemPrompt: "Be concise." });
  });

  it("[tag:agents-mapper] omits systemPrompt from manager when instructions are empty", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "coordinate",
        managerModel: "mdl-cccc3333",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
    );

    expect(body.manager).toEqual({ modelId: "mdl-cccc3333" });
  });

  it("[tag:agents-mapper] omits the manager when no managerModel is set", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({ orchestrationPattern: "coordinate", agentIds: ["ag-aaaa1111"] }),
      makeIdentity(),
    );

    expect(body.manager).toBeUndefined();
  });

  it("[tag:agents-mapper] omits the manager when orchestration is not coordinate or route", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "sequential",
        managerModel: "mdl-cccc3333",
        agentIds: ["ag-aaaa1111"],
      }),
      makeIdentity(),
    );

    expect(body.manager).toBeUndefined();
  });

  it("[tag:agents-mapper] sends the inline manager config when orchestration is route (triage router)", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({
        orchestrationPattern: "route",
        managerName: "Router",
        managerModel: "mdl-cccc3333",
        managerInstructions:
          "Use Hello for greetings; Restaurants_Search for food.",
        agentIds: ["ag-aaaa1111", "ag-bbbb2222"],
      }),
      makeIdentity(),
    );

    expect(body.manager).toEqual({
      name: "Router",
      modelId: "mdl-cccc3333",
      systemPrompt: "Use Hello for greetings; Restaurants_Search for food.",
    });
    expect(body.orchestrationPolicy).toBe("route");
  });

  it("[tag:agents-mapper] maps a supported orchestration pattern to orchestrationPolicy", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({ orchestrationPattern: "sequential", agentIds: ["ag-aaaa1111"] }),
      makeIdentity(),
    );

    expect(body.orchestrationPolicy).toBe("sequential");
  });

  it("[tag:agents-mapper] sends concurrent orchestration policy to the backend", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({ orchestrationPattern: "concurrent", agentIds: ["ag-aaaa1111"] }),
      makeIdentity(),
    );

    expect(body.orchestrationPolicy).toBe("concurrent");
    expect(body.manager).toBeUndefined();
  });

  it("[tag:agents-mapper] omits orchestrationPolicy when the pattern is empty or unsupported", () => {
    const empty = mapFormToCreateTeamRequest(
      makeTeamFormValues({ orchestrationPattern: "" }),
      makeIdentity(),
    );
    expect(empty.orchestrationPolicy).toBeUndefined();
  });

  it("[tag:agents-mapper] forwards identity name, description and labels", () => {
    const body = mapFormToCreateTeamRequest(
      makeTeamFormValues({ agentIds: ["ag-aaaa1111"] }),
      makeIdentity({ name: "Support pod", description: "Front-line", labels: ["sales"] }),
    );

    expect(body.name).toBe("Support pod");
    expect(body.description).toBe("Front-line");
    expect(body.labels).toEqual(["sales"]);
  });

  it("[tag:agents-mapper] produces an empty members list when nothing is selected", () => {
    const body = mapFormToCreateTeamRequest(makeTeamFormValues(), makeIdentity());
    expect(body.members).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapTeamToFormValues
// ---------------------------------------------------------------------------

describe("mapTeamToFormValues", () => {
  it("[tag:agents-mapper] sets the configuration to team", () => {
    const values = mapTeamToFormValues(makeTeam());
    expect(values.configuration).toBe("team");
  });

  it("[tag:agents-mapper] splits members into agentIds and teamIds by memberType", () => {
    const values = mapTeamToFormValues(
      makeTeam({
        members: [
          { memberType: "agent", memberId: "ag-aaaa1111" },
          { memberType: "team", memberId: "agr-bbbb2222" },
          { memberType: "agent", memberId: "ag-cccc3333" },
        ],
      }),
    );

    expect(values.team?.agentIds).toEqual(["ag-aaaa1111", "ag-cccc3333"]);
    expect(values.team?.teamIds).toEqual(["agr-bbbb2222"]);
  });

  it("[tag:agents-mapper] restores inline manager name, modelId and systemPrompt into managerInstructions", () => {
    const values = mapTeamToFormValues(
      makeTeam({ manager: { name: "Coordinator", modelId: "mdl-mgr00001", systemPrompt: "Lead the team." } }),
    );
    expect(values.team?.managerName).toBe("Coordinator");
    expect(values.team?.managerModel).toBe("mdl-mgr00001");
    expect(values.team?.managerInstructions).toBe("Lead the team.");
  });

  it("[tag:agents-mapper] restores inline manager with empty fields when manager is absent", () => {
    const values = mapTeamToFormValues(
      makeTeam({ manager: { name: "Inline boss", modelId: "mdl-1" } }),
    );
    expect(values.team?.managerName).toBe("Inline boss");
    expect(values.team?.managerModel).toBe("mdl-1");
    expect(values.team?.managerInstructions).toBe("");
  });

  it("[tag:agents-mapper] restores orchestrationPolicy", () => {
    const values = mapTeamToFormValues(
      makeTeam({ orchestrationPolicy: "sequential" }),
    );

    expect(values.team?.orchestrationPattern).toBe("sequential");
  });

  it("[tag:agents-mapper] defaults orchestration and manager fields when absent", () => {
    const values = mapTeamToFormValues(makeTeam());
    expect(values.team?.orchestrationPattern).toBe("");
    expect(values.team?.managerName).toBe("");
    expect(values.team?.managerModel).toBe("");
    expect(values.team?.managerInstructions).toBe("");
  });
});

// ---------------------------------------------------------------------------
// mapFormToCreateRequest — toolset / mcpServerConfig wiring
// ---------------------------------------------------------------------------

const SAVE_IDENTITY: SaveAgentValues = {
  name: "Toolset agent",
  description: "",
  labels: [],
};

function makeAttachedToolset(
  overrides: Partial<AgentFormValues["toolsets"][number]> = {},
): AgentFormValues["toolsets"][number] {
  return {
    id: "ms-1111",
    name: "GitHub",
    status: "healthy",
    account: "",
    authMethod: "",
    tools: ["create_issue", "update_issue"],
    ...overrides,
  };
}

describe("mapFormToCreateRequest (toolsets)", () => {
  it("[tag:agents-mapper] sends mcpServerIds and per-server allowedTools from the selected tools", () => {
    const form: AgentFormValues = {
      ...buildAgentDefaultValues(),
      toolsets: [makeAttachedToolset()],
    };

    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);

    expect(req.mcpServerIds).toEqual(["ms-1111"]);
    expect(req.mcpServerConfig).toEqual({
      "ms-1111": { permissions: [], allowedTools: ["create_issue", "update_issue"] },
    });
  });

  it("[tag:agents-mapper] omits allowedTools for a toolset with no selected tools (inherit server default)", () => {
    const form: AgentFormValues = {
      ...buildAgentDefaultValues(),
      toolsets: [makeAttachedToolset({ id: "ms-2222", tools: [] })],
    };

    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);

    expect(req.mcpServerConfig).toEqual({ "ms-2222": { permissions: [] } });
  });

  it("[tag:agents-mapper] sends empty mcpServerIds/mcpServerConfig when no toolsets are attached", () => {
    const req = mapFormToCreateRequest(buildAgentDefaultValues(), SAVE_IDENTITY);
    expect(req.mcpServerIds).toEqual([]);
    expect(req.mcpServerConfig).toEqual({});
  });

  it("[tag:agents-mapper] sends empty knowledgeBaseIds/ragConfig when the last knowledge base is removed", () => {
    const req = mapFormToCreateRequest(buildAgentDefaultValues(), SAVE_IDENTITY);
    expect(req.knowledgeBaseIds).toEqual([]);
    expect(req.ragConfig).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mapFormToCreateRequest — model params (Top-K) / multiple fallbacks
// ---------------------------------------------------------------------------

describe("mapFormToCreateRequest (model params)", () => {
  it("[tag:agents-mapper] sends primary topK and fallback top_k when above zero", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      primaryModel: "mdl-primary",
      primaryModelParams: { ...base.primaryModelParams, topK: 40 },
      fallbackModel: "mdl-a",
      fallbackModelParams: { ...base.fallbackModelParams, topK: 25 },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.topK).toBe(40);
    expect(req.fallbackModelIds).toEqual(["mdl-a"]);
    expect(req.fallbackModelParams?.top_k).toBe(25);
  });

  it("[tag:agents-mapper] omits topK / top_k when left at zero", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      primaryModel: "mdl-primary",
      primaryModelParams: { ...base.primaryModelParams, topK: 0 },
      fallbackModel: "mdl-a",
      fallbackModelParams: { ...base.fallbackModelParams, topK: 0 },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.topK).toBeUndefined();
    expect(req.fallbackModelParams && "top_k" in req.fallbackModelParams).toBe(false);
  });

  it("[tag:agents-mapper] omits fallback fields entirely when no fallback model is selected", () => {
    const req = mapFormToCreateRequest(buildAgentDefaultValues(), SAVE_IDENTITY);
    expect(req.fallbackModelIds).toBeUndefined();
    expect(req.fallbackModelParams).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapFormToCreateRequest — output-response / structured-output / rate-limit
// ---------------------------------------------------------------------------

describe("mapFormToCreateRequest (feature cards)", () => {
  it("[tag:agents-mapper] sends the output-response example when the feature is on", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["output_response"],
      featureConfig: { ...base.featureConfig, outputResponseExample: "Reply as JSON." },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.outputResponse).toEqual({ enabled: true, example_response: "Reply as JSON." });
  });

  it("[tag:agents-mapper] omits example_response when the example is blank", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["output_response"],
      featureConfig: { ...base.featureConfig, outputResponseExample: "   " },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.outputResponse).toEqual({ enabled: true });
  });

  it("[tag:agents-mapper] sends responseFormat + outputSchema for json_object (no json_schema)", () => {
    const base = buildAgentDefaultValues();
    const schema = '{ "type": "object", "properties": { "x": { "type": "number" } } }';
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "json_object",
        structuredOutputSchema: schema,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.structuredOutput).toEqual({
      enabled: true,
      responseFormat: "json_object",
      outputSchema: schema,
    });
  });

  it("[tag:agents-mapper] sends text mode payloads as outputSchema guidelines", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "text",
        structuredOutputSchema: "Respond in bullet points.",
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.structuredOutput).toEqual({
      enabled: true,
      responseFormat: "text",
      outputSchema: "Respond in bullet points.",
    });
  });

  it("[tag:agents-mapper] sends explicit { enabled: false } when the feature is off", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: [],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "json_object",
        structuredOutputSchema: '{ "type": "object" }',
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.structuredOutput).toEqual({ enabled: false });
  });

  it("[tag:agents-mapper] throws when structured_output is enabled but schema is invalid JSON", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "json_object",
        structuredOutputSchema: "{not-json",
      },
    };
    expect(() => mapFormToCreateRequest(form, SAVE_IDENTITY)).toThrow(
      "Structured output schema must be a valid JSON Schema object when Structured output is enabled.",
    );
  });

  it("[tag:agents-mapper] throws when structured_output json_object schema is empty", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "json_object",
        structuredOutputSchema: "   ",
      },
    };
    expect(() => mapFormToCreateRequest(form, SAVE_IDENTITY)).toThrow(
      "JSON schema is required when Structured output is enabled.",
    );
  });

  it("[tag:agents-mapper] throws when structured_output json_object schema is JSON but not a JSON Schema", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "json_object",
        structuredOutputSchema: '{"message":"hello","count":1,"active":true}',
      },
    };
    expect(() => mapFormToCreateRequest(form, SAVE_IDENTITY)).toThrow(
      "Structured output schema must be a valid JSON Schema object when Structured output is enabled.",
    );
  });

  it("[tag:agents-mapper] throws when structured_output text mode is enabled but guidelines are empty", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "text",
        structuredOutputSchema: "   ",
      },
    };
    expect(() => mapFormToCreateRequest(form, SAVE_IDENTITY)).toThrow(
      "Response guidelines are required when Structured output is enabled.",
    );
  });

  it("[tag:agents-mapper] writes only the unified memoryContext shape (no legacy dual-write)", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["conversation_memory"],
      featureConfig: {
        ...base.featureConfig,
        messageRetentionMethod: "sliding_window",
        messageHistoryLimit: 10,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.memoryContext).toEqual({
      enabled: true,
      type: "window",
      message_window_limit: 10,
    });
    // config-service derives the legacy fields on save — UI must NOT send them.
    expect(req.memoryType).toBeUndefined();
    expect(req.memoryConfig).toBeUndefined();
  });

  it("[tag:agents-mapper] maps retention method to memoryContext.type", () => {
    const base = buildAgentDefaultValues();

    const slidingReq = mapFormToCreateRequest(
      {
        ...base,
        enabledFeatures: ["conversation_memory"],
        featureConfig: { ...base.featureConfig, messageRetentionMethod: "sliding_window" },
      },
      SAVE_IDENTITY,
    );
    expect(slidingReq.memoryContext?.type).toBe("window");

    const summarizedReq = mapFormToCreateRequest(
      {
        ...base,
        enabledFeatures: ["conversation_memory"],
        featureConfig: { ...base.featureConfig, messageRetentionMethod: "summarized" },
      },
      SAVE_IDENTITY,
    );
    expect(summarizedReq.memoryContext?.type).toBe("summary_buffer");
  });

  it("[tag:agents-mapper] sliding_window always emits the typed message_window_limit", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["conversation_memory"],
      featureConfig: {
        ...base.featureConfig,
        messageRetentionMethod: "sliding_window",
        messageHistoryLimit: 42,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.memoryContext).toEqual({
      enabled: true,
      type: "window",
      message_window_limit: 42,
    });
  });

  it("[tag:agents-mapper] summarized always emits the typed summary_token_limit", () => {
    const base = buildAgentDefaultValues();
    const req = mapFormToCreateRequest(
      {
        ...base,
        enabledFeatures: ["conversation_memory"],
        featureConfig: {
          ...base.featureConfig,
          messageRetentionMethod: "summarized",
          summaryTokenLimit: 1500,
        },
      },
      SAVE_IDENTITY,
    );
    expect(req.memoryContext?.type).toBe("summary_buffer");
    expect(req.memoryContext?.summary_token_limit).toBe(1500);
  });

  it("[tag:agents-mapper] sends memoryContext with enabled=false when conversation memory is off", () => {
    const base = buildAgentDefaultValues();
    const req = mapFormToCreateRequest(
      {
        ...base,
        enabledFeatures: [],
        featureConfig: {
          ...base.featureConfig,
          messageRetentionMethod: "sliding_window",
          messageHistoryLimit: 22,
        },
      },
      SAVE_IDENTITY,
    );
    expect(req.memoryContext).toEqual({
      enabled: false,
      type: "window",
      message_window_limit: 22,
    });
  });

  it("[tag:agents-mapper] sends retries with enabled=false when automatic retries is off", () => {
    const base = buildAgentDefaultValues();
    const req = mapFormToCreateRequest(
      {
        ...base,
        enabledFeatures: [],
        featureConfig: { ...base.featureConfig, maxRetries: 7 },
      },
      SAVE_IDENTITY,
    );
    expect(req.retries).toEqual({ enabled: false, max_retries: 7 });
  });

  it("[tag:agents-mapper] sends the rate-limit ceiling when rate limiting is on", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["api_rate_limiting"],
      featureConfig: { ...base.featureConfig, maxRequestsPerMinute: 120 },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.rateLimiting).toEqual({ enabled: true, max_requests_per_minute: 120 });
  });

  it("[tag:agents-mapper] sends rate limiting with enabled=false when the card is off", () => {
    const base = buildAgentDefaultValues();
    const req = mapFormToCreateRequest(
      {
        ...base,
        enabledFeatures: [],
        featureConfig: { ...base.featureConfig, maxRequestsPerMinute: 80 },
      },
      SAVE_IDENTITY,
    );
    expect(req.rateLimiting).toEqual({ enabled: false, max_requests_per_minute: 80 });
  });
  it("[tag:agents-mapper] maps enabled safety guardrails into the guardrails contract (both input and output)", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["safety_guardrails"],
      featureConfig: {
        ...base.featureConfig,
        piiMaskerEnabled: true,
        apiKeyTokenScannerEnabled: true,
        secretDetectionEnabled: true,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.guardrails).toEqual({
      enabled: true,
      fail_open: false,
      log_blocked_requests: true,
      input_guardrails: [
        {
          guardrail_id: "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d",
          name: "pii_masker",
          enabled: true,
        },
        {
          guardrail_id: "7d2e1a9c-4f63-4b8e-9a1d-2c7f5e8b0d36",
          name: "content_filter",
          enabled: true,
        },
        {
          guardrail_id: "e91b6f4a-3c08-4d2b-bf7e-5a9c1d4e8027",
          name: "secret_leakage",
          enabled: true,
        },
      ],
      output_guardrails: [
        {
          guardrail_id: "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148",
          name: "pii_masker",
          enabled: true,
        },
        {
          guardrail_id: "0f8d3b62-7e51-4a9c-b2d4-6e1a8c503f9b",
          name: "content_filter",
          enabled: true,
        },
        {
          guardrail_id: "92c4e87a-5b16-4f03-8d9e-1a7c2b6f4d50",
          name: "secret_leakage",
          enabled: true,
        },
      ],
    });
  });

  it("[tag:agents-mapper] sends only the enabled guardrails and omits disabled ones", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["safety_guardrails"],
      featureConfig: {
        ...base.featureConfig,
        piiMaskerEnabled: true,
        apiKeyTokenScannerEnabled: false,
        secretDetectionEnabled: false,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.guardrails?.input_guardrails).toEqual([
      {
        guardrail_id: "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d",
        name: "pii_masker",
        enabled: true,
      },
    ]);
    expect(req.guardrails?.output_guardrails).toEqual([
      {
        guardrail_id: "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148",
        name: "pii_masker",
        enabled: true,
      },
    ]);
  });

  it("[tag:agents-mapper] still sends top-level guardrails flags with empty rule lists when all toggles are off", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["safety_guardrails"],
      featureConfig: {
        ...base.featureConfig,
        piiMaskerEnabled: false,
        apiKeyTokenScannerEnabled: false,
        secretDetectionEnabled: false,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.guardrails).toEqual({
      enabled: true,
      fail_open: false,
      log_blocked_requests: true,
      input_guardrails: [],
      output_guardrails: [],
    });
  });

  it("[tag:agents-mapper] builds guardrails from hardcoded ids without any catalog input", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["safety_guardrails"],
      featureConfig: {
        ...base.featureConfig,
        piiMaskerEnabled: true,
        apiKeyTokenScannerEnabled: true,
        secretDetectionEnabled: true,
      },
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);

    expect(req.guardrails).toEqual({
      enabled: true,
      fail_open: false,
      log_blocked_requests: true,
      input_guardrails: [
        {
          guardrail_id: "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d",
          name: "pii_masker",
          enabled: true,
        },
        {
          guardrail_id: "7d2e1a9c-4f63-4b8e-9a1d-2c7f5e8b0d36",
          name: "content_filter",
          enabled: true,
        },
        {
          guardrail_id: "e91b6f4a-3c08-4d2b-bf7e-5a9c1d4e8027",
          name: "secret_leakage",
          enabled: true,
        },
      ],
      output_guardrails: [
        {
          guardrail_id: "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148",
          name: "pii_masker",
          enabled: true,
        },
        {
          guardrail_id: "0f8d3b62-7e51-4a9c-b2d4-6e1a8c503f9b",
          name: "content_filter",
          enabled: true,
        },
        {
          guardrail_id: "92c4e87a-5b16-4f03-8d9e-1a7c2b6f4d50",
          name: "secret_leakage",
          enabled: true,
        },
      ],
    });
  });

  it("[tag:agents-mapper] throws when schema parses to a non-object value", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      enabledFeatures: ["structured_output"],
      featureConfig: {
        ...base.featureConfig,
        responseFormat: "json_object",
        structuredOutputSchema: "[]",
      },
    };
    expect(() => mapFormToCreateRequest(form, SAVE_IDENTITY)).toThrow(
      "Structured output schema must be a valid JSON Schema object when Structured output is enabled.",
    );
  });

  it("[tag:agents-mapper] default form values enable conversation memory with sliding window limit 10", () => {
    const req = mapFormToCreateRequest(buildAgentDefaultValues(), SAVE_IDENTITY);
    expect(req.memoryContext).toEqual({
      enabled: true,
      type: "window",
      message_window_limit: 10,
    });
  });

  it("[tag:agents-mapper] builds ragConfig defaults when a KB has no explicit ragConfig", () => {
    const base = buildAgentDefaultValues();
    const form: AgentFormValues = {
      ...base,
      knowledgeBases: [
        {
          id: "kb-defaults",
          name: "KB",
          status: "healthy",
          tier: "",
          remaining: "",
          fileUsage: "",
        },
      ],
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.knowledgeBaseIds).toEqual(["kb-defaults"]);
    expect(req.ragConfig).toEqual({
      "kb-defaults": {
        topK: 5,
        similarityThreshold: 0.5,
        searchMode: "hybrid",
        rerankingEnabled: true,
        similarityThresholdEnabled: true,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// mapAgentToFormValues — role round-trip
// ---------------------------------------------------------------------------

describe("mapAgentToFormValues (role)", () => {
  it("[tag:agents-mapper] restores role from the API response", () => {
    const values = mapAgentToFormValues(makeAgent({ role: "research-analyst" }));
    expect(values.role).toBe("research-analyst");
  });
});

// ---------------------------------------------------------------------------
// mapFormToCreateRequest — role
// ---------------------------------------------------------------------------

describe("mapFormToCreateRequest (role)", () => {
  it("[tag:agents-mapper] sends the loaded role when present", () => {
    const form = {
      ...buildAgentDefaultValues(),
      role: "research-analyst",
      primaryModel: "model-1",
      instructions: "Do work",
    };
    const req = mapFormToCreateRequest(form, SAVE_IDENTITY);
    expect(req.role).toBe("research-analyst");
  });

  it("[tag:agents-mapper] falls back to assistant when role is blank", () => {
    const req = mapFormToCreateRequest(buildAgentDefaultValues(), SAVE_IDENTITY);
    expect(req.role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// mapAgentToFormValues — feature-card round-trip
// ---------------------------------------------------------------------------

describe("mapAgentToFormValues (feature cards)", () => {
  it("[tag:agents-mapper] restores output example, structured schema, and rate limit", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        outputResponse: { enabled: true, example_response: "Reply briefly." },
        structuredOutput: {
          enabled: true,
          responseFormat: "json_object",
          outputSchema: '{ "type": "object" }',
        },
        rateLimiting: { enabled: true, max_requests_per_minute: 200 },
      }),
    );
    expect(values.enabledFeatures).toEqual(
      expect.arrayContaining(["output_response", "structured_output", "api_rate_limiting"]),
    );
    expect(values.featureConfig?.outputResponseExample).toBe("Reply briefly.");
    expect(values.featureConfig?.responseFormat).toBe("json_object");
    expect(values.featureConfig?.structuredOutputSchema).toBe('{ "type": "object" }');
    expect(values.featureConfig?.maxRequestsPerMinute).toBe(200);
  });
  it("[tag:agents-mapper] restores memory from the legacy AgentMemoryContext shape (pre-Stage-4 rows)", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        memoryContext: {
          enabled: true,
          message_retention_policy: "summarize",
          message_history_limit: 14,
          session_history_limit: 6,
        },
      }),
    );
    expect(values.enabledFeatures).toEqual(
      expect.arrayContaining(["conversation_memory"]),
    );
    expect(values.featureConfig?.messageRetentionMethod).toBe("summarized");
    expect(values.featureConfig?.messageHistoryLimit).toBe(14);
    expect(values.featureConfig?.sessionHistoryLimit).toBe(6);
  });

  it("[tag:agents-mapper] restores memory from the new MemoryContext shape (type + message_window_limit)", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        memoryContext: {
          enabled: true,
          type: "window",
          message_window_limit: 7,
        },
      }),
    );
    expect(values.featureConfig?.messageRetentionMethod).toBe("sliding_window");
    expect(values.featureConfig?.messageHistoryLimit).toBe(7);
  });

  it("[tag:agents-mapper] restores summary token limit when memoryContext.type=summary_buffer", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        memoryContext: {
          enabled: true,
          type: "summary_buffer",
          message_window_limit: 10,
          summary_token_limit: 1500,
        },
      }),
    );
    expect(values.featureConfig?.messageRetentionMethod).toBe("summarized");
    expect(values.featureConfig?.summaryTokenLimit).toBe(1500);
  });

  it("[tag:agents-mapper] defaults memory method to sliding_window when policy is absent", () => {
    const values = mapAgentToFormValues(makeAgent());
    expect(values.featureConfig?.messageRetentionMethod).toBe("sliding_window");
  });

  it("[tag:agents-mapper] restores guardrail toggles from the guardrails contract", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        guardrails: {
          enabled: true,
          fail_open: false,
          log_blocked_requests: true,
          input_guardrails: [
            {
              guardrail_id: "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d",
              name: "pii_masker",
              enabled: true,
            },
            {
              guardrail_id: "7d2e1a9c-4f63-4b8e-9a1d-2c7f5e8b0d36",
              name: "content_filter",
              enabled: true,
            },
            {
              guardrail_id: "e91b6f4a-3c08-4d2b-bf7e-5a9c1d4e8027",
              name: "secret_leakage",
              enabled: true,
            },
          ],
          output_guardrails: [
            {
              guardrail_id: "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148",
              name: "pii_masker",
              enabled: true,
            },
            {
              guardrail_id: "0f8d3b62-7e51-4a9c-b2d4-6e1a8c503f9b",
              name: "content_filter",
              enabled: true,
            },
            {
              guardrail_id: "92c4e87a-5b16-4f03-8d9e-1a7c2b6f4d50",
              name: "secret_leakage",
              enabled: true,
            },
          ],
        },
      }),
    );
    expect(values.enabledFeatures).toEqual(
      expect.arrayContaining(["safety_guardrails"]),
    );
    expect(values.featureConfig?.piiMaskerEnabled).toBe(true);
    expect(values.featureConfig?.apiKeyTokenScannerEnabled).toBe(true);
    expect(values.featureConfig?.secretDetectionEnabled).toBe(true);
  });

  it("[tag:agents-mapper] restores only the guardrail toggles present in the contract", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        guardrails: {
          enabled: true,
          fail_open: false,
          log_blocked_requests: true,
          input_guardrails: [
            {
              guardrail_id: "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d",
              name: "pii_masker",
              enabled: true,
            },
          ],
          output_guardrails: [
            {
              guardrail_id: "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148",
              name: "pii_masker",
              enabled: true,
            },
          ],
        },
      }),
    );
    expect(values.enabledFeatures).toEqual(
      expect.arrayContaining(["safety_guardrails"]),
    );
    expect(values.featureConfig?.piiMaskerEnabled).toBe(true);
    expect(values.featureConfig?.apiKeyTokenScannerEnabled).toBe(false);
    expect(values.featureConfig?.secretDetectionEnabled).toBe(false);
  });

  it("[tag:agents-mapper] restores retries and keeps the feature disabled when retries.enabled is false", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        retries: { enabled: false, max_retries: 9 },
      }),
    );
    expect(values.enabledFeatures).not.toContain("automatic_retries");
    expect(values.featureConfig?.maxRetries).toBe(9);
  });

  it("[tag:agents-mapper] restores KB ragConfig fields from agent.ragConfig", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        knowledgeBaseIds: ["kb-1"],
        ragConfig: {
          "kb-1": {
            topK: 7,
            similarityThreshold: 0.66,
            searchMode: "hybrid",
            rerankingEnabled: false,
            similarityThresholdEnabled: false,
          },
        },
      }),
    );
    expect(values.knowledgeBases).toEqual([
      expect.objectContaining({
        id: "kb-1",
        ragConfig: {
          topKChunks: 7,
          rerankingEnabled: false,
          similarityThresholdEnabled: false,
          similarity: 0.66,
        },
      }),
    ]);
  });

  it("[tag:agents-mapper] restores fallback model params, empty instructions, and KB defaults when ragConfig is absent", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        systemPrompt: undefined,
        fallbackModelIds: ["mdl-fallback"],
        fallbackModelParams: {
          temperature: 0.1,
          top_p: 0.2,
          top_k: 3,
          token_limit: 1234,
        },
        knowledgeBaseIds: ["kb-raw"],
        ragConfig: undefined,
      }),
    );

    expect(values.instructions).toBe("");
    expect(values.fallbackModel).toBe("mdl-fallback");
    expect(values.fallbackModelParams).toEqual(
      expect.objectContaining({
        temperature: 0.1,
        topP: 0.2,
        topK: 3,
        responseLength: 1234,
      }),
    );
    expect(values.knowledgeBases).toEqual([
      expect.objectContaining({
        id: "kb-raw",
        fileUsage: "",
        ragConfig: undefined,
      }),
    ]);
  });

  it("[tag:agents-mapper] applies fallback token_limit default and ragConfig boolean defaults when missing", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        fallbackModelIds: ["mdl-fallback-defaults"],
        fallbackModelParams: {
          temperature: 0.3,
          top_p: 0.4,
          top_k: 9,
        },
        knowledgeBaseIds: ["kb-default-bools"],
        ragConfig: {
          "kb-default-bools": {
            topK: 4,
            similarityThreshold: 0.71,
            searchMode: "semantic",
          },
        },
      }),
    );

    expect(values.fallbackModelParams?.responseLength).toBeGreaterThan(0);
    expect(values.knowledgeBases).toEqual([
      expect.objectContaining({
        id: "kb-default-bools",
        ragConfig: expect.objectContaining({
          topKChunks: 4,
          rerankingEnabled: true,
          similarityThresholdEnabled: true,
          similarity: 0.71,
        }),
      }),
    ]);
  });

  it("[tag:agents-mapper] defaults fallback model params when fallback model id exists but params object is missing", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        fallbackModelIds: ["mdl-fallback-no-params"],
        fallbackModelParams: undefined,
      }),
    );
    expect(values.fallbackModel).toBe("mdl-fallback-no-params");
    expect(values.fallbackModelParams).toEqual(
      expect.objectContaining({
        temperature: expect.any(Number),
        topP: expect.any(Number),
        topK: expect.any(Number),
        responseLength: expect.any(Number),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// mapAgentToFormValues — toolset round-trip
// ---------------------------------------------------------------------------

describe("mapAgentToFormValues (toolsets)", () => {
  it("[tag:agents-mapper] restores selected tools from mcpServerConfig.allowedTools", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        mcpServerIds: ["ms-1111"],
        mcpServerConfig: {
          "ms-1111": { permissions: [], allowedTools: ["create_issue"] },
        },
      }),
    );

    expect(values.toolsets).toEqual([
      expect.objectContaining({ id: "ms-1111", tools: ["create_issue"] }),
    ]);
  });

  it("[tag:agents-mapper] restores an empty tool list when a server has no config entry", () => {
    const values = mapAgentToFormValues(makeAgent({ mcpServerIds: ["ms-9999"] }));
    expect(values.toolsets).toEqual([
      expect.objectContaining({ id: "ms-9999", tools: [] }),
    ]);
  });

});

// ---------------------------------------------------------------------------
// mapAgentToFormValues — requirements round-trip
// ---------------------------------------------------------------------------

describe("mapAgentToFormValues (requirements)", () => {
  it("[tag:agents-mapper] restores KB requirements from the API payload", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        requirements: {
          knowledgeBases: [
            { id: "kb-1", label: "Product Docs", description: "RAG config is missing.", required: true },
          ],
        },
      }),
    );
    expect(values.requirements?.knowledgeBases).toEqual([
      { id: "kb-1", label: "Product Docs", description: "RAG config is missing.", required: true },
    ]);
    expect(values.requirements?.mcpServers).toEqual([]);
  });

  it("[tag:agents-mapper] restores MCP server requirements from the API payload", () => {
    const values = mapAgentToFormValues(
      makeAgent({
        requirements: {
          mcpServers: [
            { id: "ms-1", label: "GitHub MCP", description: "Auth token is missing.", required: true },
          ],
        },
      }),
    );
    expect(values.requirements?.mcpServers).toEqual([
      { id: "ms-1", label: "GitHub MCP", description: "Auth token is missing.", required: true },
    ]);
    expect(values.requirements?.knowledgeBases).toEqual([]);
  });

  it("[tag:agents-mapper] defaults to empty arrays when requirements is absent", () => {
    const values = mapAgentToFormValues(makeAgent());
    expect(values.requirements).toEqual({ knowledgeBases: [], mcpServers: [] });
  });
});

// ---------------------------------------------------------------------------
// mapFormToCreateRequest — requirements serialisation
// ---------------------------------------------------------------------------

describe("mapFormToCreateRequest (requirements)", () => {
  const baseIdentity: SaveAgentValues = { name: "Test", description: "", labels: [] };

  it("[tag:agents-mapper] includes requirements block when KB requirements are present", () => {
    const defaults = buildAgentDefaultValues();
    const formValues: AgentFormValues = {
      ...defaults,
      primaryModel: "mdl-1",
      requirements: {
        knowledgeBases: [
          { id: "kb-1", label: "Docs", description: "Config needed.", required: true },
        ],
        mcpServers: [],
      },
    };
    const request = mapFormToCreateRequest(formValues, baseIdentity);
    expect(request.requirements).toEqual({
      knowledgeBases: [{ id: "kb-1", label: "Docs", description: "Config needed.", required: true }],
      mcpServers: [],
    });
  });

  it("[tag:agents-mapper] includes requirements block when MCP requirements are present", () => {
    const defaults = buildAgentDefaultValues();
    const formValues: AgentFormValues = {
      ...defaults,
      primaryModel: "mdl-1",
      requirements: {
        knowledgeBases: [],
        mcpServers: [
          { id: "ms-1", label: "GitHub", description: "Auth missing.", required: false },
        ],
      },
    };
    const request = mapFormToCreateRequest(formValues, baseIdentity);
    expect(request.requirements).toEqual({
      knowledgeBases: [],
      mcpServers: [{ id: "ms-1", label: "GitHub", description: "Auth missing.", required: false }],
    });
  });

  it("[tag:agents-mapper] sends empty requirement arrays so removed placeholders are cleared", () => {
    const defaults = buildAgentDefaultValues();
    const formValues: AgentFormValues = {
      ...defaults,
      primaryModel: "mdl-1",
    };
    const request = mapFormToCreateRequest(formValues, baseIdentity);
    expect(request.requirements).toEqual({ knowledgeBases: [], mcpServers: [] });
  });

  it("[tag:agents-mapper] includes both knowledgeBases and mcpServers when both lists are non-empty", () => {
    const defaults = buildAgentDefaultValues();
    const formValues: AgentFormValues = {
      ...defaults,
      primaryModel: "mdl-1",
      requirements: {
        knowledgeBases: [{ id: "kb-1", label: "KB", description: "Missing.", required: true }],
        mcpServers: [{ id: "ms-1", label: "MCP", description: "Missing.", required: true }],
      },
    };
    const request = mapFormToCreateRequest(formValues, baseIdentity);
    expect(request.requirements?.knowledgeBases).toHaveLength(1);
    expect(request.requirements?.mcpServers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mapAgentToFormValues — requirements edge cases
// ---------------------------------------------------------------------------

describe("mapAgentToFormValues (requirements edge cases)", () => {
  it("[tag:agents-mapper] defaults knowledgeBases to [] when requirements exists but knowledgeBases is undefined", () => {
    const values = mapAgentToFormValues(
      makeAgent({ requirements: { mcpServers: [{ id: "ms-1", label: "MCP", description: "Missing.", required: true }] } }),
    );
    expect(values.requirements?.knowledgeBases).toEqual([]);
    expect(values.requirements?.mcpServers).toHaveLength(1);
  });

  it("[tag:agents-mapper] defaults mcpServers to [] when requirements exists but mcpServers is undefined", () => {
    const values = mapAgentToFormValues(
      makeAgent({ requirements: { knowledgeBases: [{ id: "kb-1", label: "KB", description: "Missing.", required: true }] } }),
    );
    expect(values.requirements?.mcpServers).toEqual([]);
    expect(values.requirements?.knowledgeBases).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mapTemplateAgentInstanceToCreateRequest / mapTemplateToCreateTeamRequest
// ---------------------------------------------------------------------------

const TEMPLATE_AGENT_DEF: AgentTemplateAgentDefinition = {
  name: "Researcher",
  role: "research-analyst",
  systemPrompt: "Find references",
  modelId: "model-a",
  requirements: {
    knowledgeBases: [
      { id: "kb-required", label: "Req KB", description: "", required: true },
      { id: "kb-optional", label: "Opt KB", description: "", required: false },
    ],
    mcpServers: [
      { id: "mcp-required", label: "Req MCP", description: "", required: true },
      { id: "mcp-optional", label: "Opt MCP", description: "", required: false },
    ],
  },
};

const TEMPLATE_DEF: AgentTemplateDefinition = {
  id: "tmpl-1",
  name: "Research Team",
  description: "Template",
  capabilities: [],
  examples: [],
  instructions: "Template instructions",
  orchestrationPattern: "Sequential",
  model: "claude",
  role: "team-manager",
  agents: [TEMPLATE_AGENT_DEF],
};

function makeConfiguredTemplateInstance() {
  return {
    ...buildAgentInstanceFromTemplate(TEMPLATE_AGENT_DEF, TEMPLATE_DEF.instructions),
    primaryModel: "model-uuid",
    name: "Research goal",
    instructions: "Do research",
    satisfiedKbRequirementIds: ["kb-required"],
    satisfiedMcpRequirementIds: ["mcp-required"],
  };
}

function makeConfiguredManagerInstance() {
  return {
    ...buildManagerInstanceFromTemplate(TEMPLATE_DEF),
    primaryModel: "manager-model",
    name: "Manager goal",
    instructions: "Lead the team",
  };
}

function makeTemplateFormValues(
  templateOverrides: Partial<AgentFormValues["template"]> = {},
): AgentFormValues {
  const base = buildAgentDefaultValues();
  return {
    ...base,
    configuration: "from_template",
    template: {
      selectedTemplate: TEMPLATE_DEF,
      agentInstances: [makeConfiguredTemplateInstance()],
      managerInstance: makeConfiguredManagerInstance(),
      orchestrationPattern: "sequential",
      ...templateOverrides,
    },
  };
}

const TEMPLATE_MEMBER_IDENTITY = { labels: [] as string[] };

describe("mapTemplateAgentInstanceToCreateRequest", () => {
  it("[tag:agents-mapper] maps the catalog role and uses the instance name as the agent name", () => {
    const body = mapTemplateAgentInstanceToCreateRequest(
      makeConfiguredTemplateInstance(),
      TEMPLATE_AGENT_DEF,
      TEMPLATE_MEMBER_IDENTITY,
    );

    expect(body.name).toBe("Research goal");
    expect(body.goal).toBe("Research goal");
    expect(body.role).toBe("research-analyst");
    expect(body.modelId).toBe("model-uuid");
    expect(body.systemPrompt).toBe("Do research");
  });

  it("[tag:agents-mapper] falls back to the catalog agent name when the instance name is blank", () => {
    const instance = {
      ...makeConfiguredTemplateInstance(),
      name: "   ",
    };
    const body = mapTemplateAgentInstanceToCreateRequest(instance, TEMPLATE_AGENT_DEF, TEMPLATE_MEMBER_IDENTITY);
    expect(body.name).toBe("Researcher");
    expect(body.goal).toBe("Researcher");
  });

  it("[tag:agents-mapper] forwards instance description and team save labels", () => {
    const body = mapTemplateAgentInstanceToCreateRequest(
      {
        ...makeConfiguredTemplateInstance(),
        description: "Audits security baselines",
      },
      TEMPLATE_AGENT_DEF,
      { labels: ["compliance", "prod"] },
    );

    expect(body.description).toBe("Audits security baselines");
    expect(body.labels).toEqual(["compliance", "prod"]);
  });

  it("[tag:agents-mapper] attaches unresolved requirement placeholders for draft save", () => {
    const instance = {
      ...makeConfiguredTemplateInstance(),
      satisfiedKbRequirementIds: [],
      satisfiedMcpRequirementIds: ["mcp-required"],
    };
    const body = mapTemplateAgentInstanceToCreateRequest(instance, TEMPLATE_AGENT_DEF, TEMPLATE_MEMBER_IDENTITY);

    expect(body.requirements?.knowledgeBases?.map((req) => req.id)).toEqual([
      "kb-required",
      "kb-optional",
    ]);
    expect(body.requirements?.mcpServers?.map((req) => req.id)).toEqual(["mcp-optional"]);
  });

  it("[tag:agents-mapper] omits requirements when every active requirement is configured", () => {
    const instance = {
      ...makeConfiguredTemplateInstance(),
      satisfiedKbRequirementIds: ["kb-required", "kb-optional"],
      satisfiedMcpRequirementIds: ["mcp-required", "mcp-optional"],
    };
    const body = mapTemplateAgentInstanceToCreateRequest(instance, TEMPLATE_AGENT_DEF, TEMPLATE_MEMBER_IDENTITY);
  expect(body.requirements).toEqual({ knowledgeBases: [], mcpServers: [] });
  });
});

describe("mapTemplateToCreateTeamRequest", () => {
  it("[tag:agents-mapper] merges created member ids with manually selected team members", () => {
    const body = mapTemplateToCreateTeamRequest(
      makeTemplateFormValues({ agentInstances: [makeConfiguredTemplateInstance()] }),
      makeIdentity({ name: "Research pod" }),
      ["ag-created-1"],
    );

    expect(body.members).toEqual([
      { memberType: "agent", memberId: "ag-created-1" },
    ]);
    expect(body.name).toBe("Research pod");
  });

  it("[tag:agents-mapper] builds an inline manager from the configured manager instance and template role", () => {
    const body = mapTemplateToCreateTeamRequest(
      makeTemplateFormValues({ orchestrationPattern: "coordinate" }),
      makeIdentity(),
    );

    expect(body.manager).toEqual({
      name: "Manager goal",
      role: "team-manager",
      systemPrompt: "Lead the team",
      modelId: "manager-model",
    });
    expect(body.manager).not.toHaveProperty("temperature");
    expect(body.manager).not.toHaveProperty("maxTokens");
  });

  it("[tag:agents-mapper] omits the manager for sequential orchestration", () => {
    const body = mapTemplateToCreateTeamRequest(makeTemplateFormValues(), makeIdentity());

    expect(body.manager).toBeUndefined();
    expect(body.orchestrationPolicy).toBe("sequential");
  });

  it("[tag:agents-mapper] omits the manager when model, name, or instructions are incomplete", () => {
    const body = mapTemplateToCreateTeamRequest(
      makeTemplateFormValues({
        orchestrationPattern: "coordinate",
        managerInstance: {
          ...makeConfiguredManagerInstance(),
          primaryModel: "",
        },
      }),
      makeIdentity(),
    );

    expect(body.manager).toBeUndefined();
  });

  it("[tag:agents-mapper] maps orchestrationPattern to orchestrationPolicy and omits unsupported values", () => {
    const supported = mapTemplateToCreateTeamRequest(makeTemplateFormValues(), makeIdentity());
    expect(supported.orchestrationPolicy).toBe("sequential");

    const unsupported = mapTemplateToCreateTeamRequest(
      makeTemplateFormValues({
        orchestrationPattern: "unsupported" as AgentTeamOrchestrationPolicy,
      }),
      makeIdentity(),
    );
    expect(unsupported.orchestrationPolicy).toBeUndefined();
  });

  it("[tag:agents-mapper] sends terminationStrategy for coordinate template create", () => {
    const form = makeTemplateFormValues({ orchestrationPattern: "coordinate" });
    form.team.maxIterations = 6;

    const body = mapTemplateToCreateTeamRequest(form, makeIdentity());

    expect(body.terminationStrategy).toEqual({
      type: "maximum_iterations",
      maximum_iterations: 6,
    });
  });

  it("[tag:agents-mapper] omits terminationStrategy for non-coordinate template create", () => {
    const body = mapTemplateToCreateTeamRequest(makeTemplateFormValues(), makeIdentity());
    expect(body.terminationStrategy).toBeUndefined();
  });

  it("[tag:agents-mapper] also includes extra agents and teams selected in the team picker", () => {
    const form = makeTemplateFormValues();
    form.team.agentIds = ["ag-extra"];
    form.team.teamIds = ["agr-extra"];

    const body = mapTemplateToCreateTeamRequest(form, makeIdentity(), ["ag-created-1"]);

    expect(body.members).toEqual([
      { memberType: "agent", memberId: "ag-created-1" },
      { memberType: "agent", memberId: "ag-extra" },
      { memberType: "team", memberId: "agr-extra" },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
} from "./agent-templates.consts";
import type { AgentFormValues, AgentTemplateAgentInstanceValues } from "./agent-form.consts";
import {
  AGENT_NAME_PATTERN_ERROR,
  agentNamePatternError,
  sanitizeAgentName,
} from "./agent-form.consts";
import {
  MANAGER_AGENT_FIELD_PREFIX,
  activeKbRequirements,
  activeMcpRequirements,
  areTemplateRequiredDependenciesAttached,
  buildAgentInstanceFromTemplate,
  buildAgentInstancesFromTemplate,
  buildAgentRequirementsPayload,
  buildManagerInstanceFromTemplate,
  collectSkippedOptionalDependencies,
  collectTemplateAgentSaveErrors,
  collectTemplateManagerSaveErrors,
  deriveTemplateAgentSummary,
  isKbRequirementConfigured,
  isMcpRequirementConfigured,
  isTemplateAgentConfigured,
  isTemplateManagerConfigured,
  mergeFirstTemplateAgentIntoFormValues,
  orchestrationRequiresInlineManager,
  templateAgentFieldPrefix,
  templateOrchestrationToFormValue,
  validateTemplateAgentInstances,
} from "./template-agent.utils";

const AGENT_DEF: AgentTemplateAgentDefinition = {
  name: "Researcher",
  role: "assistant",
  systemPrompt: " Find references ",
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

const TEMPLATE: AgentTemplateDefinition = {
  id: "tmpl-1",
  name: "Research Team",
  description: "Template",
  capabilities: [],
  examples: [],
  instructions: "Template instructions",
  orchestrationPattern: "Sequential",
  model: "claude",
  role: "manager",
  agents: [AGENT_DEF],
};

function configuredInstance(): AgentTemplateAgentInstanceValues {
  const instance = buildAgentInstanceFromTemplate(AGENT_DEF, TEMPLATE.instructions);
  return {
    ...instance,
    primaryModel: "claude",
    name: "Goal",
    instructions: "Instructions",
    satisfiedKbRequirementIds: ["kb-required"],
    satisfiedMcpRequirementIds: ["mcp-required"],
  };
}

describe("template-agent.utils", () => {
  it("maps orchestration to lower-case form value", () => {
    expect(templateOrchestrationToFormValue("Sequential")).toBe("sequential");
    expect(templateOrchestrationToFormValue("Coordinate")).toBe("coordinate");
  });

  it("identifies orchestration patterns that require an inline manager", () => {
    expect(orchestrationRequiresInlineManager("coordinate")).toBe(true);
    expect(orchestrationRequiresInlineManager("route")).toBe(true);
    expect(orchestrationRequiresInlineManager("sequential")).toBe(false);
    expect(orchestrationRequiresInlineManager("concurrent")).toBe(false);
    expect(orchestrationRequiresInlineManager("collaborate")).toBe(false);
    expect(orchestrationRequiresInlineManager(undefined)).toBe(false);
    expect(orchestrationRequiresInlineManager("")).toBe(false);
  });

  it("builds member and manager instances from template defaults", () => {
    const member = buildAgentInstanceFromTemplate(AGENT_DEF, "Fallback");
    // Space-free, backend-valid default name (hyphen separator), no suffix:
    // template agent names are already meaningful and unique within a template.
    expect(member.name).toBe("Researcher");
    expect(member.instructions).toBe("Find references");

    const manager = buildManagerInstanceFromTemplate(TEMPLATE);
    // "Research Team" base is sanitized to "Research-Team".
    expect(manager.name).toBe("Research-Team");
    expect(manager.instructions).toBe("Template instructions");
    expect(buildAgentInstancesFromTemplate(TEMPLATE)).toHaveLength(1);
  });

  it("keeps each member agent's own meaningful name when a template defines multiple", () => {
    const multiAgentTemplate: AgentTemplateDefinition = {
      ...TEMPLATE,
      agents: [AGENT_DEF, { ...AGENT_DEF, name: "Writer" }],
    };

    const instances = buildAgentInstancesFromTemplate(multiAgentTemplate);
    expect(instances[0].name).toBe("Researcher");
    expect(instances[1].name).toBe("Writer");
  });

  it("truncates long base names + caps at the agent-name max length (64)", () => {
    const longBase = "A".repeat(100);
    const name = sanitizeAgentName(longBase);
    expect(name).toHaveLength(64);
    // Result is a valid agent name (no error).
    expect(agentNamePatternError(name)).toBeUndefined();
  });

  it("[tag:agents] flags a manager name with invalid characters (spaces)", () => {
    const errors = collectTemplateManagerSaveErrors(
      { ...configuredInstance(), name: "Triage Agent" },
      "deploy",
    );
    expect(errors.name).toBe(AGENT_NAME_PATTERN_ERROR);
  });

  it("[tag:agents] flags a member agent name with invalid characters", () => {
    const errors = collectTemplateAgentSaveErrors(
      TEMPLATE,
      [{ ...configuredInstance(), name: "Bad Name!" }],
      "deploy",
    );
    expect(errors[0]?.name).toBe(AGENT_NAME_PATTERN_ERROR);
  });

  it("validates manager completeness and returns mode-specific errors", () => {
    expect(isTemplateManagerConfigured(undefined)).toBe(false);
    expect(isTemplateManagerConfigured({ ...configuredInstance() })).toBe(true);

    const deployErrors = collectTemplateManagerSaveErrors(undefined, "deploy");
    const draftErrors = collectTemplateManagerSaveErrors(undefined, "draft");
    expect(deployErrors.name).toContain("deploy");
    expect(draftErrors.name).toContain("draft");
  });

  it("tracks requirement activity and configured state", () => {
    const instance = configuredInstance();
    expect(isKbRequirementConfigured("kb-required", instance)).toBe(true);
    expect(isMcpRequirementConfigured("mcp-required", instance)).toBe(true);

    const trimmed = {
      ...instance,
      removedKbRequirementIds: ["kb-optional"],
      removedMcpRequirementIds: ["mcp-optional"],
    };
    expect(activeKbRequirements(AGENT_DEF.requirements, trimmed)).toHaveLength(1);
    expect(activeMcpRequirements(AGENT_DEF.requirements, trimmed)).toHaveLength(1);
  });

  it("builds unresolved requirements payload and skipped optional dependencies", () => {
    const instance = {
      ...configuredInstance(),
      satisfiedKbRequirementIds: [],
      satisfiedMcpRequirementIds: ["mcp-required"],
    };
    const payload = buildAgentRequirementsPayload(AGENT_DEF, instance);
    expect(payload?.knowledgeBases?.map((x) => x.id)).toEqual(["kb-required", "kb-optional"]);
    expect(payload?.mcpServers?.map((x) => x.id)).toEqual(["mcp-optional"]);

    const skipped = collectSkippedOptionalDependencies(TEMPLATE, [instance]);
    expect(skipped).toEqual([
      { kind: "Knowledge base", label: "Opt KB" },
      { kind: "Toolset", label: "Opt MCP" },
    ]);
  });

  it("derives status/summary and save errors for template agents", () => {
    const bad = buildAgentInstanceFromTemplate(AGENT_DEF, TEMPLATE.instructions);
    const good = configuredInstance();

    expect(isTemplateAgentConfigured(AGENT_DEF, bad)).toBe(false);
    expect(isTemplateAgentConfigured(AGENT_DEF, good)).toBe(true);

    const deployErrors = collectTemplateAgentSaveErrors(TEMPLATE, [bad], "deploy");
    expect(deployErrors[0].knowledgeBases).toContain("Knowledge Bases");
    expect(deployErrors[0].toolsets).toContain("Toolsets");

    const summary = deriveTemplateAgentSummary(AGENT_DEF, good);
    expect(summary.status).toBe("healthy");
    expect(summary.role).toEqual("assistant");
  });

  it("prunes resolved per-agent errors and leaves unresolved ones", () => {
    const previous = {
      0: {
        primaryModel: "required",
        name: "required",
        instructions: "required",
        knowledgeBases: "required",
        toolsets: "required",
      },
    };
    const next = validateTemplateAgentInstances(TEMPLATE, [configuredInstance()], previous);
    expect(next).toEqual({});
  });

  it("keeps unresolved validation errors and clears stale indexes", () => {
    const incomplete = buildAgentInstanceFromTemplate(AGENT_DEF, TEMPLATE.instructions);
    const previous = {
      0: { primaryModel: "required", name: "required" },
      1: { name: "stale" },
    };
    const next = validateTemplateAgentInstances(TEMPLATE, [incomplete], previous);
    expect(next[0]).toMatchObject({ primaryModel: "required" });
    expect(next[1]).toEqual({ name: "stale" });
  });

  it("uses draft-mode error copy for empty name/instructions", () => {
    const bad = {
      ...buildAgentInstanceFromTemplate(AGENT_DEF, TEMPLATE.instructions),
      name: "   ",
      instructions: " ",
    };
    const draftErrors = collectTemplateAgentSaveErrors(TEMPLATE, [bad], "draft");
    expect(draftErrors[0].name).toContain("save the agent as draft");
    expect(draftErrors[0].instructions).toContain("save the agent as draft");
  });

  it("provides stable path helpers and merges first template agent to top-level fields", () => {
    expect(templateAgentFieldPrefix(2)).toBe("template.agentInstances[2]");
    expect(MANAGER_AGENT_FIELD_PREFIX).toBe("template.managerInstance");

    const first = configuredInstance();
    const formValues = {
      template: {
        selectedTemplate: TEMPLATE,
        orchestrationPattern: "sequential",
        managerInstance: first,
        agentInstances: [first],
      },
      primaryModel: "",
      primaryModelParams: first.primaryModelParams,
      fallbackModel: "",
      fallbackModelParams: first.fallbackModelParams,
      goal: "",
      instructions: "",
      knowledgeBases: [],
      toolsets: [],
      enabledFeatures: [],
      featureConfig: first.featureConfig,
    } as unknown as AgentFormValues;

    const merged = mergeFirstTemplateAgentIntoFormValues(formValues);
    expect(merged.goal).toBe("Goal");
    expect(merged.instructions).toBe("Instructions");
    expect(merged.primaryModel).toBe("claude");
  });

  it("drops removed requirements from the active sets and summary role", () => {
    const instance = {
      ...configuredInstance(),
      removedKbRequirementIds: ["kb-required"],
      removedMcpRequirementIds: ["mcp-required"],
    };
    expect(activeKbRequirements(AGENT_DEF.requirements, instance)).toEqual([
      expect.objectContaining({ id: "kb-optional" }),
    ]);
    expect(activeMcpRequirements(AGENT_DEF.requirements, instance)).toEqual([
      expect.objectContaining({ id: "mcp-optional" }),
    ]);
    expect(deriveTemplateAgentSummary({ ...AGENT_DEF, role: "" }, instance).role).toEqual("");
  });

  describe("areTemplateRequiredDependenciesAttached", () => {
    it("returns true when every required KB/MCP is configured", () => {
      expect(
        areTemplateRequiredDependenciesAttached(TEMPLATE, [configuredInstance()]),
      ).toBe(true);
    });

    it("returns false when a required KB is unconfigured", () => {
      const instance = { ...configuredInstance(), satisfiedKbRequirementIds: [] };
      expect(areTemplateRequiredDependenciesAttached(TEMPLATE, [instance])).toBe(false);
    });

    it("returns false when a required MCP server is unconfigured", () => {
      const instance = { ...configuredInstance(), satisfiedMcpRequirementIds: [] };
      expect(areTemplateRequiredDependenciesAttached(TEMPLATE, [instance])).toBe(false);
    });

    it("stays true when an optional dependency is unconfigured", () => {
      const instance = {
        ...configuredInstance(),
        satisfiedKbRequirementIds: ["kb-required"],
        satisfiedMcpRequirementIds: ["mcp-required"],
        // optional ids intentionally left unsatisfied
      };
      expect(areTemplateRequiredDependenciesAttached(TEMPLATE, [instance])).toBe(true);
    });

    it("treats a missing instance as non-blocking", () => {
      expect(areTemplateRequiredDependenciesAttached(TEMPLATE, [])).toBe(true);
    });
  });

  it("collects manager save errors separately from member agent errors", () => {
    const manager = {
      ...buildManagerInstanceFromTemplate(TEMPLATE),
      primaryModel: "",
      name: "",
      instructions: "",
    };
    expect(collectTemplateManagerSaveErrors(manager, "deploy")).toMatchObject({
      primaryModel: expect.any(String),
      name: expect.any(String),
      instructions: expect.any(String),
    });
  });

  it("treats a cleared manager model value as missing", () => {
    const manager = {
      ...buildManagerInstanceFromTemplate(TEMPLATE),
      primaryModel: null as unknown as string,
      goal: "Manager",
      instructions: "Coordinate work",
    };
    expect(collectTemplateManagerSaveErrors(manager, "draft")).toMatchObject({
      primaryModel: expect.any(String),
    });
    expect(isTemplateManagerConfigured(manager)).toBe(false);
  });
});

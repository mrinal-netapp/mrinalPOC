import { describe, expect, it } from "vitest";

import {
  isAgentPlaygroundReady,
  PLAYGROUND_READINESS_MESSAGES,
  type PlaygroundReadinessInput,
} from "./agent-playground-readiness.utils";

const baseTeam: PlaygroundReadinessInput["team"] = {
  orchestrationPattern: "",
  managerName: "",
  managerModel: "",
  managerInstructions: "",
  terminationStrategyType: "maximum_iterations",
  maxIterations: 6,
  agentIds: [],
  teamIds: [],
};

function singleInput(
  overrides: Partial<PlaygroundReadinessInput> = {},
): PlaygroundReadinessInput {
  return {
    configuration: "single",
    primaryModel: "",
    fallbackModel: "",
    team: { ...baseTeam },
    ...overrides,
  };
}

function teamInput(
  team: Partial<PlaygroundReadinessInput["team"]> = {},
): PlaygroundReadinessInput {
  return {
    configuration: "team",
    primaryModel: "",
    fallbackModel: "",
    team: { ...baseTeam, ...team },
  };
}

describe("isAgentPlaygroundReady — requirements gate", () => {
  it("[tag:agents] blocks when a required KB is still incomplete", () => {
    const result = isAgentPlaygroundReady(
      singleInput({
        primaryModel: "m1",
        requirements: {
          knowledgeBases: [{ id: "kb-1", label: "My KB", description: "RAG config missing.", required: true }],
        },
      }),
      true,
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needRequirements);
  });

  it("[tag:agents] blocks when a required MCP server is still incomplete", () => {
    const result = isAgentPlaygroundReady(
      singleInput({
        primaryModel: "m1",
        requirements: {
          mcpServers: [{ id: "ms-1", label: "My MCP", description: "Auth missing.", required: true }],
        },
      }),
      true,
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needRequirements);
  });

  it("[tag:agents] does not block when all requirement items are optional (required: false)", () => {
    const result = isAgentPlaygroundReady(
      singleInput({
        primaryModel: "m1",
        requirements: {
          knowledgeBases: [{ id: "kb-1", label: "My KB", description: "Optional.", required: false }],
          mcpServers: [{ id: "ms-1", label: "My MCP", description: "Optional.", required: false }],
        },
      }),
      true,
    );
    expect(result.ready).toBe(true);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.ready);
  });

  it("[tag:agents] does not block when requirements is absent", () => {
    const result = isAgentPlaygroundReady(singleInput({ primaryModel: "m1" }), true);
    expect(result.ready).toBe(true);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.ready);
  });

  it("[tag:agents] does not block when requirements object is present but both arrays are empty", () => {
    const result = isAgentPlaygroundReady(
      singleInput({
        primaryModel: "m1",
        requirements: { knowledgeBases: [], mcpServers: [] },
      }),
      true,
    );
    expect(result.ready).toBe(true);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.ready);
  });

  it("[tag:agents] still blocks on saveFirst before checking requirements", () => {
    const result = isAgentPlaygroundReady(
      singleInput({
        primaryModel: "m1",
        requirements: {
          knowledgeBases: [{ id: "kb-1", label: "KB", description: "Missing.", required: true }],
        },
      }),
      false,
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.saveFirst);
  });
});

describe("isAgentPlaygroundReady", () => {
  it("[tag:agents] blocks until the agent is saved (edit mode)", () => {
    const result = isAgentPlaygroundReady(
      singleInput({ primaryModel: "m1", fallbackModel: "m2" }),
      false,
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.saveFirst);
  });

  describe("single agent", () => {
    it("[tag:agents] requires a primary model (fallback is optional)", () => {
      const result = isAgentPlaygroundReady(singleInput(), true);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needPrimaryModel);
    });

    it("[tag:agents] reports missing primary when only fallback is set", () => {
      const result = isAgentPlaygroundReady(singleInput({ fallbackModel: "m2" }), true);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needPrimaryModel);
    });

    it("[tag:agents] is ready with only a primary model set (no fallback required)", () => {
      const result = isAgentPlaygroundReady(singleInput({ primaryModel: "m1" }), true);
      expect(result.ready).toBe(true);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.ready);
    });

    it("[tag:agents] is ready when both primary and fallback models are set", () => {
      const result = isAgentPlaygroundReady(
        singleInput({ primaryModel: "m1", fallbackModel: "m2" }),
        true,
      );
      expect(result.ready).toBe(true);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.ready);
    });

    it("[tag:agents] treats whitespace-only primary selection as empty", () => {
      const result = isAgentPlaygroundReady(
        singleInput({ primaryModel: "  ", fallbackModel: "m2" }),
        true,
      );
      expect(result.ready).toBe(false);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needPrimaryModel);
    });
  });

  describe("team agent", () => {
    it("[tag:agents] requires an orchestration pattern first", () => {
      const result = isAgentPlaygroundReady(teamInput({ managerModel: "mdl-1" }), true);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needOrchestration);
    });

    it("[tag:agents] requires a manager model when orchestration is coordinate", () => {
      const result = isAgentPlaygroundReady(
        teamInput({ orchestrationPattern: "coordinate" }),
        true,
      );
      expect(result.ready).toBe(false);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needManager);
    });

    it("[tag:agents] does not require a manager model when orchestration is not coordinate", () => {
      const result = isAgentPlaygroundReady(
        teamInput({ orchestrationPattern: "sequential", agentIds: ["ag-1"] }),
        true,
      );
      expect(result.ready).toBe(true);
    });

    it("[tag:agents] requires at least one agent or team member", () => {
      const result = isAgentPlaygroundReady(
        teamInput({ orchestrationPattern: "coordinate", managerModel: "mdl-1" }),
        true,
      );
      expect(result.ready).toBe(false);
      expect(result.reason).toBe(PLAYGROUND_READINESS_MESSAGES.needMember);
    });

    it("[tag:agents] is ready with a member agent", () => {
      const result = isAgentPlaygroundReady(
        teamInput({
          orchestrationPattern: "coordinate",
          managerModel: "mdl-1",
          agentIds: ["ag-2"],
        }),
        true,
      );
      expect(result.ready).toBe(true);
    });

    it("[tag:agents] is ready with a nested team", () => {
      const result = isAgentPlaygroundReady(
        teamInput({
          orchestrationPattern: "sequential",
          teamIds: ["agr-2"],
        }),
        true,
      );
      expect(result.ready).toBe(true);
    });
  });
});

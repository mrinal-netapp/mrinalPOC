import { describe, expect, it } from "vitest";
import type {
  Agent,
  AgentTeamMember,
} from "@/routes/pages/agents/api/agents-config.types";

import {
  hasBlockingMemberRequirements,
  hasBlockingRequirements,
} from "./agent-requirements.utils";

const requirement = (required: boolean) => ({
  id: "11111111-1111-4111-8111-111111111111",
  label: "Resource",
  description: "",
  required,
});

const teamMember = (memberType: AgentTeamMember["memberType"], memberId: string): AgentTeamMember => ({
  memberType,
  memberId,
});

const agentWithRequirements = (id: string, required: boolean): Agent =>
  ({
    id,
    requirements: { knowledgeBases: [requirement(required)] },
  }) as Agent;

describe("hasBlockingRequirements", () => {
  it("returns false for undefined / null requirements", () => {
    expect(hasBlockingRequirements(undefined)).toBe(false);
    expect(hasBlockingRequirements(null)).toBe(false);
  });

  it("returns false for empty requirement lists", () => {
    expect(hasBlockingRequirements({ knowledgeBases: [], mcpServers: [] })).toBe(false);
  });

  it("returns false when only optional placeholders remain", () => {
    expect(
      hasBlockingRequirements({
        knowledgeBases: [requirement(false)],
        mcpServers: [requirement(false)],
      }),
    ).toBe(false);
  });

  it("returns true when a required knowledge base placeholder is present", () => {
    expect(
      hasBlockingRequirements({ knowledgeBases: [requirement(true)] }),
    ).toBe(true);
  });

  it("returns true when a required MCP server placeholder is present", () => {
    expect(hasBlockingRequirements({ mcpServers: [requirement(true)] })).toBe(true);
  });
});

describe("hasBlockingMemberRequirements", () => {
  it("returns false when members or agents are missing", () => {
    expect(hasBlockingMemberRequirements(undefined, [])).toBe(false);
    expect(hasBlockingMemberRequirements([], undefined)).toBe(false);
  });

  it("returns false when only team members are present", () => {
    expect(
      hasBlockingMemberRequirements(
        [teamMember("team", "agr-1")],
        [agentWithRequirements("ag-1", true)],
      ),
    ).toBe(false);
  });

  it("returns false when direct single-agent members have no blocking requirements", () => {
    expect(
      hasBlockingMemberRequirements(
        [teamMember("agent", "ag-1")],
        [agentWithRequirements("ag-1", false)],
      ),
    ).toBe(false);
  });

  it("returns true when a direct single-agent member has blocking requirements", () => {
    expect(
      hasBlockingMemberRequirements(
        [teamMember("agent", "ag-1")],
        [
          ({
            id: "ag-1",
            requirements: { mcpServers: [requirement(true)] },
          }) as Agent,
        ],
      ),
    ).toBe(true);
  });
});

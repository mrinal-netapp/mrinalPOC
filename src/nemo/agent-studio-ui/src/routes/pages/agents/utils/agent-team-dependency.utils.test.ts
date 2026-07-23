import { describe, expect, it } from "vitest";

import {
  getSingleAgentTeamDependencyCount,
  getTeamDependentsCountFromPage,
  getTeamAgentTeamDependencyCount,
  getTeamDependentsCount,
} from "./agent-team-dependency.utils";

describe("agent team dependency utils", () => {
  it("returns zero when summary is missing", () => {
    expect(getTeamDependentsCount(undefined)).toBe(0);
  });

  it("counts team dependents across kind key variants", () => {
    expect(
      getTeamDependentsCount({
        byKind: {
          "agent-team": 1,
          agent_team: 2,
          team: 3,
          agent: 4,
        },
      }),
    ).toBe(6);
  });

  it("single-agent dependency prefers the higher of associated teams and summary", () => {
    expect(
      getSingleAgentTeamDependencyCount({
        associatedResources: {
          knowledgeBases: [],
          agentTeams: [{ id: "agr-1", name: "Parent Team" }],
        },
        dependentsSummary: {
          byKind: {
            "agent-team": 3,
          },
        },
      }),
    ).toBe(3);
  });

  it("team-agent dependency is derived from team dependents only", () => {
    expect(
      getTeamAgentTeamDependencyCount({
        dependentsSummary: {
          byKind: {
            "agent-team": 2,
            agent: 9,
          },
        },
      }),
    ).toBe(2);
  });

  it("counts team dependents from dependents page totalByKind", () => {
    expect(
      getTeamDependentsCountFromPage({
        totalByKind: {
          agent_team: 2,
          agent: 4,
        },
      }),
    ).toBe(2);
  });

  it("defensively ignores non-numeric team counts", () => {
    expect(
      getTeamDependentsCount({
        byKind: {
          // A malformed backend payload where the count is not a number must
          // contribute 0 rather than corrupting the sum (or throwing).
          "agent-team": "oops" as unknown as number,
          team: 2,
        },
      }),
    ).toBe(2);
  });
});

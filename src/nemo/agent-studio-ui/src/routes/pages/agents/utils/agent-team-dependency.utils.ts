import type {
  Agent,
  AgentTeam,
  DependentsPage,
  DependentsSummary,
} from "@/routes/pages/agents/api/agents-config.types";

function normalizeKind(kind: string): string {
  return kind.toLowerCase().replace(/[\s_-]/g, "");
}

function isTeamKind(kind: string): boolean {
  const normalized = normalizeKind(kind);
  return normalized === "agentteam" || normalized === "team";
}

function countTeamByKind(byKind?: Record<string, number>): number {
  if (!byKind) return 0;
  return Object.entries(byKind).reduce((count, [kind, value]) => {
    if (!isTeamKind(kind)) return count;
    return count + (typeof value === "number" ? value : 0);
  }, 0);
}

/**
 * Counts "team" dependents from the backend dependents summary payload.
 * We normalize key variants defensively because backend kind naming is not
 * guaranteed to be stable across services (`agent-team` vs `agent_team`).
 */
function getTeamDependentsCount(summary?: DependentsSummary): number {
  return countTeamByKind(summary?.byKind);
}

function getTeamDependentsCountFromPage(page?: Pick<DependentsPage, "totalByKind">): number {
  return countTeamByKind(page?.totalByKind);
}

function getSingleAgentTeamDependencyCount(
  agent: Pick<Agent, "associatedResources" | "dependentsSummary">,
): number {
  const parentTeamsCount = agent.associatedResources?.agentTeams?.length ?? 0;
  const summaryCount = getTeamDependentsCount(agent.dependentsSummary);
  return Math.max(parentTeamsCount, summaryCount);
}

function getTeamAgentTeamDependencyCount(
  team: Pick<AgentTeam, "dependentsSummary">,
): number {
  return getTeamDependentsCount(team.dependentsSummary);
}

export {
  getSingleAgentTeamDependencyCount,
  getTeamAgentTeamDependencyCount,
  getTeamDependentsCount,
  getTeamDependentsCountFromPage,
};

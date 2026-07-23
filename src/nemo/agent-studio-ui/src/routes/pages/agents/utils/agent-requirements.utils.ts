import type { AgentRequirements } from "@/routes/pages/agents/api/agents-config.types";
import type {
  Agent,
  AgentTeamMember,
} from "@/routes/pages/agents/api/agents-config.types";

/**
 * True when the agent has at least one **required** unresolved KB/MCP
 * placeholder. Required placeholders block deploy until they are configured or
 * removed; optional placeholders do not.
 *
 * This is the single source of truth shared by every deploy-gating surface
 * (agents landing page row action + agent details page) so they cannot drift
 * from each other or from the create/edit form's equivalent
 * `hasBlockingUnresolvedDependencies` check.
 */
export function hasBlockingRequirements(
  requirements?: AgentRequirements | null,
): boolean {
  return Boolean(
    requirements?.knowledgeBases?.some((requirement) => requirement.required) ||
      requirements?.mcpServers?.some((requirement) => requirement.required),
  );
}

/**
 * True when any direct single-agent member of a team has unresolved required
 * KB/MCP placeholders. Team payloads don't carry member requirement details, so
 * callers provide the project's single-agent rows (`agents`) and we resolve
 * member ids against that list.
 */
export function hasBlockingMemberRequirements(
  members: readonly AgentTeamMember[] | undefined,
  agents: readonly Agent[] | undefined,
): boolean {
  if (!members?.length || !agents?.length) return false;

  const blockingAgentIds = new Set(
    agents
      .filter((agent) => hasBlockingRequirements(agent.requirements))
      .map((agent) => agent.id),
  );
  if (blockingAgentIds.size === 0) return false;

  return members.some(
    (member) =>
      member.memberType === "agent" && blockingAgentIds.has(member.memberId),
  );
}

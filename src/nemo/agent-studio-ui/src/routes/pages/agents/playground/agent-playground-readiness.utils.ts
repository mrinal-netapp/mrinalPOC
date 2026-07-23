import type { AgentConfiguration, AgentResourceRequirement, AgentTeamValues } from "@/routes/pages/agents/create-edit/form/agent-form.consts";

/**
 * Canonical human-readable reasons the playground is disabled.
 * Exported so test assertions don't duplicate the strings.
 */
export const PLAYGROUND_READINESS_MESSAGES = {
  saveFirst: "Save the agent first to use the playground.",
  needPrimaryModel: "Select a model to enable the playground.",
  needOrchestration: "Select an orchestration pattern to enable the playground.",
  needManager: "Add a manager agent to enable the playground.",
  needMember: "Add at least one agent or team to enable the playground.",
  needRequirements: "Configure all required knowledge bases and MCP servers before deploying.",
  ready: null,
} as const;

export interface PlaygroundReadinessInput {
  configuration: AgentConfiguration;
  primaryModel: string;
  fallbackModel: string;
  team: AgentTeamValues;
  /**
   * Incomplete KB / MCP entries. Any item with `required: true` blocks
   * deployment until the user completes the configuration.
   */
  requirements?: {
    knowledgeBases?: AgentResourceRequirement[];
    mcpServers?: AgentResourceRequirement[];
  };
}

/** @deprecated Use `PlaygroundReadinessInput` */
export type AgentPlaygroundReadinessInput = PlaygroundReadinessInput;

export interface AgentPlaygroundReadiness {
  ready: boolean;
  /** Human-readable reason the playground is disabled, or null when ready. */
  reason: string | null;
}

/**
 * Derives whether the in-form playground panel should be interactive.
 *
 * The playground always requires `isEdit` (an already-saved agent) because the
 * runtime invokes the persisted agent, not the unsaved form state.
 *
 * Beyond that, per configuration type:
 *  - "single"        → a primary model must be selected
 *  - "team"          → orchestration pattern + at least one member (agent or
 *                      team) must be configured; when pattern is "coordinate"
 *                      a manager model must also be selected
 *  - "from_template" → always ready once saved (model is baked into the template)
 */
export function isAgentPlaygroundReady(
  input: PlaygroundReadinessInput,
  isEdit: boolean,
): AgentPlaygroundReadiness {
  if (!isEdit) {
    return { ready: false, reason: PLAYGROUND_READINESS_MESSAGES.saveFirst };
  }

  // Block deployment when any required KB or MCP server is still incomplete.
  const hasBlockingRequirements =
    input.requirements?.knowledgeBases?.some((r) => r.required) ||
    input.requirements?.mcpServers?.some((r) => r.required);
  if (hasBlockingRequirements) {
    return { ready: false, reason: PLAYGROUND_READINESS_MESSAGES.needRequirements };
  }

  const { configuration, primaryModel, team } = input;

  if (configuration === "single") {
    if (!primaryModel?.trim()) {
      return { ready: false, reason: PLAYGROUND_READINESS_MESSAGES.needPrimaryModel };
    }
    return { ready: true, reason: PLAYGROUND_READINESS_MESSAGES.ready };
  }

  if (configuration === "team") {
    if (!team.orchestrationPattern?.trim()) {
      return { ready: false, reason: PLAYGROUND_READINESS_MESSAGES.needOrchestration };
    }
    if (team.orchestrationPattern === "coordinate" && !team.managerModel?.trim()) {
      return { ready: false, reason: PLAYGROUND_READINESS_MESSAGES.needManager };
    }
    const hasMembers = team.agentIds.length > 0 || team.teamIds.length > 0;
    if (!hasMembers) {
      return { ready: false, reason: PLAYGROUND_READINESS_MESSAGES.needMember };
    }
    return { ready: true, reason: PLAYGROUND_READINESS_MESSAGES.ready };
  }

  // "from_template" — template bakes in the model; playground is ready once saved
  return { ready: true, reason: PLAYGROUND_READINESS_MESSAGES.ready };
}

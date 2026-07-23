// FE display types for the Agents landing page. The two enums below are
// re-exported straight from the API contract so the list / detail surfaces
// can't drift from the wire format. Cell renderers translate the raw enum
// value to a human-readable label via `formatDeploymentStatusLabel` in
// `utils/agents.utils.ts`.

import type {
  AgentDeploymentStatus as ApiAgentDeploymentStatus,
  AgentStatus as ApiAgentStatus,
} from "@/routes/pages/agents/api/agents-config.types";

/** Health pill — `'Healthy' | 'Unhealthy'`. */
export type AgentHealthStatus = ApiAgentStatus;

/**
 * Detailed deployment lifecycle. Eight values, lowercase on the wire.
 * Keep in sync with the OpenAPI enum (PR #33).
 */
export type AgentDeploymentStatus = ApiAgentDeploymentStatus;

export interface AssociatedResource {
  id: string;
  name: string;
  kind: "agent" | "knowledge-base" | "agent-team" | "mcp-server";
}

interface AgentBase {
  id: string;
  name: string;
  status: AgentHealthStatus;
  models: string[];
  lastUpdated: string;
  deploymentStatus: AgentDeploymentStatus;
  /**
   * True when the agent has a required, unresolved KB/MCP placeholder that
   * blocks deploy. Only single agents populate this today (team payloads do
   * not carry member requirements); it stays `undefined` for team rows.
   */
  hasBlockingRequirements?: boolean;
}

export interface SingleAgent extends AgentBase {
  associatedResources: AssociatedResource[];
}

export interface TeamAgent extends AgentBase {
  associatedAgents: AssociatedResource[];
}

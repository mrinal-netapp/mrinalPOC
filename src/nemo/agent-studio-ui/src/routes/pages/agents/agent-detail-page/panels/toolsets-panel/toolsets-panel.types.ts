import type { AssociatedResource } from "../../../agents.types";

/**
 * Where the toolset runs. "Local" means the MCP server is hosted alongside
 * the agent; "Remote" means it's reached over the network.
 */
export type ToolsetType = "Local" | "Remote";

/**
 * Health of the toolset connection / its last probe. Mirrors the same two
 * states the agents list uses but kept as its own alias so the toolsets
 * domain can evolve independently (e.g. add "Degraded" later) without
 * dragging agents along.
 */
export type ToolsetHealthStatus = "Healthy" | "Unhealthy";

/**
 * One row in the Toolsets tab of the Agent details page.
 *
 * Column ←→ field mapping (screenshot order):
 *   Name              → `name`
 *   Type              → `type`
 *   Status            → `status`
 *   Associated agents → `associatedAgents` (rendered with `+N` overflow)
 *   Labels            → `labels`
 *   Actions           → kebab menu (View details / Deprecate / Edit / Delete)
 */
export interface ToolsetRow {
  id: string;
  name: string;
  type: ToolsetType;
  status: ToolsetHealthStatus;
  associatedAgents: AssociatedResource[];
  labels: string[];
}

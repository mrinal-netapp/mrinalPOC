import { IconCircleCheck, IconCircleX } from "@tabler/icons-react";

import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";
import type { ToolsetHealthStatus } from "./toolsets-panel.types";

// Visual map for the Toolset Status column. Mirrors the shape used by
// `agents.utils.ts` so the StatusIcon component can render it. Kept in
// the toolsets folder (not in agents.utils.ts) so the toolsets domain
// can diverge later — e.g. add a "Degraded" state — without dragging
// agents along.
const TOOLSET_STATUS_VISUAL: Record<ToolsetHealthStatus, StatusVisualConfig> = {
  Healthy: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Unhealthy: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
};

function getToolsetStatusVisual(status: ToolsetHealthStatus): StatusVisualConfig {
  return TOOLSET_STATUS_VISUAL[status];
}

export { getToolsetStatusVisual };

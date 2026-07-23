import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClock,
  IconLoader2,
  IconPencil,
  IconPlayerStop,
} from "@tabler/icons-react";

import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";
import type {
  AgentDeploymentStatus,
  AgentHealthStatus,
} from "@/routes/pages/agents/agents.types";

const HEALTH_STATUS_VISUAL: Record<AgentHealthStatus, StatusVisualConfig> = {
  Healthy: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Unhealthy: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
};

// One row per value in the API enum (`AgentDeploymentStatus` — PR #33).
// `not_deployed` is shown as a neutral dashed circle to distinguish it from
// `draft` (a pencil) — the former is "no deployment ever happened" while the
// latter is an explicit user-saved draft state.
const DEPLOYMENT_STATUS_VISUAL: Record<AgentDeploymentStatus, StatusVisualConfig> = {
  draft: { type: "icon", Icon: IconPencil, color: "var(--text-secondary)" },
  preview: { type: "icon", Icon: IconClock, color: "var(--text-secondary)" },
  not_deployed: { type: "icon", Icon: IconCircleDashed, color: "var(--text-secondary)" },
  deploying: { type: "icon", Icon: IconLoader2, color: "var(--notification-info)" },
  deployed: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  failed: { type: "icon", Icon: IconAlertTriangle, color: "var(--notification-error)" },
  terminating: { type: "icon", Icon: IconLoader2, color: "var(--notification-warning)" },
  terminated: { type: "icon", Icon: IconPlayerStop, color: "var(--text-secondary)" },
};

// Wire-format → display-format. The API ships lowercase / snake_case values
// (`not_deployed`); the UI renders them in sentence case with spaces.
const DEPLOYMENT_STATUS_LABELS: Record<AgentDeploymentStatus, string> = {
  draft: "Draft",
  preview: "Preview",
  not_deployed: "Not deployed",
  deploying: "Deploying",
  deployed: "Deployed",
  failed: "Failed",
  terminating: "Terminating",
  terminated: "Terminated",
};

function getAgentHealthVisual(status: AgentHealthStatus): StatusVisualConfig {
  return HEALTH_STATUS_VISUAL[status];
}

function getAgentDeploymentVisual(status: AgentDeploymentStatus): StatusVisualConfig {
  return DEPLOYMENT_STATUS_VISUAL[status];
}

function formatDeploymentStatusLabel(status: AgentDeploymentStatus): string {
  return DEPLOYMENT_STATUS_LABELS[status];
}

export {
  formatDeploymentStatusLabel,
  getAgentDeploymentVisual,
  getAgentHealthVisual,
};

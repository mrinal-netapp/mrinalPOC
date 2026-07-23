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

import type {
  AgentDeploymentStatus,
  AgentHealthStatus,
} from "../agents.types";
import type { AgentStatusPresentation } from "./agent-detail-page.types";

// Toggle to show/hide the "Configurations" tab on the agent details page.
// The tab mirrors the create/edit Configuration section read-only (single
// agents). Flip to `true` to show it again. Mirrors `SHOW_AGENT_METRICS_ROW`
// in overview-panel.consts.ts.
export const SHOW_AGENT_CONFIGURATIONS_TAB = false;

export const AGENT_DETAIL_STRINGS = {
  PAGE_TITLE: "Agent details",
  BREADCRUMB_ROOT: "Agents",
  ACTION_REFRESH: "Refresh",
  REFRESH_SUCCESS: "Agent details refreshed.",
  REFRESH_ERROR: "Failed to refresh agent details.",
  ACTION_EDIT: "Edit",
  ACTION_MENU: "Actions",
  ACTION_DEPLOY: "Deploy",
  DEPLOY_SUCCESS: "Agent deployed.",
  DEPLOY_ERROR: "Failed to deploy agent.",
  DEPLOY_BLOCKED_REQUIREMENTS:
    "Configure or remove the required knowledge bases and toolsets before deploying.",
  ACTION_DRAFT: "Draft",
  DRAFT_SUCCESS: "Agent moved to draft.",
  DRAFT_ERROR: "Failed to move agent to draft.",
  ACTION_DEPRECATE: "Deprecate",
  DEPRECATE_SUCCESS: "Agent deprecated.",
  ACTION_UNDEPRECATE: "Undeprecate",
  UNDEPRECATE_SUCCESS: "Agent undeprecated.",
  ACTION_DELETE: "Delete",
  DELETE_CONFIRM_TITLE: "Delete agent",
  DELETE_CONFIRM_LABEL: "Delete",
  DELETE_SUCCESS: "Agent deleted.",
  DELETE_ERROR: "Failed to delete agent.",
  ACTION_VALIDATE: "Validate connection",
  ACTION_DUPLICATE: "Duplicate",
  TAB_OVERVIEW: "Overview",
  TAB_TOOLSETS: "Toolsets",
  TAB_CONFIGURATIONS: "Configurations",
  TAB_ASSIGNED_KB: "Assigned knowledge bases",
  SUMMARY_NAME: "Name",
  SUMMARY_STATUS: "Status",
  SUMMARY_DEPLOYMENT: "Deployment status",
  SUMMARY_MODELS: "Models",
  SUMMARY_LAST_UPDATED: "Last time updated",
  NOT_FOUND_TITLE: "Agent not found.",
  NOT_FOUND_BACK: "Back to Agents",
  ERROR_TITLE: "Failed to load agent.",
} as const;

export const HEALTH_STATUS_MAP: Record<AgentHealthStatus, AgentStatusPresentation> = {
  Healthy: {
    label: "Healthy",
    icon: IconCircleCheck,
    className: "agent-detail__status--healthy",
  },
  Unhealthy: {
    label: "Unhealthy",
    icon: IconCircleX,
    className: "agent-detail__status--error",
  },
};

// All eight deployment-status values from the API enum (PR #33). `draft` and
// `not_deployed` share the secondary-text styling but use different icons —
// the former is an explicit user-saved state, the latter means the agent has
// never been deployed.
export const DEPLOYMENT_STATUS_MAP: Record<AgentDeploymentStatus, AgentStatusPresentation> = {
  draft: {
    label: "Draft",
    icon: IconPencil,
    className: "agent-detail__status--draft",
  },
  preview: {
    label: "Preview",
    icon: IconClock,
    className: "agent-detail__status--draft",
  },
  not_deployed: {
    label: "Not deployed",
    icon: IconCircleDashed,
    className: "agent-detail__status--draft",
  },
  deploying: {
    label: "Deploying",
    icon: IconLoader2,
    className: "agent-detail__status--draft",
  },
  deployed: {
    label: "Deployed",
    icon: IconCircleCheck,
    className: "agent-detail__status--healthy",
  },
  failed: {
    label: "Failed",
    icon: IconAlertTriangle,
    className: "agent-detail__status--error",
  },
  terminating: {
    label: "Terminating",
    icon: IconLoader2,
    className: "agent-detail__status--draft",
  },
  terminated: {
    label: "Terminated",
    icon: IconPlayerStop,
    className: "agent-detail__status--draft",
  },
};

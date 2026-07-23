import type { Icon } from "@tabler/icons-react";

import type { AgentDeploymentStatus, AgentHealthStatus } from "../agents.types";
import type {
  AgentConfigurationFeature,
  AgentFeatureKey,
} from "../create-edit/form/agent-form.consts";

/**
 * Agent kind shown in the Type field of the summary + Details card.
 * Single-agent → mapped from `Agent` (config-service `/agents/{id}`).
 * Team-agent → mapped from `AgentTeam` (`/agent-teams/{id}`).
 */
export type AgentKind = "Single-agent" | "Team-agent";

/**
 * Profile section: the agent's behavioural spec rendered above the Details
 * card on the Overview tab.
 */
export interface AgentProfile {
  role: string;
  goal: string;
  /** Numbered behaviour rules — rendered as an ordered list. */
  instructions: string[];
}

/**
 * Headline metrics surfaced as the three KPI tiles on the Overview tab.
 * Stored as raw numbers; the panel formats them via `Intl.NumberFormat`
 * (see I18-002 in the workspace rules).
 */
export interface AgentMetrics {
  activeUsers: number;
  conversations: number;
  successRatePercent: number;
}

export interface AgentRelatedCounts {
  toolsets: number;
  configurations: number;
  assignedKnowledgeBases: number;
}

/**
 * The agent's feature configuration, mirrored from the create/edit
 * Configuration section so the details page can render the same cards
 * read-only. Undefined for team agents (which have no single-agent feature
 * cards) — the Configurations panel falls back to its placeholder then.
 */
export interface AgentConfigurationSummary {
  enabledFeatures: AgentFeatureKey[];
  featureConfig: AgentConfigurationFeature;
}

/**
 * Full payload for the Agent details page. Built from the config-service
 * agents/agent-teams payloads via `agents-api-mapper.ts`.
 */
export interface AgentDetail {
  id: string;
  name: string;
  status: AgentHealthStatus;
  deploymentStatus: AgentDeploymentStatus;
  models: string[];
  type: AgentKind;
  description: string;
  labels: string[];
  lastUpdatedISO: string;
  createdISO: string;
  profile: AgentProfile;
  metrics: AgentMetrics;
  related: AgentRelatedCounts;
  /** Read-only feature configuration for the Configurations tab. */
  configuration?: AgentConfigurationSummary;
  /**
   * True when the (single) agent has a required, unresolved KB/MCP placeholder
   * that blocks deploy. Undefined for team agents.
   */
  hasBlockingRequirements?: boolean;
}

/**
 * Visual mapping for a status badge: the icon component to render plus a CSS
 * modifier class that drives its colour. The icon is stored as a component
 * reference (not a pre-rendered element) so the data file stays JSX-free and
 * the caller controls sizing. Mirrors the `ModelStatusPresentation` shape used
 * by the Model details page (PR #298).
 */
export interface AgentStatusPresentation {
  label: string;
  icon: Icon;
  className: string;
}

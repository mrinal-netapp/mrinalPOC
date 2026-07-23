import type { AgentDetail } from "../../agent-detail-page.types";

export type TimeRangeOption =
  | "Last hour"
  | "Last 24 hours"
  | "Last 7 days"
  | "Last month"
  | "Last 3 months";

export interface OverviewPanelProps {
  detail: AgentDetail;
  /** Pre-formatted "last updated" string from the parent (locale-aware). */
  lastUpdatedFormatted: string;
  /** Pre-formatted "created" string from the parent (locale-aware). */
  createdFormatted: string;
}

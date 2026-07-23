import type { TimeRangeOption } from "./overview-panel.types";

// Toggle to show/hide the metrics row (Active users / Conversations /
// Success rate) and its filter bar on the agent details Overview tab.
// Off by default — flip to `true` once the upstream telemetry endpoints
// are wired and `agents-api-mapper.ts` returns real numbers instead of
// zeros. The filter bar is gated alongside the row because its
// time-range chip and collapse toggle exist solely for the metrics row.
export const SHOW_AGENT_METRICS_ROW = false;

export const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  "Last hour",
  "Last 24 hours",
  "Last 7 days",
  "Last month",
  "Last 3 months",
];

export const OVERVIEW_PANEL_STRINGS = {
  FILTERS_LABEL: "Filters:",
  FILTER_TIME_RANGE: "Time range",
  CLEAR_TIME_RANGE: "Clear time range filter",
  TOGGLE_COLLAPSE_EXPAND: "Expand metrics",
  TOGGLE_COLLAPSE_COLLAPSE: "Collapse metrics",
  METRIC_ACTIVE_USERS: "Active users",
  METRIC_CONVERSATIONS: "Conversations",
  METRIC_SUCCESS_RATE: "Success rate",
  DETAIL_NAME: "Name",
  DETAIL_DESCRIPTION: "Description",
  DETAIL_LABELS: "Labels",
  DETAIL_TYPE: "Type",
  DETAIL_MODELS: "Models",
  DETAIL_LAST_UPDATED: "Last time updated",
  DETAIL_CREATED: "Created",
} as const;

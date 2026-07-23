import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@test/render";
import type { AgentDetail } from "../../agent-detail-page.types";

// Force the flag ON for this whole file so the metrics row + filter
// bar (gated by SHOW_AGENT_METRICS_ROW in overview-panel.consts) is
// rendered and we can assert on it. Once the upstream telemetry
// endpoints land the constant flips on permanently and these tests
// converge with the "metrics-off" baseline.
vi.mock("./overview-panel.consts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./overview-panel.consts")>();
  return {
    ...actual,
    SHOW_AGENT_METRICS_ROW: true,
  };
});

import { OverviewPanel } from "./overview-panel";
import { OVERVIEW_PANEL_STRINGS } from "./overview-panel.consts";

const MOCK_DETAIL: AgentDetail = {
  id: "ag-001",
  name: "Customer support agent",
  status: "Healthy",
  deploymentStatus: "deployed",
  models: ["gpt-4-turbo"],
  type: "Single-agent",
  description: "Handles tier-1 customer support.",
  labels: ["Production"],
  lastUpdatedISO: "2026-02-10T07:15:06Z",
  createdISO: "2025-11-04T09:30:00Z",
  profile: { role: "Specialist", goal: "Resolve quickly.", instructions: [] },
  metrics: { activeUsers: 128, conversations: 4_320, successRatePercent: 92.4 },
  related: { toolsets: 4, configurations: 2, assignedKnowledgeBases: 3 },
};

function renderOverviewPanel() {
  return renderWithProviders(
    <OverviewPanel
      detail={MOCK_DETAIL}
      lastUpdatedFormatted="Feb 10, 2026, 7:15:06 AM"
      createdFormatted="Nov 4, 2025, 9:30:00 AM"
    />,
  );
}

describe("OverviewPanel (metrics row on)", () => {
  it(
    "[tag:agent-overview][tag:metrics-flag] renders the metrics row when SHOW_AGENT_METRICS_ROW=true",
    () => {
      renderOverviewPanel();

      expect(
        screen.getByText(OVERVIEW_PANEL_STRINGS.METRIC_ACTIVE_USERS),
      ).toBeInTheDocument();
      expect(
        screen.getByText(OVERVIEW_PANEL_STRINGS.METRIC_CONVERSATIONS),
      ).toBeInTheDocument();
      expect(
        screen.getByText(OVERVIEW_PANEL_STRINGS.METRIC_SUCCESS_RATE),
      ).toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-overview][tag:metrics-flag] shows the filter chip with the default time range",
    () => {
      renderOverviewPanel();
      // Default selection is "Last month" — chip reads "Time range: Last month".
      expect(
        screen.getByText(/Time range:\s*Last month/i),
      ).toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-overview][tag:metrics-flag] clear-button on the chip resets the selection to the bare label",
    async () => {
      renderOverviewPanel();
      const user = userEvent.setup({ delay: null });

      await user.click(
        screen.getByLabelText(OVERVIEW_PANEL_STRINGS.CLEAR_TIME_RANGE),
      );

      // After clearing, the chip falls back to "Time range" (no value).
      expect(
        screen.queryByText(/Time range:\s*Last month/i),
      ).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-overview][tag:metrics-flag] collapse toggle hides the metrics row",
    async () => {
      renderOverviewPanel();
      const user = userEvent.setup({ delay: null });

      // Initial state shows the row.
      expect(
        screen.getByText(OVERVIEW_PANEL_STRINGS.METRIC_ACTIVE_USERS),
      ).toBeInTheDocument();

      await user.click(
        screen.getByLabelText(OVERVIEW_PANEL_STRINGS.TOGGLE_COLLAPSE_COLLAPSE),
      );

      // After collapsing, the metric subtitle is no longer in the DOM.
      expect(
        screen.queryByText(OVERVIEW_PANEL_STRINGS.METRIC_ACTIVE_USERS),
      ).not.toBeInTheDocument();
    },
  );
});

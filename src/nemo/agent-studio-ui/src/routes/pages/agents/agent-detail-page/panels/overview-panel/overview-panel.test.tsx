import { screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { renderWithProviders } from "@test/render";
import type { AgentDetail } from "../../agent-detail-page.types";
import { OverviewPanel } from "./overview-panel";

const MOCK_DETAIL: AgentDetail = {
  id: "ag-001",
  name: "Customer support agent",
  status: "Healthy",
  // Wire-format lifecycle value — lowercase on the API, see the union
  // in `agents.types.ts`. The cell formatter / status map handles the
  // user-facing label.
  deploymentStatus: "deployed",
  models: ["gpt-4-turbo"],
  type: "Single-agent",
  description: "Handles tier-1 customer support.",
  labels: ["Production", "Support"],
  lastUpdatedISO: "2026-02-10T07:15:06Z",
  createdISO: "2025-11-04T09:30:00Z",
  profile: {
    role: "Customer support specialist",
    goal: "Resolve customer queries quickly.",
    instructions: ["Always greet the customer professionally."],
  },
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

describe("OverviewPanel", () => {
  it("[tag:agent-overview] renders the details card rows from the agent payload", () => {
    renderOverviewPanel();

    expect(screen.getByText(MOCK_DETAIL.description)).toBeInTheDocument();
    expect(screen.getByText("Production, Support")).toBeInTheDocument();
    expect(screen.getByText("Single-agent")).toBeInTheDocument();
    expect(screen.getByText("gpt-4-turbo")).toBeInTheDocument();
    expect(screen.getByText("Feb 10, 2026, 7:15:06 AM")).toBeInTheDocument();
    expect(screen.getByText("Nov 4, 2025, 9:30:00 AM")).toBeInTheDocument();
  });

  it(
    "[tag:agent-overview][tag:metrics-flag] hides the metrics row + filter bar by default (SHOW_AGENT_METRICS_ROW=false)",
    () => {
      // The metrics row + filter bar are gated behind a boolean flag in
      // overview-panel.consts.ts. Until the upstream telemetry
      // endpoints land, the row stays hidden so the page does not lie
      // about data.
      renderOverviewPanel();

      expect(screen.queryByText("Active users")).not.toBeInTheDocument();
      expect(screen.queryByText("Conversations")).not.toBeInTheDocument();
      expect(screen.queryByText("Success rate")).not.toBeInTheDocument();
      expect(screen.queryByText("Filters:")).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-overview] does NOT render the legacy Profile card (removed)",
    () => {
      // Defensive regression test: the Profile card (Role / Goal /
      // Instructions) was removed in this branch. If a future PR
      // reintroduces it without intent, this test fails loudly.
      renderOverviewPanel();

      expect(screen.queryByText("Profile")).not.toBeInTheDocument();
      expect(screen.queryByText(MOCK_DETAIL.profile.role)).not.toBeInTheDocument();
      expect(screen.queryByText(MOCK_DETAIL.profile.goal)).not.toBeInTheDocument();
    },
  );
});

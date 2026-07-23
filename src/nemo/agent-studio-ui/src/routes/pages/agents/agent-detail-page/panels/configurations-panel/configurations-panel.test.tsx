import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ConfigurationsPanel } from "./configurations-panel";
import { CONFIGURATIONS_PANEL_STRINGS } from "./configurations-panel.consts";
import { PANEL_DEFERRED_STATE_STRINGS } from "../panel-deferred-state/panel-deferred-state.consts";
import { DEFAULT_FEATURE_CONFIG } from "../../../create-edit/form/agent-form.consts";
import type { AgentConfigurationSummary } from "../../agent-detail-page.types";

describe("ConfigurationsPanel", () => {
  // No configuration (e.g. team agents) → shared deferred-state placeholder.
  it("[tag:configurations-panel] delegates to the deferred-state placeholder when there is no configuration", () => {
    render(<ConfigurationsPanel />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      `${PANEL_DEFERRED_STATE_STRINGS.TITLE_PREFIX} ${CONFIGURATIONS_PANEL_STRINGS.RESOURCE_LABEL}`,
    );
  });

  it("[tag:configurations-panel] surfaces the shared waiting-on-backend body copy when empty", () => {
    render(<ConfigurationsPanel />);

    expect(
      screen.getByText(PANEL_DEFERRED_STATE_STRINGS.BODY),
    ).toBeInTheDocument();
  });

  it("[tag:configurations-panel] renders one read-only card per feature", () => {
    const configuration: AgentConfigurationSummary = {
      enabledFeatures: [],
      featureConfig: { ...DEFAULT_FEATURE_CONFIG },
    };
    render(<ConfigurationsPanel configuration={configuration} />);

    expect(screen.getByText("Structured output")).toBeInTheDocument();
    expect(
      screen.getByText("Conversation memory and context"),
    ).toBeInTheDocument();
    expect(screen.getByText("Safety and guardrails")).toBeInTheDocument();
    expect(screen.getByText("Automatic retries")).toBeInTheDocument();
    expect(screen.getByText("API rate limiting")).toBeInTheDocument();

    // Read-only: no Enable/Configure controls leak in from the editable section.
    expect(
      screen.queryByRole("button", { name: /enable|configure/i }),
    ).not.toBeInTheDocument();
  });

  it("[tag:configurations-panel] reflects enabled features and their values", () => {
    const configuration: AgentConfigurationSummary = {
      enabledFeatures: ["automatic_retries", "api_rate_limiting"],
      featureConfig: {
        ...DEFAULT_FEATURE_CONFIG,
        maxRetries: 5,
        maxRequestsPerMinute: 120,
      },
    };
    render(<ConfigurationsPanel configuration={configuration} />);

    // Enabled features show their values from featureConfig.
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    // At least one card reports Enabled and at least one reports Disabled.
    expect(screen.getAllByText("Enabled").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
  });
});

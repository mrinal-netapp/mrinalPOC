import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@test/render";

import { AgentPlaygroundWorkspacePage } from "./agent-playground-workspace-page";
import { AGENTS_STRINGS } from "../agents.consts";

// Resolve the agent/model queries immediately (no real fetch in tests) so the
// page renders past its loading spinner. `data: undefined` keeps the chat
// header on the agent id and `displayConfig` null, which is all this suite needs.
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/routes/pages/agents/api/agents-config-api.slice")
  >();
  return {
    ...actual,
    useGetAgentQuery: () => ({ data: undefined, isLoading: false }),
    useListProjectModelsQuery: () => ({ data: [] }),
  };
});

// The page owns the chat <-> run-details layout; the panels themselves are
// covered by their own suites. Stub them so this suite focuses on the page's
// routing (agentId from the URL) and the "Show details" toggle wiring. The
// chat panel renders the page-provided header actions so the toggle is testable.
vi.mock("./components/playground-chat-panel", () => ({
  PlaygroundChatPanel: ({ headerActions }: { headerActions?: ReactNode[] }) => (
    <div data-testid="playground-chat-panel">{headerActions}</div>
  ),
}));

vi.mock("./components/run-details-panel", () => ({
  RunDetailsPanel: () => <div data-testid="run-details-panel" />,
}));

function renderAt(path: string) {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/agents/:agentId/playground", element: <AgentPlaygroundWorkspacePage /> },
      { path: "/no-agent", element: <AgentPlaygroundWorkspacePage /> },
    ],
    initialEntries: [path],
  });
}

describe("AgentPlaygroundWorkspacePage", () => {
  it("[tag:agents] shows the empty state when no agent id is in the URL", () => {
    renderAt("/no-agent");
    expect(screen.getByText(AGENTS_STRINGS.CHAT_REQUIRES_AGENT)).toBeInTheDocument();
    expect(screen.queryByTestId("playground-chat-panel")).not.toBeInTheDocument();
  });

  it("[tag:agents] renders the chat panel for a routed agent", () => {
    renderAt("/agents/ag-test/playground");
    expect(screen.getByTestId("playground-chat-panel")).toBeInTheDocument();
  });

  it("[tag:agents] renders chat only until output details are toggled", async () => {
    const user = userEvent.setup();
    renderAt("/agents/ag-test/playground");

    expect(screen.getByTestId("playground-chat-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("run-details-panel")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: AGENTS_STRINGS.SHOW_OUTPUT_DETAILS }),
    );
    expect(screen.getByTestId("run-details-panel")).toBeInTheDocument();
  });
});

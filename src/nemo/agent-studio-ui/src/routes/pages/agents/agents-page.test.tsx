import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@test/render";
import { AgentsPage } from "./agents-page";
import { AGENTS_STRINGS } from "./agents.consts";

// The page composes the two list components, each of which fires an
// RTK Query call. We stub them to lightweight markers so this test
// stays focused on tab-switching wiring + page chrome.
vi.mock("./single-agents-list", () => ({
  SingleAgentsList: () => (
    <div data-testid="single-agents-list">single-agents</div>
  ),
}));

vi.mock("./team-agents-list", () => ({
  TeamAgentsList: () => (
    <div data-testid="team-agents-list">team-agents</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentsPage", () => {
  it("[tag:agents-page] renders the page title and subtitle from the strings table", () => {
    renderWithProviders(<AgentsPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      AGENTS_STRINGS.PAGE_TITLE,
    );
    expect(screen.getByText(AGENTS_STRINGS.PAGE_SUBTITLE)).toBeInTheDocument();
  });

  it(
    "[tag:agents-page] activates the Single agents tab by default",
    () => {
      renderWithProviders(<AgentsPage />);
      // The single list panel is mounted; the team list is not visible.
      expect(screen.getByTestId("single-agents-list")).toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-page] labels the tablist with the strings-table aria value",
    () => {
      renderWithProviders(<AgentsPage />);
      expect(
        screen.getByRole("tablist", { name: AGENTS_STRINGS.TABS_ARIA_LABEL }),
      ).toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-page] switching to the Team agents tab mounts the team list",
    async () => {
      renderWithProviders(<AgentsPage />);

      const user = userEvent.setup({ delay: null });
      await user.click(
        screen.getByRole("tab", { name: AGENTS_STRINGS.TAB_TEAM }),
      );

      expect(await screen.findByTestId("team-agents-list")).toBeInTheDocument();
    },
  );
});

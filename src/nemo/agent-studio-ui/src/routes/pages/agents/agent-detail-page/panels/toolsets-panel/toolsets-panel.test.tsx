import { screen } from "@testing-library/react";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";

import { renderWithProviders } from "@test/render";
import { mockResizeObserver } from "@/utils/unit-tests";
import { ToolsetsPanel } from "./toolsets-panel";
import { TOOLSETS_PANEL_STRINGS } from "./toolsets-panel.consts";
import { useAgentToolsets } from "./use-agent-toolsets";
import type { ToolsetRow } from "./toolsets-panel.types";

// The panel reads its rows from `useAgentToolsets`. Mock the hook so
// we can render the panel against a deterministic row set without
// spinning up a real RTK Query store.
vi.mock("./use-agent-toolsets", () => ({
  useAgentToolsets: vi.fn(),
}));

function renderToolsetsPanel() {
  return renderWithProviders(<ToolsetsPanel agentId="ag-001" />);
}

function mockRows(rows: ToolsetRow[]) {
  vi.mocked(useAgentToolsets).mockReturnValue({
    rows,
    isLoading: false,
    isError: false,
  });
}

const SAMPLE_ROWS: ToolsetRow[] = [
  {
    id: "ts-1",
    name: "Support tools",
    type: "Local",
    status: "Healthy",
    associatedAgents: [],
    labels: [],
  },
];

let roHandle: ReturnType<typeof mockResizeObserver>;
beforeAll(() => {
  roHandle = mockResizeObserver();
});
afterAll(() => {
  roHandle.cleanup();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("ToolsetsPanel", () => {
  it("[tag:agent-toolsets] renders the panel container", () => {
    mockRows([]);
    const { container } = renderToolsetsPanel();
    expect(container.querySelector(".toolsets-panel")).toBeInTheDocument();
  });

  it(
    "[tag:agent-toolsets] renders the BaseTable with the mapped rows",
    async () => {
      mockRows(SAMPLE_ROWS);
      renderToolsetsPanel();

      expect(await screen.findByText("Support tools")).toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-toolsets] does not render an Add primary-action button",
    async () => {
      mockRows(SAMPLE_ROWS);
      renderToolsetsPanel();

      // Wait for the table to render its rows before asserting absence.
      await screen.findByText("Support tools");
      expect(
        screen.queryByRole("button", { name: TOOLSETS_PANEL_STRINGS.PRIMARY_ACTION }),
      ).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-toolsets] Name cell renders a link to the toolset detail page",
    async () => {
      mockRows(SAMPLE_ROWS);
      renderToolsetsPanel();

      const link = await screen.findByRole("link", { name: "Support tools" });
      expect(link).toHaveAttribute("href", expect.stringContaining("/toolsets/ts-1"));
    },
    15000,
  );
});

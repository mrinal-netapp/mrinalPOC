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
import { AssignedKbPanel } from "./assigned-kb-panel";
import { ASSIGNED_KB_PANEL_STRINGS } from "./assigned-kb-panel.consts";
import { useAgentAssignedKbs } from "./use-agent-assigned-kbs";
import type { AssignedKnowledgeBaseRow } from "./assigned-kb-panel.types";

// The panel reads its rows from `useAgentAssignedKbs`. Mock the hook
// so we can render the panel against a deterministic row set without
// spinning up a real RTK Query store.
vi.mock("./use-agent-assigned-kbs", () => ({
  useAgentAssignedKbs: vi.fn(),
}));

function renderAssignedKbPanel() {
  return renderWithProviders(<AssignedKbPanel agentId="ag-001" />);
}

function mockRows(rows: AssignedKnowledgeBaseRow[]) {
  vi.mocked(useAgentAssignedKbs).mockReturnValue({
    rows,
    isLoading: false,
    isError: false,
  });
}

const SAMPLE_ROWS: AssignedKnowledgeBaseRow[] = [
  {
    id: "kb-1",
    name: "Product docs",
    status: "Available",
    job: { state: "Ready", progress: 1 },
    indexed: { fileCount: 12, vectorCount: 24 },
    lastSyncISO: "2026-02-01T10:00:00Z",
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

describe("AssignedKbPanel", () => {
  it("[tag:agent-assigned-kb] renders the panel container", () => {
    mockRows([]);
    const { container } = renderAssignedKbPanel();
    expect(container.querySelector(".assigned-kb-panel")).toBeInTheDocument();
  });

  it(
    "[tag:agent-assigned-kb] renders the BaseTable with the mapped rows",
    async () => {
      mockRows(SAMPLE_ROWS);
      renderAssignedKbPanel();

      expect(await screen.findByText("Product docs")).toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-assigned-kb] does not render an Assign primary-action button",
    async () => {
      mockRows(SAMPLE_ROWS);
      renderAssignedKbPanel();

      // Wait for the table to render its rows before asserting absence.
      await screen.findByText("Product docs");
      expect(
        screen.queryByRole("button", {
          name: ASSIGNED_KB_PANEL_STRINGS.PRIMARY_ACTION,
        }),
      ).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agent-assigned-kb] Name cell renders a link to the knowledge base detail page",
    async () => {
      mockRows(SAMPLE_ROWS);
      renderAssignedKbPanel();

      const link = await screen.findByRole("link", { name: "Product docs" });
      expect(link).toHaveAttribute("href", expect.stringContaining("/knowledge-bases/kb-1"));
    },
    15000,
  );
});

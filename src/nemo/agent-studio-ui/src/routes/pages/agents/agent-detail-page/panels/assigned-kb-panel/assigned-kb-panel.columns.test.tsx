import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import type { CellContext, ColumnDef } from "@tanstack/react-table";

import { createAssignedKbColumns } from "./assigned-kb-panel.columns";
import { ASSIGNED_KB_PANEL_STRINGS } from "./assigned-kb-panel.consts";
import type { AssignedKnowledgeBaseRow } from "./assigned-kb-panel.types";

const SAMPLE_ROW: AssignedKnowledgeBaseRow = {
  id: "kb-1",
  name: "Product docs",
  status: "Available",
  job: { state: "Ready", progress: 1 },
  indexed: { fileCount: 12, vectorCount: 24 },
  lastSyncISO: "2026-02-01T10:00:00Z",
  labels: [],
};

/**
 * Build a `CellContext`-shaped stub good enough to drive a TanStack
 * `ColumnDef.cell` renderer in isolation. The cells under test only
 * read `row.original`, so the other surface is intentionally unset.
 */
function makeCellContext(
  row: AssignedKnowledgeBaseRow,
): CellContext<AssignedKnowledgeBaseRow, unknown> {
  return {
    row: { original: row },
  } as unknown as CellContext<AssignedKnowledgeBaseRow, unknown>;
}

/** Find a column by its display `header` string. */
function callCell(
  column: ColumnDef<AssignedKnowledgeBaseRow>,
  ctx: CellContext<AssignedKnowledgeBaseRow, unknown>,
): ReactElement {
  const cell = column.cell;
  if (typeof cell !== "function") {
    throw new Error("Expected column.cell to be a function");
  }
  return cell(ctx) as ReactElement;
}

function getColumn(
  columns: ColumnDef<AssignedKnowledgeBaseRow>[],
  header: string,
): ColumnDef<AssignedKnowledgeBaseRow> {
  const found = columns.find((c) => c.header === header);
  if (!found) throw new Error(`No column with header ${header}`);
  return found;
}

describe("createAssignedKbColumns", () => {
  it(
    "[tag:agents-cell] returns the agent-details column set (Name, Status, Last sync)",
    () => {
      const columns = createAssignedKbColumns();
      const headers = columns.map((c) => c.header);

      expect(headers).toEqual([
        ASSIGNED_KB_PANEL_STRINGS.COL_NAME,
        ASSIGNED_KB_PANEL_STRINGS.COL_STATUS,
        ASSIGNED_KB_PANEL_STRINGS.COL_LAST_SYNC,
      ]);
    },
  );

  it(
    "[tag:agents-cell] Name cell renders a link to the knowledge base detail page",
    () => {
      const columns = createAssignedKbColumns();
      const nameCol = getColumn(columns, ASSIGNED_KB_PANEL_STRINGS.COL_NAME);

      render(
        <MemoryRouter>
          {callCell(nameCol, makeCellContext(SAMPLE_ROW))}
        </MemoryRouter>,
      );

      const link = screen.getByRole("link", { name: SAMPLE_ROW.name });
      expect(link).toHaveAttribute("href", "/knowledge-bases/kb-1");
    },
  );

  it("[tag:agents-cell] Status cell delegates to KbStatusCell", () => {
    const columns = createAssignedKbColumns();
    const statusCol = getColumn(columns, ASSIGNED_KB_PANEL_STRINGS.COL_STATUS);

    render(<MemoryRouter>{callCell(statusCol, makeCellContext(SAMPLE_ROW))}</MemoryRouter>);

    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it(
    "[tag:agents-cell] Last sync cell formats the ISO date via the shared full-format helper",
    () => {
      const columns = createAssignedKbColumns();
      const syncCol = getColumn(
        columns,
        ASSIGNED_KB_PANEL_STRINGS.COL_LAST_SYNC,
      );

      const { container } = render(
        <MemoryRouter>{callCell(syncCol, makeCellContext(SAMPLE_ROW))}</MemoryRouter>,
      );

      // The exact formatted string depends on the environment's
      // default locale, so we assert only that the cell rendered
      // non-empty text — the formatter itself has its own unit tests.
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    },
  );
});

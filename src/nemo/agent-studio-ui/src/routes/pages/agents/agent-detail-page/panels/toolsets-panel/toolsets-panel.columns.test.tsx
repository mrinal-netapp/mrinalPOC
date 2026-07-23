import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import type { CellContext, ColumnDef } from "@tanstack/react-table";

import { createToolsetsColumns } from "./toolsets-panel.columns";
import { TOOLSETS_PANEL_STRINGS } from "./toolsets-panel.consts";
import type { ToolsetRow } from "./toolsets-panel.types";

const SAMPLE_ROW: ToolsetRow = {
  id: "ts-1",
  name: "Customer support tools",
  type: "Local",
  status: "Healthy",
  associatedAgents: [],
  labels: [],
};

function makeCellContext(
  row: ToolsetRow,
): CellContext<ToolsetRow, unknown> {
  return {
    row: { original: row },
  } as unknown as CellContext<ToolsetRow, unknown>;
}

function callCell(
  column: ColumnDef<ToolsetRow>,
  ctx: CellContext<ToolsetRow, unknown>,
): ReactElement {
  const cell = column.cell;
  if (typeof cell !== "function") {
    throw new Error("Expected column.cell to be a function");
  }
  return cell(ctx) as ReactElement;
}

function getColumn(
  columns: ColumnDef<ToolsetRow>[],
  header: string,
): ColumnDef<ToolsetRow> {
  const found = columns.find((c) => c.header === header);
  if (!found) throw new Error(`No column with header ${header}`);
  return found;
}

describe("createToolsetsColumns", () => {
  it(
    "[tag:agents-cell] returns the agent-details column set (Name, Type, Status)",
    () => {
      const columns = createToolsetsColumns();
      const headers = columns.map((c) => c.header);

      expect(headers).toEqual([
        TOOLSETS_PANEL_STRINGS.COL_NAME,
        TOOLSETS_PANEL_STRINGS.COL_TYPE,
        TOOLSETS_PANEL_STRINGS.COL_STATUS,
      ]);
    },
  );

  it(
    "[tag:agents-cell] Name cell renders a link to the toolset detail page",
    () => {
      const columns = createToolsetsColumns();
      const nameCol = getColumn(columns, TOOLSETS_PANEL_STRINGS.COL_NAME);

      render(
        <MemoryRouter>
          {callCell(nameCol, makeCellContext(SAMPLE_ROW))}
        </MemoryRouter>,
      );

      const link = screen.getByRole("link", { name: SAMPLE_ROW.name });
      expect(link).toHaveAttribute("href", "/toolsets/ts-1");
    },
  );

  it("[tag:agents-cell] Type cell delegates to ToolsetTypeCell", () => {
    const columns = createToolsetsColumns();
    const typeCol = getColumn(columns, TOOLSETS_PANEL_STRINGS.COL_TYPE);
    render(<MemoryRouter>{callCell(typeCol, makeCellContext(SAMPLE_ROW))}</MemoryRouter>);
    expect(screen.getByText("Local")).toBeInTheDocument();
  });

  it("[tag:agents-cell] Status cell delegates to ToolsetStatusCell", () => {
    const columns = createToolsetsColumns();
    const statusCol = getColumn(columns, TOOLSETS_PANEL_STRINGS.COL_STATUS);
    render(<MemoryRouter>{callCell(statusCol, makeCellContext(SAMPLE_ROW))}</MemoryRouter>);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import type {
  AccessorFnColumnDef,
  CellContext,
  ColumnDef,
} from "@tanstack/react-table";

import {
  createAgentsListColumns,
  type AgentTableRow,
} from "./agents-list.columns";

const ROW: AgentTableRow = {
  id: "ag-1",
  name: "Customer support",
  status: "Healthy",
  models: ["GPT-4 Turbo", "Claude"],
  associatedResources: [{ id: "kb-1", name: "kb-one", kind: "knowledge-base" }],
  associatedItems: [{ id: "kb-1", name: "kb-one", kind: "knowledge-base" }],
  lastUpdated: "2026-02-01T00:00:00Z",
  deploymentStatus: "deployed",
};

function makeCellContext(row: AgentTableRow): CellContext<AgentTableRow, unknown> {
  return {
    row: { original: row },
  } as unknown as CellContext<AgentTableRow, unknown>;
}

function getCol(
  columns: ColumnDef<AgentTableRow>[],
  predicate: (col: ColumnDef<AgentTableRow>) => boolean,
): ColumnDef<AgentTableRow> {
  const found = columns.find(predicate);
  if (!found) throw new Error("No matching column");
  return found;
}

function callCell(
  column: ColumnDef<AgentTableRow>,
  ctx: CellContext<AgentTableRow, unknown>,
): ReactElement {
  const cell = column.cell;
  if (typeof cell !== "function") {
    throw new Error("Expected column.cell to be a function");
  }
  return cell(ctx) as ReactElement;
}

function makeCallbacks(overrides: Parameters<typeof createAgentsListColumns>[0] | Partial<Parameters<typeof createAgentsListColumns>[0]> = {}) {
  return {
    associatedColumnHeader: "Associated",
    onNavigateDetail: vi.fn(),
    actionMenuItems: vi.fn(() => []),
    isDeprecated: vi.fn(() => false),
    ...overrides,
  };
}

describe("createAgentsListColumns", () => {
  it(
    "[tag:agents-list][tag:columns] returns the seven-column set in screenshot order",
    () => {
      const cols = createAgentsListColumns(makeCallbacks());
      // accessorKey covers "name", "status", "deploymentStatus";
      // id covers "models", "associated", "last_updated", "actions".
      const keys = cols.map((c) => ("accessorKey" in c ? c.accessorKey : c.id));
      expect(keys).toEqual([
        "name",
        "status",
        "models",
        "associated",
        "last_updated",
        "deploymentStatus",
        "actions",
      ]);
    },
  );

  it(
    "[tag:agents-list][tag:columns] Name cell renders a clickable link when the row is live",
    async () => {
      const callbacks = makeCallbacks();
      const cols = createAgentsListColumns(callbacks);
      const nameCol = getCol(cols, (c) => "accessorKey" in c && c.accessorKey === "name");

      render(<>{callCell(nameCol, makeCellContext(ROW))}</>);
      await userEvent.setup({ delay: null }).click(
        screen.getByRole("button", { name: ROW.name }),
      );
      expect(callbacks.onNavigateDetail).toHaveBeenCalledWith("ag-1");
    },
  );

  it(
    "[tag:agents-list][tag:columns] Name cell renders the name as plain text when the row is deprecated",
    () => {
      const callbacks = makeCallbacks({ isDeprecated: vi.fn(() => true) });
      const cols = createAgentsListColumns(callbacks);
      const nameCol = getCol(cols, (c) => "accessorKey" in c && c.accessorKey === "name");

      render(<>{callCell(nameCol, makeCellContext(ROW))}</>);
      // Deprecated rows render the name as a non-interactive span,
      // not a button — clicking should not be possible.
      expect(screen.getByText(ROW.name)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: ROW.name }),
      ).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-list][tag:columns] Models cell lists each model inline when within the cap",
    () => {
      const cols = createAgentsListColumns(makeCallbacks());
      const modelsCol = getCol(cols, (c) => "id" in c && c.id === "models");
      render(<>{callCell(modelsCol, makeCellContext(ROW))}</>);
      // Two models (≤ 3) → both rendered inline, no overflow control.
      expect(screen.getByText("GPT-4 Turbo")).toBeInTheDocument();
      expect(screen.getByText("Claude")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-list][tag:columns] Models cell collapses 4+ models behind a clickable +N control",
    () => {
      const cols = createAgentsListColumns(makeCallbacks());
      const modelsCol = getCol(cols, (c) => "id" in c && c.id === "models");
      const row: AgentTableRow = {
        ...ROW,
        models: ["GPT-4 Turbo", "Claude", "Gemini", "Llama 3", "Mistral"],
      };
      render(<>{callCell(modelsCol, makeCellContext(row))}</>);
      // First three inline, remaining two behind "+2".
      expect(screen.getByText("GPT-4 Turbo")).toBeInTheDocument();
      expect(screen.getByText("Gemini")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show 2 more" }),
      ).toHaveTextContent("+2");
      expect(screen.queryByText("Mistral")).not.toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-list][tag:columns] Models accessorFn joins models with a comma + space (for sort/filter)",
    () => {
      const cols = createAgentsListColumns(makeCallbacks());
      const modelsCol = getCol(
        cols,
        (c) => "id" in c && c.id === "models",
      ) as AccessorFnColumnDef<AgentTableRow, string>;

      expect(modelsCol.accessorFn(ROW, 0)).toBe("GPT-4 Turbo, Claude");
    },
  );

  it(
    "[tag:agents-list][tag:columns] Last-updated accessorFn returns the raw ISO string (sort key)",
    () => {
      const cols = createAgentsListColumns(makeCallbacks());
      const lastUpdatedCol = getCol(
        cols,
        (c) => "id" in c && c.id === "last_updated",
      ) as AccessorFnColumnDef<AgentTableRow, string>;

      expect(lastUpdatedCol.accessorFn(ROW, 0)).toBe(ROW.lastUpdated);
    },
  );

  it(
    "[tag:agents-list][tag:columns] Associated header reflects the caller-supplied label",
    () => {
      const cols = createAgentsListColumns(
        makeCallbacks({ associatedColumnHeader: "My header" }),
      );
      const assocCol = getCol(cols, (c) => "id" in c && c.id === "associated");
      expect(assocCol.header).toBe("My header");
    },
  );

  it(
    "[tag:agents-list][tag:columns] Associated cell renders linked resource items",
    () => {
      const callbacks = makeCallbacks();
      const cols = createAgentsListColumns(callbacks);
      const assocCol = getCol(cols, (c) => "id" in c && c.id === "associated");

      render(<MemoryRouter>{callCell(assocCol, makeCellContext(ROW))}</MemoryRouter>);
      expect(screen.getByText("kb-one")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "kb-one" })).toHaveAttribute(
        "href",
        "/knowledge-bases/kb-1",
      );
    },
  );

  it(
    "[tag:agents-list][tag:columns] Actions cell asks the caller for the menu via actionMenuItems(row)",
    () => {
      const callbacks = makeCallbacks();
      const cols = createAgentsListColumns(callbacks);
      const actionsCol = getCol(cols, (c) => "id" in c && c.id === "actions");

      render(<>{callCell(actionsCol, makeCellContext(ROW))}</>);
      expect(callbacks.actionMenuItems).toHaveBeenCalledWith(ROW);
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { SortingState } from "@tanstack/react-table";

import { renderWithProviders, userEvent } from "@test/render";
import { PreviewTable, type PreviewRow } from "./PreviewTable";

const COLUMNS = ["id", "name"];
const ROWS: PreviewRow[] = [
  { _row_id: "r1", id: 1, name: "alpha" },
  { _row_id: "r2", id: 2, name: null },
];

function setup(overrides: Partial<Parameters<typeof PreviewTable>[0]> = {}) {
  const onPageChange = vi.fn();
  const onPageSizeChange = vi.fn();
  const onSortChange = vi.fn();
  const props = {
    columns: COLUMNS,
    rows: ROWS,
    totalCount: 2,
    pageIndex: 0,
    pageSize: 50,
    loading: false,
    sorting: [] as SortingState,
    onPageChange,
    onPageSizeChange,
    onSortChange,
    ...overrides,
  };
  renderWithProviders(<PreviewTable {...props} />);
  return { onPageChange, onPageSizeChange, onSortChange };
}

describe("PreviewTable", () => {
  it("renders data rows and shows NULL for null cells", () => {
    setup();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("shows a spinner row while loading", () => {
    const { container } = (() => {
      const r = setup({ loading: true });
      return { ...r, container: document.body };
    })();
    expect(container.querySelector(".preview-table__state-cell")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("shows a No data row when there are no rows", () => {
    setup({ rows: [], totalCount: 0 });
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("truncates long cell values to 60 chars", () => {
    const long = "x".repeat(80);
    setup({ rows: [{ _row_id: "r1", id: 1, name: long }] });
    expect(screen.getByText(`${long.slice(0, 60)}…`)).toBeInTheDocument();
  });

  it("shows the cap notice when totalCount exceeds 5000", () => {
    setup({ totalCount: 6000 });
    expect(screen.getByText(/capped at 5 000/)).toBeInTheDocument();
  });

  it("emits a sort change when a header is clicked", async () => {
    const user = userEvent.setup();
    const { onSortChange } = setup();
    await user.click(screen.getByText("name"));
    expect(onSortChange).toHaveBeenCalled();
  });

  it("renders the active sort indicator from sorting state", () => {
    const { container } = (() => {
      setup({ sorting: [{ id: "id", desc: false }] });
      return { container: document.body };
    })();
    expect(container.querySelector(".preview-table__sort-idle")).toBeInTheDocument();
  });

  it("disables Previous on the first page and enables Next", async () => {
    const user = userEvent.setup();
    const { onPageChange } = setup({ totalCount: 200, pageSize: 50, pageIndex: 0 });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("disables Next on the last page and enables Previous", async () => {
    const user = userEvent.setup();
    const { onPageChange } = setup({ totalCount: 200, pageSize: 50, pageIndex: 3 });
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("emits a page size change", async () => {
    const user = userEvent.setup();
    const { onPageSizeChange } = setup();
    await user.selectOptions(screen.getByRole("combobox"), "100");
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });

  it("renders a per-column filter affordance when provided", () => {
    setup({ columnFilterRenderer: (id) => <span data-testid={`f-${id}`}>filter</span> });
    expect(screen.getByTestId("f-id")).toBeInTheDocument();
    expect(screen.getByTestId("f-name")).toBeInTheDocument();
  });
});

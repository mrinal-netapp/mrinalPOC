import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { renderWithProviders, userEvent } from "@test/render";
import { ColumnFilterPopover } from "./ColumnFilterPopover";

const columnHistogram = vi.fn();
vi.mock("@/api/analytics-api", () => ({
  columnHistogram: (...args: unknown[]) => columnHistogram(...args),
}));

const BUCKETS = [
  { label: "alpha", count: 1200 },
  { label: "beta", count: 30 },
  { label: "", count: 5 },
];

function setup(overrides: Partial<Parameters<typeof ColumnFilterPopover>[0]> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  renderWithProviders(
    <ColumnFilterPopover
      namespace="ns"
      tableName="tbl"
      column="status"
      columnType="VARCHAR"
      onApply={onApply}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onApply, onClear };
}

describe("ColumnFilterPopover", () => {
  beforeEach(() => {
    columnHistogram.mockReset();
    columnHistogram.mockResolvedValue({ buckets: BUCKETS });
  });

  it("loads and lists values when opened, rendering (empty) for blank labels", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));

    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
  });

  it("filters the visible values by the search box", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");

    await user.type(screen.getByPlaceholderText("Search values…"), "bet");
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  it("shows No values found when the search matches nothing", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");
    await user.type(screen.getByPlaceholderText("Search values…"), "zzz");
    expect(screen.getByText("No values found")).toBeInTheDocument();
  });

  it("applies an IN filter for the checked values", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");

    await user.click(screen.getByText("alpha"));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith({ column: "status", op: "IN", value: "alpha" });
  });

  it("clears the filter when applying with no selection", async () => {
    const user = userEvent.setup();
    const { onApply, onClear } = setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("supports Select all then Clear", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");

    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // Cleared selection → apply clears rather than applying an IN filter.
    expect(onApply).not.toHaveBeenCalled();
  });

  it("preselects values from an active IN filter and offers Remove", async () => {
    const user = userEvent.setup();
    const { onClear } = setup({ activeFilter: { column: "status", op: "IN", value: "alpha,beta" } });
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");

    await user.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error message when loading fails", async () => {
    columnHistogram.mockRejectedValueOnce(new Error("backend down"));
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    expect(await screen.findByText("backend down")).toBeInTheDocument();
  });

  it("closes via the close button", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await screen.findByText("alpha");

    const closeBtn = document.querySelector(".col-filter__close") as HTMLElement;
    await user.click(closeBtn);
    await waitFor(() => expect(screen.queryByText("alpha")).not.toBeInTheDocument());
  });
});

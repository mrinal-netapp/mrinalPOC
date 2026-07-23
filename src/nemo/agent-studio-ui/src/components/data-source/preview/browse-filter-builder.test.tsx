import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders, userEvent } from "@test/render";
import { BrowseFilterBuilder } from "./browse-filter-builder";

const COLUMNS = ["Name", "Type", "Size", "Last modified"];
const COLUMN_TYPES = ["VARCHAR", "VARCHAR", "BIGINT", "TIMESTAMP"];

function setup(overrides: Partial<Parameters<typeof BrowseFilterBuilder>[0]> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  renderWithProviders(
    <BrowseFilterBuilder
      columns={COLUMNS}
      columnTypes={COLUMN_TYPES}
      onApply={onApply}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onApply, onClear };
}

describe("BrowseFilterBuilder", () => {
  it("shows no Apply/Clear actions until a row is added", () => {
    setup();
    expect(screen.getByRole("button", { name: "Add filter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("does not render an operator dropdown", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.queryByRole("combobox", { name: /operator/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("applies contains filter for text columns", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.type(screen.getByPlaceholderText("Contains…"), "report");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith([
      { column: "Name", op: "LIKE", value: "%report%" },
    ]);
  });

  it("applies exact match for numeric columns", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.selectOptions(screen.getByRole("combobox"), "Size");
    await user.type(screen.getByPlaceholderText("Exact value"), "2048");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith([
      { column: "Size", op: "=", value: "2048" },
    ]);
  });

  it("shows exact value placeholder for float columns", async () => {
    const user = userEvent.setup();
    setup({ columns: ["Score"], columnTypes: ["DOUBLE"] });

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByPlaceholderText("Exact value")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Contains…")).not.toBeInTheDocument();
  });

  it("skips rows with empty values on apply", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith([]);
  });

  it("clears rows and calls onClear", async () => {
    const user = userEvent.setup();
    const { onClear } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.type(screen.getByPlaceholderText("Contains…"), "x");
    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(onClear).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Contains…")).not.toBeInTheDocument();
  });
});

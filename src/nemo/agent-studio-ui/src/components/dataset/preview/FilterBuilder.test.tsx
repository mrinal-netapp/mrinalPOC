import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";

import { renderWithProviders, userEvent } from "@test/render";
import { FilterBuilder } from "./FilterBuilder";

const COLUMNS = ["id", "name", "active"];
const COLUMN_TYPES = ["INTEGER", "VARCHAR", "BOOLEAN"];

function setup(overrides: Partial<Parameters<typeof FilterBuilder>[0]> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  renderWithProviders(
    <FilterBuilder
      columns={COLUMNS}
      columnTypes={COLUMN_TYPES}
      onApply={onApply}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onApply, onClear };
}

describe("FilterBuilder", () => {
  it("shows no Apply/Clear actions until a row is added", () => {
    setup();
    expect(screen.getByRole("button", { name: "Add filter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("adds a row defaulting to the first column and applies a value filter", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    const value = screen.getByPlaceholderText("Value");
    await user.type(value, "42");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith([{ column: "id", op: "=", value: "42" }]);
  });

  it("hides the value input for null operators and emits undefined value", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    const selects = screen.getAllByRole("combobox");
    // Second select is the operator select.
    await user.selectOptions(selects[1], "IS NULL");
    expect(screen.queryByPlaceholderText("Value")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([{ column: "id", op: "IS NULL", value: undefined }]);
  });

  it("resets the operator when switching to a column whose type lacks it", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    const selects = screen.getAllByRole("combobox");
    // Move to the string column (which offers LIKE), pick LIKE, then switch to
    // the boolean column whose type does not support LIKE.
    await user.selectOptions(selects[0], "name");
    await user.selectOptions(screen.getAllByRole("combobox")[1], "LIKE");
    await user.selectOptions(screen.getAllByRole("combobox")[0], "active");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // LIKE is invalid for boolean → falls back to first boolean op "=".
    expect(onApply).toHaveBeenCalledWith([{ column: "active", op: "=", value: "" }]);
  });

  it("renders an AND separator between multiple rows and removes a row", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByText("AND")).toBeInTheDocument();

    const removeButtons = screen.getAllByRole("button", { name: "Remove filter" });
    expect(removeButtons).toHaveLength(2);
    await user.click(removeButtons[0]);
    expect(screen.queryByText("AND")).not.toBeInTheDocument();
  });

  it("applies on Enter inside the value input", async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    const value = screen.getByPlaceholderText("Value");
    await user.type(value, "x{Enter}");
    expect(onApply).toHaveBeenCalled();
  });

  it("clears all rows and calls onClear", async () => {
    const user = userEvent.setup();
    const { onClear } = setup();

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("treats columns without a matching type as the 'other' category", async () => {
    const user = userEvent.setup();
    // More columns than types → trailing column falls into the idx>=len branch.
    setup({ columns: ["a", "b"], columnTypes: ["INTEGER"] });

    await user.click(screen.getByRole("button", { name: "Add filter" }));
    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0], "b");
    // "other" category exposes only =, !=, IS NULL, IS NOT NULL.
    const opSelect = screen.getAllByRole("combobox")[1];
    const options = within(opSelect).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["=", "!=", "IS NULL", "IS NOT NULL"]);
  });
});

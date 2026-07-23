import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders, userEvent } from "@test/render";
import { ColumnVisibilityPopover } from "./ColumnVisibilityPopover";

describe("ColumnVisibilityPopover", () => {
  it("[tag:column-visibility] apply keeps first column visible when all unchecked", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();

    renderWithProviders(
      <ColumnVisibilityPopover
        columns={[
          { id: "colA", label: "A", visible: true },
          { id: "colB", label: "B", visible: true },
        ]}
        onApply={onApply}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose columns" }));
    await user.click(screen.getByLabelText("A"));
    await user.click(screen.getByLabelText("B"));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      colA: true,
      colB: false,
    });
  });
});

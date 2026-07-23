import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { renderWithProviders, userEvent } from "@test/render";
import {
  OverflowListCell,
  type OverflowListCellProps,
} from "./overflow-list-cell";

function makeItems(count: number): OverflowListCellProps["items"] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${i + 1}`,
    name: `Item ${i + 1}`,
  }));
}

describe("OverflowListCell", () => {
  it(
    "[tag:agents-cell] renders an em-dash placeholder when there are no items",
    () => {
      renderWithProviders(<OverflowListCell items={[]} />);
      expect(screen.getByText("—")).toBeInTheDocument();
    },
  );

  it("[tag:agents-cell] renders up to 3 items inline with no overflow control", () => {
    renderWithProviders(<OverflowListCell items={makeItems(3)} />);

    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(screen.getByText("Item 3")).toBeInTheDocument();
    // No "+N" affordance when the count does not exceed 3.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("[tag:agents-cell] collapses items beyond 3 behind a clickable +N control", () => {
    renderWithProviders(<OverflowListCell items={makeItems(5)} />);

    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(screen.getByText("Item 3")).toBeInTheDocument();

    const overflow = screen.getByRole("button", { name: "Show 2 more" });
    expect(overflow).toHaveTextContent("+2");
    expect(screen.queryByText("Item 4")).not.toBeInTheDocument();
    expect(screen.queryByText("Item 5")).not.toBeInTheDocument();
  });

  it("[tag:agents-cell] reveals the remaining items when the +N control is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OverflowListCell items={makeItems(6)} />);

    await user.click(screen.getByRole("button", { name: "Show 3 more" }));

    expect(await screen.findByText("Item 4")).toBeInTheDocument();
    expect(screen.getByText("Item 5")).toBeInTheDocument();
    expect(screen.getByText("Item 6")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Item 4")).not.toBeInTheDocument();
    });
  });

  it("[tag:agents-cell] overflow resource links open in a new tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <OverflowListCell
        items={[
          { id: "r-1", name: "Item 1" },
          { id: "r-2", name: "Item 2" },
          { id: "r-3", name: "Item 3" },
          { id: "kb-4", name: "KB 4", href: "/knowledge-bases/kb-4" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show 1 more" }));

    const kbLink = await screen.findByRole("menuitem", { name: "KB 4" });
    expect(kbLink).toHaveAttribute("href", "/knowledge-bases/kb-4");
    expect(kbLink).toHaveAttribute("target", "_blank");
    expect(kbLink).toHaveAttribute("rel", "noreferrer");
  });
});

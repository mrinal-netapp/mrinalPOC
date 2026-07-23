import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { KbStatusCell } from "./kb-status-cell";

describe("KbStatusCell", () => {
  it("[tag:agents-cell] renders the Available label + icon", () => {
    const { container } = render(<KbStatusCell status="Available" />);
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("[tag:agents-cell] renders the Synchronizing label + icon", () => {
    const { container } = render(<KbStatusCell status="Synchronizing" />);
    expect(screen.getByText("Synchronizing")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

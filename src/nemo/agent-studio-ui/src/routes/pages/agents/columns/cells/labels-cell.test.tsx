import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { LabelsCell } from "./labels-cell";

describe("LabelsCell", () => {
  it("[tag:agents-cell] renders an em-dash placeholder when labels is empty", () => {
    render(<LabelsCell labels={[]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("[tag:agents-cell] renders one Chip per label", () => {
    render(<LabelsCell labels={["Production", "Beta"]} />);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ToolsetTypeCell } from "./toolset-type-cell";

describe("ToolsetTypeCell", () => {
  it("[tag:agents-cell] renders the Local label", () => {
    render(<ToolsetTypeCell type="Local" />);
    expect(screen.getByText("Local")).toBeInTheDocument();
  });

  it("[tag:agents-cell] renders the Remote label", () => {
    render(<ToolsetTypeCell type="Remote" />);
    expect(screen.getByText("Remote")).toBeInTheDocument();
  });
});

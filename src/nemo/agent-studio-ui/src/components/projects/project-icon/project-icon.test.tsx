import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectIcon } from "./project-icon";

describe("ProjectIcon", () => {
  it("[tag:project-icon] renders the three-circle cluster icon", () => {
    const { container } = render(<ProjectIcon />);

    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass("tabler-icon-circles");
    expect(svg?.querySelectorAll("path")).toHaveLength(3);
  });

  it("[tag:project-icon] supports md size", () => {
    const { container } = render(<ProjectIcon size="md" />);

    expect(container.querySelector("svg")).toHaveAttribute("height", "24");
  });
});

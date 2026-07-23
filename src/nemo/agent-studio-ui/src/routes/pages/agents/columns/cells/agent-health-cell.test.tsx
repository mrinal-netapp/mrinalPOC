import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgentHealthCell } from "./agent-health-cell";

describe("AgentHealthCell", () => {
  it("[tag:agents-cell] renders the Healthy label + icon", () => {
    const { container } = render(<AgentHealthCell status="Healthy" />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("[tag:agents-cell] renders the Unhealthy label + icon", () => {
    const { container } = render(<AgentHealthCell status="Unhealthy" />);
    expect(screen.getByText("Unhealthy")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

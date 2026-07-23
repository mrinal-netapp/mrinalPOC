import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgentDeploymentCell } from "./agent-deployment-cell";

describe("AgentDeploymentCell", () => {
  it(
    "[tag:agents-cell] renders the display label for the wire value",
    () => {
      render(<AgentDeploymentCell status="not_deployed" />);
      expect(screen.getByText("Not deployed")).toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-cell] renders the status icon next to the label",
    () => {
      const { container } = render(<AgentDeploymentCell status="deployed" />);
      // The shared StatusIcon renders an <svg> alongside the label.
      // Asserting on its presence is enough — the colour-by-status
      // mapping is covered by agents.utils.test.ts.
      expect(container.querySelector("svg")).toBeInTheDocument();
      expect(screen.getByText("Deployed")).toBeInTheDocument();
    },
  );
});

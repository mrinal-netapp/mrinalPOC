import { describe, it, expect } from "vitest";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClock,
  IconLoader2,
  IconPencil,
  IconPlayerStop,
} from "@tabler/icons-react";

import {
  formatDeploymentStatusLabel,
  getAgentDeploymentVisual,
  getAgentHealthVisual,
} from "./agents.utils";

describe("getAgentHealthVisual", () => {
  it("[tag:agents-utils] maps Healthy to the success check icon", () => {
    const v = getAgentHealthVisual("Healthy");
    expect(v.type).toBe("icon");
    expect(v.Icon).toBe(IconCircleCheck);
    expect(v.color).toBe("var(--notification-success)");
  });

  it("[tag:agents-utils] maps Unhealthy to the error circle icon", () => {
    const v = getAgentHealthVisual("Unhealthy");
    expect(v.Icon).toBe(IconCircleX);
    expect(v.color).toBe("var(--notification-error)");
  });
});

describe("getAgentDeploymentVisual", () => {
  // Each row asserts wire-value → expected icon + colour token. Adding a
  // new deployment lifecycle value upstream forces the union to grow and
  // this table to grow with it; otherwise the test will fail to compile.
  const TABLE: Array<{
    status: Parameters<typeof getAgentDeploymentVisual>[0];
    icon: unknown;
    color: string;
  }> = [
    { status: "draft", icon: IconPencil, color: "var(--text-secondary)" },
    { status: "preview", icon: IconClock, color: "var(--text-secondary)" },
    { status: "not_deployed", icon: IconCircleDashed, color: "var(--text-secondary)" },
    { status: "deploying", icon: IconLoader2, color: "var(--notification-info)" },
    { status: "deployed", icon: IconCircleCheck, color: "var(--notification-success)" },
    { status: "failed", icon: IconAlertTriangle, color: "var(--notification-error)" },
    { status: "terminating", icon: IconLoader2, color: "var(--notification-warning)" },
    { status: "terminated", icon: IconPlayerStop, color: "var(--text-secondary)" },
  ];

  it.each(TABLE)(
    "[tag:agents-utils] $status maps to the expected icon + colour token",
    ({ status, icon, color }) => {
      const v = getAgentDeploymentVisual(status);
      expect(v.type).toBe("icon");
      expect(v.Icon).toBe(icon);
      expect(v.color).toBe(color);
    },
  );
});

describe("formatDeploymentStatusLabel", () => {
  it("[tag:agents-utils] converts snake_case wire values to display strings", () => {
    expect(formatDeploymentStatusLabel("not_deployed")).toBe("Not deployed");
    expect(formatDeploymentStatusLabel("draft")).toBe("Draft");
    expect(formatDeploymentStatusLabel("deployed")).toBe("Deployed");
    expect(formatDeploymentStatusLabel("terminating")).toBe("Terminating");
  });
});


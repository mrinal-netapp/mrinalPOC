import { describe, expect, it } from "vitest";

import {
  formatTemplateExamples,
  formatTemplateInstructions,
  type AgentTemplateExample,
} from "./agent-templates.consts";

describe("agent-templates.consts", () => {
  it("formatTemplateExamples returns the fallback when there are no examples", () => {
    expect(formatTemplateExamples([])).toBe("No content available for this template.");
  });

  it("formatTemplateExamples joins each example with title, scenario, and response", () => {
    const examples: AgentTemplateExample[] = [
      {
        title: "Daily summary",
        scenario: "Morning report",
        response: "All systems healthy",
      },
      {
        title: "Incident RCA",
        scenario: "Latency spike",
        response: "Network update caused routing instability",
      },
    ];

    expect(formatTemplateExamples(examples)).toBe(
      [
        "Example 1:",
        "Daily summary",
        "Scenario:",
        "Morning report",
        "Response:",
        "All systems healthy",
        "",
        "Example 2:",
        "Incident RCA",
        "Scenario:",
        "Latency spike",
        "Response:",
        "Network update caused routing instability",
      ].join("\n"),
    );
  });

  it("formatTemplateInstructions trims whitespace and falls back when empty", () => {
    expect(formatTemplateInstructions("  Monitor storage health  ")).toBe(
      "Monitor storage health",
    );
    expect(formatTemplateInstructions("   ")).toBe("No content available for this template.");
  });
});

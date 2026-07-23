import { describe, expect, it } from "vitest";

import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";

const values = {
  template: {
    agentInstances: [{ name: "Research", knowledgeBases: [{ id: "kb-1" }] }],
  },
};

describe("agent-form-field-path", () => {
  it("builds a top-level field path when no prefix is provided", () => {
    expect(agentFormFieldPath(undefined, "goal")).toBe("goal");
  });

  it("builds a nested field path under a prefix", () => {
    expect(agentFormFieldPath("template.agentInstances[0]", "name")).toBe(
      "template.agentInstances[0].name",
    );
  });

  it("reads nested values using dot and bracket notation", () => {
    expect(getFormValueAtPath<string>(values, "template.agentInstances[0].name")).toBe(
      "Research",
    );
    expect(
      getFormValueAtPath<Array<{ id: string }>>(
        values,
        "template.agentInstances[0].knowledgeBases",
      ),
    ).toEqual([{ id: "kb-1" }]);
  });

  it("returns undefined for missing or invalid paths", () => {
    expect(getFormValueAtPath(values, "template.agentInstances[9].name")).toBeUndefined();
    expect(getFormValueAtPath(null, "goal")).toBeUndefined();
    expect(getFormValueAtPath({ goal: "x" }, "goal.nested")).toBeUndefined();
  });
});

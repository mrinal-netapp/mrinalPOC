import { describe, expect, it } from "vitest";

import type { DependentsPage } from "@/routes/pages/agents/api/agents-config.types";

import {
  countDependents,
  formatDependentKind,
  formatDependentRelation,
  formatModelDeleteError,
} from "./model-dependents.utils";

describe("model-dependents.utils", () => {
  it("[tag:model-dependents] counts dependents from totalByKind", () => {
    const page: DependentsPage = {
      items: [],
      totalByKind: { agent: 2, evaluation: 1 },
    };
    expect(countDependents(page)).toBe(3);
  });

  it("[tag:model-dependents] falls back to items length when totals are empty", () => {
    const page: DependentsPage = {
      items: [
        { kind: "agent", id: "a-1", relation: "uses_model" },
        { kind: "agent", id: "a-2", relation: "uses_model" },
      ],
      totalByKind: {},
    };
    expect(countDependents(page)).toBe(2);
  });

  it("[tag:model-dependents] formats known kind and relation labels", () => {
    expect(formatDependentKind("agent_team")).toBe("Agent team");
    expect(formatDependentRelation("uses_judge_model")).toBe("Judge model");
    expect(formatDependentRelation("uses_embedding_model")).toBe("Embedding model");
  });

  it("[tag:model-dependents] maps HAS_DEPENDENTS delete errors to user-facing copy", () => {
    expect(
      formatModelDeleteError({ data: { code: "HAS_DEPENDENTS", error: "blocked" } }),
    ).toContain("still used");
  });
});

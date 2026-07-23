import { describe, expect, it, vi, beforeEach } from "vitest";

import type { DependentsPage } from "@/routes/pages/agents/api/agents-config.types";

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from "@/ui-lib/base-components/toast/toast";
import {
  formatDependentKind,
  formatDependentLabel,
  formatDependentsDescription,
  getDependentsFromDeleteError,
  showDatasetDeleteErrorToast,
  showDeleteBlockedToast,
  showKnowledgeBaseDeleteErrorToast,
} from "./delete-dependents.utils";

describe("delete-dependents.utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:delete-dependents] getDependentsFromDeleteError parses RTK rejection shape", () => {
    const page: DependentsPage = {
      items: [{ kind: "knowledge_base", id: "kb-1", name: "My KB", relation: "uses_dataset" }],
      nextCursor: null,
      totalByKind: { knowledge_base: 1 },
    };

    expect(
      getDependentsFromDeleteError({
        data: { code: "HAS_DEPENDENTS", error: "blocked", dependents: page },
      }),
    ).toEqual(page);
  });

  it("[tag:delete-dependents] getDependentsFromDeleteError returns null for invalid payloads", () => {
    expect(getDependentsFromDeleteError(undefined)).toBeNull();
    expect(getDependentsFromDeleteError({ data: { dependents: { items: "nope" } } })).toBeNull();
  });

  it("[tag:delete-dependents] formatDependentKind and formatDependentLabel use friendly labels", () => {
    expect(formatDependentKind("agent_team")).toBe("Agent team");
    expect(formatDependentKind("custom_thing")).toBe("custom thing");
    expect(
      formatDependentLabel({
        kind: "agent",
        id: "agt-1",
        name: "Support Bot",
        relation: "uses_dataset",
      }),
    ).toBe("Agent: Support Bot");
    expect(
      formatDependentLabel({
        kind: "knowledge_base",
        id: "kb-1",
        name: null,
        relation: "uses_dataset",
      }),
    ).toBe("Knowledge base: kb-1");
  });

  it("[tag:delete-dependents] formatDependentsDescription truncates long lists", () => {
    const page: DependentsPage = {
      items: Array.from({ length: 6 }, (_, index) => ({
        kind: "agent",
        id: `agt-${index}`,
        name: `Agent ${index}`,
        relation: "uses_dataset",
      })),
      nextCursor: null,
      totalByKind: { agent: 8 },
    };

    expect(formatDependentsDescription(page, 5)).toBe(
      [
        "Agent: Agent 0",
        "Agent: Agent 1",
        "Agent: Agent 2",
        "Agent: Agent 3",
        "Agent: Agent 4",
        "and 3 more…",
      ].join("\n"),
    );
  });

  it("[tag:delete-dependents] showDeleteBlockedToast uses warning toast with dependents description", () => {
    showDeleteBlockedToast(
      {
        data: {
          code: "HAS_DEPENDENTS",
          error: "Cannot delete this dataset because it is still in use.",
          dependents: {
            items: [{ kind: "knowledge_base", id: "kb-1", name: "Docs KB", relation: "uses_dataset" }],
            nextCursor: null,
            totalByKind: { knowledge_base: 1 },
          },
        },
      },
      {
        blockedFallback: "blocked fallback",
        genericFallback: "generic fallback",
      },
    );

    expect(toast.warning).toHaveBeenCalledWith(
      "Cannot delete this dataset because it is still in use.",
      {
        description: "Knowledge base: Docs KB",
        duration: 8000,
      },
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("[tag:delete-dependents] showDeleteBlockedToast falls back to error toast", () => {
    showDeleteBlockedToast(
      { data: { error: "Server exploded" } },
      {
        blockedFallback: "blocked fallback",
        genericFallback: "generic fallback",
      },
    );

    expect(toast.error).toHaveBeenCalledWith("Server exploded");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("[tag:delete-dependents] showDeleteBlockedToast uses generic fallback for plain Error objects", () => {
    showDeleteBlockedToast(new Error("fail"), {
      blockedFallback: "blocked fallback",
      genericFallback: "generic fallback",
    });

    expect(toast.error).toHaveBeenCalledWith("generic fallback");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("[tag:delete-dependents] entity wrappers use entity-specific fallbacks", () => {
    showDatasetDeleteErrorToast(new Error("fail"), "Dataset A");
    expect(toast.error).toHaveBeenCalledWith('Failed to delete "Dataset A".');

    showKnowledgeBaseDeleteErrorToast(
      { data: { code: "HAS_DEPENDENTS", error: "KB blocked", dependents: { items: [] } } },
      "KB A",
    );
    expect(toast.warning).toHaveBeenCalledWith("KB blocked", { duration: 8000 });
  });
});

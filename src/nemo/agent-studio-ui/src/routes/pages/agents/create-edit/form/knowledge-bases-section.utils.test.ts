import { describe, expect, it } from "vitest";

import { DEFAULT_KNOWLEDGE_BASE_CONFIG } from "../configure-dialogs/configure-dialogs.consts";
import type { KnowledgeBaseOption } from "../configure-dialogs/configure-dialogs.types";
import type { AgentAttachedKB } from "./agent-form.consts";
import { buildAttachedKB, draftFromAttachedKB } from "./knowledge-bases-section.utils";

const CATALOG: KnowledgeBaseOption[] = [
  { id: "kb-1", name: "Docs", status: "available", labels: ["prod"] },
  { id: "kb-2", name: "Staging KB", status: "indexing", labels: [] },
  { id: "kb-3", name: "Broken", status: "unavailable", labels: ["qa"] },
  { id: "kb-4", name: "Unknown", status: "unknown", labels: [] },
];

describe("knowledge-bases-section.utils", () => {
  it("buildAttachedKB returns null when the draft id is not in the catalog", () => {
    expect(
      buildAttachedKB({ ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "missing" }, CATALOG),
    ).toBeNull();
  });

  it("buildAttachedKB maps catalog availability to form status and RAG settings", () => {
    const attached = buildAttachedKB(
      {
        knowledgeBaseId: "kb-1",
        topKChunks: 9,
        rerankingEnabled: true,
        similarityThresholdEnabled: true,
        similarity: 0.42,
      },
      CATALOG,
    );
    expect(attached).toEqual({
      id: "kb-1",
      name: "Docs",
      status: "healthy",
      tier: "prod",
      remaining: "—",
      fileUsage: "Top K: 9",
      ragConfig: {
        topKChunks: 9,
        rerankingEnabled: true,
        similarityThresholdEnabled: true,
        similarity: 0.42,
      },
    });
  });

  it("buildAttachedKB maps indexing, unavailable, and unknown availability", () => {
    expect(buildAttachedKB(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-2" },
      CATALOG,
    )?.status).toBe("degraded");
    expect(buildAttachedKB(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-3" },
      CATALOG,
    )?.status).toBe("unhealthy");
    expect(buildAttachedKB(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-4" },
      CATALOG,
    )?.status).toBe("unhealthy");
    expect(buildAttachedKB(
      { ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "kb-2" },
      CATALOG,
    )?.tier).toBe("—");
  });

  it("draftFromAttachedKB restores draft fields with defaults for missing ragConfig", () => {
    const withConfig: AgentAttachedKB = {
      id: "kb-1",
      name: "Docs",
      status: "healthy",
      tier: "prod",
      remaining: "—",
      fileUsage: "Top K: 3",
      ragConfig: {
        topKChunks: 3,
        rerankingEnabled: false,
        similarityThresholdEnabled: true,
        similarity: 0.8,
      },
    };
    expect(draftFromAttachedKB(withConfig)).toEqual({
      knowledgeBaseId: "kb-1",
      topKChunks: 3,
      rerankingEnabled: false,
      similarityThresholdEnabled: true,
      similarity: 0.8,
    });

    const legacy: AgentAttachedKB = {
      id: "kb-legacy",
      name: "Legacy",
      status: "healthy",
      tier: "—",
      remaining: "—",
      fileUsage: "Top K: 5",
    };
    expect(draftFromAttachedKB(legacy)).toEqual({
      knowledgeBaseId: "kb-legacy",
      topKChunks: DEFAULT_KNOWLEDGE_BASE_CONFIG.topKChunks,
      rerankingEnabled: DEFAULT_KNOWLEDGE_BASE_CONFIG.rerankingEnabled,
      similarityThresholdEnabled: DEFAULT_KNOWLEDGE_BASE_CONFIG.similarityThresholdEnabled,
      similarity: DEFAULT_KNOWLEDGE_BASE_CONFIG.similarity,
    });
  });
});

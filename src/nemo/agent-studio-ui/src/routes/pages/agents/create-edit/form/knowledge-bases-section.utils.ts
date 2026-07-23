import { DEFAULT_KNOWLEDGE_BASE_CONFIG } from "../configure-dialogs/configure-dialogs.consts";
import type {
  KnowledgeBaseAvailability,
  KnowledgeBaseConfig,
  KnowledgeBaseOption,
} from "../configure-dialogs/configure-dialogs.types";
import type { AgentAttachedKB, AgentKBStatus } from "./agent-form.consts";

const KB_STATUS_FROM_AVAILABILITY: Record<KnowledgeBaseAvailability, AgentKBStatus> = {
  available: "healthy",
  indexing: "degraded",
  unavailable: "unhealthy",
  unknown: "unhealthy",
};

function buildAttachedKB(
  draft: KnowledgeBaseConfig,
  catalog: readonly KnowledgeBaseOption[],
): AgentAttachedKB | null {
  const option = catalog.find((kb) => kb.id === draft.knowledgeBaseId);
  if (!option) return null;
  return {
    id: option.id,
    name: option.name,
    status: KB_STATUS_FROM_AVAILABILITY[option.status],
    tier: option.labels[0] ?? "—",
    remaining: "—",
    fileUsage: `Top K: ${draft.topKChunks}`,
    ragConfig: {
      topKChunks: draft.topKChunks,
      rerankingEnabled: draft.rerankingEnabled,
      similarityThresholdEnabled: draft.similarityThresholdEnabled,
      similarity: draft.similarity,
    },
  };
}

function draftFromAttachedKB(kb: AgentAttachedKB): KnowledgeBaseConfig {
  return {
    knowledgeBaseId: kb.id,
    topKChunks: kb.ragConfig?.topKChunks ?? DEFAULT_KNOWLEDGE_BASE_CONFIG.topKChunks,
    rerankingEnabled:
      kb.ragConfig?.rerankingEnabled ?? DEFAULT_KNOWLEDGE_BASE_CONFIG.rerankingEnabled,
    similarityThresholdEnabled:
      kb.ragConfig?.similarityThresholdEnabled ??
      DEFAULT_KNOWLEDGE_BASE_CONFIG.similarityThresholdEnabled,
    similarity: kb.ragConfig?.similarity ?? DEFAULT_KNOWLEDGE_BASE_CONFIG.similarity,
  };
}

export { buildAttachedKB, draftFromAttachedKB };

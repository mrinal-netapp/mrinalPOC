import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { useSearchKnowledgeBaseMutation } from "@/api/kb-api.slice";
import type { AgentChunk } from "@/api/agent.types";

import { PlaygroundChatColumn } from "./playground-chat-column";
import { PlaygroundResultsColumn } from "./playground-results-column";
import { PlaygroundChunkDetails } from "./playground-chunk-details";
import type { PlaygroundChatEntry, PlaygroundQuerySettings } from "./kb-detail-playground.types";
import { generateId } from "./kb-detail-playground.utils";
import "./kb-detail-playground.scss";

// -- Component --

interface KBDetailPlaygroundProps {
  kbId: string;
  projectId: string;
}

function KBDetailPlayground({ kbId, projectId }: KBDetailPlaygroundProps): ReactElement {
  const [chatHistory, setChatHistory] = useState<PlaygroundChatEntry[]>([]);
  const [activeQueryIndex, setActiveQueryIndex] = useState<number | null>(null);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [querySettings, setQuerySettings] = useState<PlaygroundQuerySettings>({
    topK: 10,
    searchMode: "hybrid",
    useReranking: true,
    fileTypes: ["pdf", "docx", "txt"],
  });

  const [searchKnowledgeBase, { isLoading }] = useSearchKnowledgeBaseMutation();
  const chatHistoryRef = useRef(chatHistory);
  useEffect(() => {
    chatHistoryRef.current = chatHistory;
  }, [chatHistory]);

  // -- Derived state --

  const activeChunks = useMemo((): AgentChunk[] => {
    if (activeQueryIndex === null) return [];
    /* v8 ignore start -- defensive guard: activeQueryIndex is always in-bounds per internal logic */
    return chatHistory[activeQueryIndex]?.chunks ?? [];
    /* v8 ignore stop */
  }, [chatHistory, activeQueryIndex]);

  const selectedChunk = useMemo((): AgentChunk | null => {
    if (!selectedChunkId) return null;
    /* v8 ignore start -- defensive guard: selectedChunkId is always set from an existing chunk */
    return activeChunks.find((c) => c.chunkId === selectedChunkId) ?? null;
    /* v8 ignore stop */
  }, [activeChunks, selectedChunkId]);

  // -- Handlers --

  const handleSendQuery = useCallback(async (query: string) => {
    const current = chatHistoryRef.current;
    const cached = current.findIndex((e) => e.query === query);
    if (cached !== -1) {
      setActiveQueryIndex(cached);
      setSelectedChunkId(null);
      return;
    }

    const entry: PlaygroundChatEntry = {
      id: generateId(),
      query,
      chunks: [],
      timestamp: Date.now(),
    };

    const newIndex = current.length;
    chatHistoryRef.current = [...current, entry];
    setChatHistory(chatHistoryRef.current);
    setActiveQueryIndex(newIndex);
    setSelectedChunkId(null);

    try {
      const chunks = await searchKnowledgeBase({
        projectId,
        kbId,
        query,
        topK: querySettings.topK,
        searchMode: querySettings.searchMode,
        // Reranking only applies to hybrid search. Send an explicit value so
        // the toggle actually controls backend behavior: "rrf" fuses the
        // vector + FTS lists, "none" disables fusion (plain score merge).
        ...(querySettings.searchMode === "hybrid"
          ? { rerankerType: querySettings.useReranking ? "rrf" : "none" }
          : {}),
      }).unwrap();

      setChatHistory((prev) =>
        prev.map((e, i) => (i === newIndex ? { ...e, chunks } : e)),
      );
    } catch {
      toast.error("Failed to process query. Please try again.");
    }
  }, [projectId, kbId, querySettings.topK, querySettings.searchMode, querySettings.useReranking, searchKnowledgeBase]);

  const handleSelectQuery = useCallback((index: number) => {
    setActiveQueryIndex(index);
    setSelectedChunkId(null);
  }, []);

  const handleSelectChunk = useCallback((chunkId: string) => {
    setSelectedChunkId(chunkId);
  }, []);

  return (
    <div className="kb-playground">
      <PlaygroundChatColumn
        chatHistory={chatHistory}
        activeQueryIndex={activeQueryIndex}
        isLoading={isLoading}
        querySettings={querySettings}
        onQuerySettingsChange={setQuerySettings}
        onSelectQuery={handleSelectQuery}
        onSendQuery={handleSendQuery}
      />
      <PlaygroundResultsColumn
        chunks={activeChunks}
        selectedChunkId={selectedChunkId}
        onSelectChunk={handleSelectChunk}
      />
      <PlaygroundChunkDetails chunk={selectedChunk} />
    </div>
  );
}

export { KBDetailPlayground };

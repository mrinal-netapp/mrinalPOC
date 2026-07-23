import type { AgentChunk } from "@/api/agent.types";
import type { KbSearchMode } from "@/api/kb-search.types";

export type PlaygroundChatEntry = {
  id: string;
  query: string;
  chunks: AgentChunk[];
  timestamp: number;
};

export type PlaygroundQueryFileType = "pdf" | "docx" | "txt";

export type PlaygroundQuerySettings = {
  topK: number;
  searchMode: KbSearchMode;
  useReranking: boolean;
  fileTypes: PlaygroundQueryFileType[];
};

export type RelevanceTier = {
  label: string;
  color: "green" | "blue" | "orange";
  status: "success" | "info" | "warning";
  description: string;
};

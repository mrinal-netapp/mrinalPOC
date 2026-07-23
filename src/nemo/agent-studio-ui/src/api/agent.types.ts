export type AgentChatRequest = {
  query: string;
  overrides?: Record<string, unknown>;
  session?: {
    session_id: string;
  };
};

export type AgentChunk = {
  chunkId: string;
  content: string;
  score: number;
  metadata: {
    fileName: string;
    chunkIndex: number;
    datasetName?: string;
    filePath?: string;
    page?: number | string;
    section?: string;
    chunkPosition?: string;
    lastModified?: string;
  };
  relevance_score: number;
};

export type AgentChatResponse = {
  citations: {
    latency_seconds: number;
    model_id: string;
    temperature: number;
    llm_calls_count: number;
  };
  data: {
    answer: string | null;
    trace: {
      request_id: string;
    };
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    error: string | null;
  };
  trace: {
    request_id: string;
  };
};

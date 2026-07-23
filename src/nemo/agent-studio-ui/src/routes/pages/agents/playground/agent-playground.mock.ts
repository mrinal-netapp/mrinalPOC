export type AgentPlaygroundMode = "single-turn" | "multi-turn";

export type AgentPlaygroundConfig = {
  agentId: string;
  agentName: string;
  mode: AgentPlaygroundMode;
  instructions: string;
  temperature: number;
  topP: number;
  topKChunks: number;
  tokenLimit: number;
};

export type PlaygroundChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type PlaygroundRunStep = {
  id: string;
  title: string;
  status: string;
  durationMs: number;
  details?: {
    knowledgeBase?: string;
    topK?: string;
    totalTokens?: string;
    query?: string;
    chunks?: Array<{
      title: string;
      score: string;
      source: string;
      tokens: string;
    }>;
    logs?: string[];
  };
};

export const MOCK_AGENT_CONFIG: AgentPlaygroundConfig = {
  agentId: "agent-mock-01",
  agentName: "segment-performance-agent",
  mode: "single-turn",
  instructions:
    "The agent continuously monitors storage systems, analyzes performance trends, forecasts capacity exhaustion, detects bottlenecks, or placement mismatches, and recommends corrective actions.",
  temperature: 0.7,
  topP: 0.3,
  topKChunks: 6,
  tokenLimit: 3000,
};

export const MOCK_CHAT_MESSAGES: PlaygroundChatMessage[] = [
  {
    id: "msg-1",
    role: "user",
    content: "How do I troubleshoot slow volume performance?",
  },
  {
    id: "msg-2",
    role: "assistant",
    content:
      "To troubleshoot slow volume performance, start by checking service level limits and monitoring network latency. Review current volume analytics, performance metrics, and latency breakdown. Consider tier throughput and whether placement matches workload patterns.",
  },
];

export const MOCK_RUN_OPTIONS = [
  {
    id: "run-1",
    label: "Run 1: To troubleshoot slow volumes in Azure NetApp Files…",
  },
] as const;

export const MOCK_RUN_STEPS: PlaygroundRunStep[] = [
  {
    id: "step-1",
    title: "Step 1: Query analysis",
    status: "Completed",
    durationMs: 95,
  },
  {
    id: "step-2",
    title: "Step 2: Knowledge base retrieval",
    status: "Completed",
    durationMs: 95,
    details: {
      knowledgeBase: "skb-name-01",
      topK: "5 chunks",
      totalTokens: "711 tokens",
      query: "How do I troubleshoot slow volume performance?",
      chunks: [
        {
          title: "Performance guide",
          score: "97%",
          source: "docs/performance-guide.md",
          tokens: "256 tokens",
        },
        {
          title: "Troubleshooting guide",
          score: "89%",
          source: "docs/troubleshooting.md",
          tokens: "234 tokens",
        },
        {
          title: "Total retrieved context",
          score: "87%",
          source: "docs/troubleshooting.md",
          tokens: "221 tokens",
        },
      ],
      logs: [
        "[95ms] INFO Starting KB retrieval from ANF Documentation",
        "[125ms] DEBUG Embedding query vector: 768 dimensions",
        "[287ms] INFO Vector search complete: 8 chunks found",
        "[312ms] DEBUG Reranking chunks by relevance",
        "[456ms] INFO Returning top 5 chunks (711 tokens)",
        "[518ms] INFO Retrieval complete",
      ],
    },
  },
  {
    id: "step-3",
    title: "Step 3: Get volume metrics",
    status: "Completed",
    durationMs: 95,
  },
  {
    id: "step-4",
    title: "Step 4: Check service level",
    status: "Completed",
    durationMs: 95,
  },
  {
    id: "step-5",
    title: "Step 5: Model inference",
    status: "Completed",
    durationMs: 2279,
  },
];

export const MOCK_TRACING_PLACEHOLDER =
  "Tracing data will appear here after agent invocations are wired in Phase 2.";

export const MOCK_STATISTICS_PLACEHOLDER =
  "Token usage and latency statistics will appear here after live runs are connected.";

export const MOCK_CONFIGURATION_PLACEHOLDER =
  "Run configuration snapshot will appear here after live runs are connected.";

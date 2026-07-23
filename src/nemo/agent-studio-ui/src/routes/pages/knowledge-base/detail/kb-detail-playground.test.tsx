import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { AgentChunk } from "@/api/agent.types"
import type { PlaygroundChatEntry, PlaygroundQuerySettings } from "./kb-detail-playground.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockMutation = vi.fn()
let mockIsLoading = false

vi.mock("@/api/kb-api.slice", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSearchKnowledgeBaseMutation: () => [
      mockMutation,
      { isLoading: mockIsLoading },
    ],
  }
})

vi.mock("./playground-chat-column", () => ({
  PlaygroundChatColumn: ({
    chatHistory,
    activeQueryIndex,
    isLoading,
    querySettings,
    onQuerySettingsChange,
    onSelectQuery,
    onSendQuery,
  }: {
    chatHistory: PlaygroundChatEntry[];
    activeQueryIndex: number | null;
    isLoading: boolean;
    querySettings: PlaygroundQuerySettings;
    onQuerySettingsChange: (settings: PlaygroundQuerySettings) => void;
    onSelectQuery: (index: number) => void;
    onSendQuery: (query: string) => void;
  }) => (
    <div data-testid="chat-column">
      <span data-testid="chat-history-count">{chatHistory.length}</span>
      <span data-testid="active-query-index">{String(activeQueryIndex)}</span>
      <span data-testid="is-loading">{String(isLoading)}</span>
      <span data-testid="query-top-k">{String(querySettings.topK)}</span>
      <span data-testid="query-search-mode">{querySettings.searchMode}</span>
      <span data-testid="query-rerank">{String(querySettings.useReranking)}</span>
      <span data-testid="query-file-types">{querySettings.fileTypes.join(",")}</span>
      <button data-testid="send-query" onClick={() => onSendQuery("test query")}>
        Send
      </button>
      <button data-testid="send-second" onClick={() => onSendQuery("second query")}>
        Send Second
      </button>
      <button data-testid="send-duplicate" onClick={() => onSendQuery("test query")}>
        Duplicate
      </button>
      <button data-testid="select-query-0" onClick={() => onSelectQuery(0)}>
        Select 0
      </button>
      <button
        data-testid="set-query-settings"
        onClick={() =>
          onQuerySettingsChange({
            topK: 17,
            searchMode: "vector",
            useReranking: false,
            fileTypes: ["pdf", "docx"],
          })
        }
      >
        Set Query Settings
      </button>
      <button
        data-testid="set-hybrid-no-rerank"
        onClick={() =>
          onQuerySettingsChange({
            topK: 10,
            searchMode: "hybrid",
            useReranking: false,
            fileTypes: ["pdf", "docx", "txt"],
          })
        }
      >
        Set Hybrid No Rerank
      </button>
    </div>
  ),
}))

vi.mock("./playground-results-column", () => ({
  PlaygroundResultsColumn: ({
    chunks,
    selectedChunkId,
    onSelectChunk,
  }: {
    chunks: AgentChunk[];
    selectedChunkId: string | null;
    onSelectChunk: (chunkId: string) => void;
  }) => (
    <div data-testid="results-column">
      <span data-testid="chunks-count">{chunks.length}</span>
      <span data-testid="selected-chunk-id">{String(selectedChunkId)}</span>
      {chunks.map((c) => (
        <button
          key={c.chunkId}
          data-testid={`select-chunk-${c.chunkId}`}
          onClick={() => onSelectChunk(c.chunkId)}
        >
          {c.chunkId}
        </button>
      ))}
    </div>
  ),
}))

vi.mock("./playground-chunk-details", () => ({
  PlaygroundChunkDetails: ({ chunk }: { chunk: AgentChunk | null }) => (
    <div data-testid="details-column">
      <span data-testid="detail-chunk-id">{chunk?.chunkId ?? "null"}</span>
    </div>
  ),
}))

import { KBDetailPlayground } from "./kb-detail-playground"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CHUNKS: AgentChunk[] = [
  {
    chunkId: "c-1",
    content: "Installation guide content",
    score: 0.97,
    metadata: { fileName: "guide.pdf", chunkIndex: 0 },
    relevance_score: 0.97,
  },
  {
    chunkId: "c-2",
    content: "Troubleshooting content",
    score: 0.85,
    metadata: { fileName: "troubleshoot.pdf", chunkIndex: 1 },
    relevance_score: 0.85,
  },
];

const TEST_KB_ID = "kba64shx73"
const TEST_PROJECT_ID = "test-project"

function renderPlayground() {
  return renderWithProviders(
    <KBDetailPlayground kbId={TEST_KB_ID} projectId={TEST_PROJECT_ID} />,
  )
}

function makeMutationResponse(chunks: AgentChunk[]) {
  return {
    unwrap: () => Promise.resolve(chunks),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBDetailPlayground", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsLoading = false
  })

  it("[tag:playground] renders all 3 columns", () => {
    renderPlayground()

    expect(screen.getByTestId("chat-column")).toBeInTheDocument()
    expect(screen.getByTestId("results-column")).toBeInTheDocument()
    expect(screen.getByTestId("details-column")).toBeInTheDocument()
  })

  it("[tag:playground] initial state has empty history and null selections", () => {
    renderPlayground()

    expect(screen.getByTestId("chat-history-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-query-index")).toHaveTextContent("null")
    expect(screen.getByTestId("chunks-count")).toHaveTextContent("0")
    expect(screen.getByTestId("selected-chunk-id")).toHaveTextContent("null")
    expect(screen.getByTestId("detail-chunk-id")).toHaveTextContent("null")
  })

  it("[tag:playground] passes isLoading to chat column", () => {
    mockIsLoading = true
    renderPlayground()

    expect(screen.getByTestId("is-loading")).toHaveTextContent("true")
  })

  it("[tag:playground] sending a query updates chat history and results", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))

    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })
    expect(screen.getByTestId("active-query-index")).toHaveTextContent("0")
    expect(screen.getByTestId("chunks-count")).toHaveTextContent("2")
    expect(screen.getByTestId("selected-chunk-id")).toHaveTextContent("null")
  })

  it("[tag:playground] sending a duplicate query reuses cached entry", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })

    await user.click(screen.getByTestId("send-duplicate"))

    // still only 1 entry — no duplicate API call
    expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    expect(mockMutation).toHaveBeenCalledTimes(1)
  })

  it("[tag:playground] clicking a previous query switches active results", async () => {
    mockMutation
      .mockReturnValueOnce(makeMutationResponse(MOCK_CHUNKS))
      .mockReturnValueOnce(makeMutationResponse([MOCK_CHUNKS[0]]))

    renderPlayground()
    const user = userEvent.setup()

    // send first query (via "send-query" button which sends "test query")
    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })

    // select query 0 to switch back
    await user.click(screen.getByTestId("select-query-0"))
    expect(screen.getByTestId("active-query-index")).toHaveTextContent("0")
    expect(screen.getByTestId("selected-chunk-id")).toHaveTextContent("null")
  })

  it("[tag:playground] clicking a chunk updates the details column", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(screen.getByTestId("chunks-count")).toHaveTextContent("2")
    })

    await user.click(screen.getByTestId("select-chunk-c-1"))
    expect(screen.getByTestId("selected-chunk-id")).toHaveTextContent("c-1")
    expect(screen.getByTestId("detail-chunk-id")).toHaveTextContent("c-1")
  })

  it("[tag:playground] selecting a query clears selected chunk", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(screen.getByTestId("chunks-count")).toHaveTextContent("2")
    })

    await user.click(screen.getByTestId("select-chunk-c-1"))
    expect(screen.getByTestId("selected-chunk-id")).toHaveTextContent("c-1")

    await user.click(screen.getByTestId("select-query-0"))
    expect(screen.getByTestId("selected-chunk-id")).toHaveTextContent("null")
  })

  it("[tag:playground] handles API error gracefully", async () => {
    mockMutation.mockReturnValue({
      unwrap: () => Promise.reject(new Error("Network error")),
    })
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))

    // entry is added optimistically; on error it stays with empty chunks
    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })
    expect(screen.getByTestId("chunks-count")).toHaveTextContent("0")
  })

  it("[tag:playground] handles empty search results gracefully", async () => {
    mockMutation.mockReturnValue({
      unwrap: () => Promise.resolve([]),
    })
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))

    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })
    expect(screen.getByTestId("chunks-count")).toHaveTextContent("0")
  })

  it("[tag:playground] passes kbId to search mutation", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))

    await waitFor(() => {
      expect(mockMutation).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        kbId: TEST_KB_ID,
        query: "test query",
        topK: 10,
        searchMode: "hybrid",
        rerankerType: "rrf",
      })
    })
  })

  it("[tag:playground] omits rerankerType when reranking is disabled", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()
    const user = userEvent.setup()

    await user.click(screen.getByTestId("set-query-settings"))
    await user.click(screen.getByTestId("send-query"))

    await waitFor(() => {
      expect(mockMutation).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        kbId: TEST_KB_ID,
        query: "test query",
        topK: 17,
        searchMode: "vector",
      })
    })
  })

  it("[tag:playground] sends rerankerType none for hybrid search with reranking disabled", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()
    const user = userEvent.setup()

    await user.click(screen.getByTestId("set-hybrid-no-rerank"))
    await user.click(screen.getByTestId("send-query"))

    await waitFor(() => {
      expect(mockMutation).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        kbId: TEST_KB_ID,
        query: "test query",
        topK: 10,
        searchMode: "hybrid",
        rerankerType: "none",
      })
    })
  })

  it("[tag:playground] applies saved query settings topK and searchMode to mutation payload", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()
    const user = userEvent.setup()

    await user.click(screen.getByTestId("set-query-settings"))
    expect(screen.getByTestId("query-top-k")).toHaveTextContent("17")
    expect(screen.getByTestId("query-search-mode")).toHaveTextContent("vector")

    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(mockMutation).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        kbId: TEST_KB_ID,
        query: "test query",
        topK: 17,
        searchMode: "vector",
      })
    })
  })

  it("[tag:playground] persists rerank and file-type settings in local playground state", async () => {
    renderPlayground()
    const user = userEvent.setup()

    expect(screen.getByTestId("query-rerank")).toHaveTextContent("true")
    expect(screen.getByTestId("query-file-types")).toHaveTextContent("pdf,docx,txt")

    await user.click(screen.getByTestId("set-query-settings"))

    expect(screen.getByTestId("query-rerank")).toHaveTextContent("false")
    expect(screen.getByTestId("query-file-types")).toHaveTextContent("pdf,docx")
  })

  it("[tag:playground] sending a second query preserves existing entries in history", async () => {
    mockMutation
      .mockReturnValueOnce(makeMutationResponse(MOCK_CHUNKS))
      .mockReturnValueOnce(makeMutationResponse([MOCK_CHUNKS[0]]))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })

    await user.click(screen.getByTestId("send-second"))
    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("2")
    })
    expect(screen.getByTestId("active-query-index")).toHaveTextContent("1")
  })

  it("[tag:playground] rapid duplicate sends within same frame only create one entry", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()

    // fire the same query twice without awaiting the first render cycle
    await user.click(screen.getByTestId("send-query"))
    await user.click(screen.getByTestId("send-duplicate"))

    await waitFor(() => {
      expect(screen.getByTestId("chat-history-count")).toHaveTextContent("1")
    })
    expect(mockMutation).toHaveBeenCalledTimes(1)
  })

  it("[tag:playground] selectedChunkId not found in activeChunks shows null detail", async () => {
    mockMutation.mockReturnValue(makeMutationResponse(MOCK_CHUNKS))
    renderPlayground()

    const user = userEvent.setup()
    await user.click(screen.getByTestId("send-query"))
    await waitFor(() => {
      expect(screen.getByTestId("chunks-count")).toHaveTextContent("2")
    })

    // select a chunk, then send a new query that returns different chunks
    await user.click(screen.getByTestId("select-chunk-c-1"))
    expect(screen.getByTestId("detail-chunk-id")).toHaveTextContent("c-1")

    // select query 0 again — this clears selectedChunkId via handleSelectQuery
    await user.click(screen.getByTestId("select-query-0"))
    expect(screen.getByTestId("detail-chunk-id")).toHaveTextContent("null")
  })
})

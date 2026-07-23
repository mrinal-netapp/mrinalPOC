import React, { type ReactElement } from "react"
import { screen, within } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { PlaygroundChatEntry, PlaygroundQuerySettings } from "./kb-detail-playground.types"
import { PlaygroundChatColumn, type PlaygroundChatColumnProps } from "./playground-chat-column"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(query: string, timestamp = Date.now()): PlaygroundChatEntry {
  return {
    id: crypto.randomUUID(),
    query,
    chunks: [],
    timestamp,
  };
}

const DEFAULT_PROPS = {
  chatHistory: [] as PlaygroundChatEntry[],
  activeQueryIndex: null as number | null,
  isLoading: false,
  querySettings: {
    topK: 10,
    searchMode: "hybrid",
    useReranking: true,
    fileTypes: ["pdf", "docx", "txt"],
  } satisfies PlaygroundQuerySettings,
  onQuerySettingsChange: vi.fn(),
  onSelectQuery: vi.fn(),
  onSendQuery: vi.fn(),
};

function renderColumn(overrides: Partial<PlaygroundChatColumnProps> = {}) {
  const props = { ...DEFAULT_PROPS, ...overrides };
  return renderWithProviders(<PlaygroundChatColumn {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlaygroundChatColumn", () => {
  let rafCallbacks: FrameRequestCallback[];
  let roCleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    roCleanup = mockResizeObserver().cleanup;
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    roCleanup?.();
  });

  it("[tag:chat-column] renders header with Chat title", () => {
    renderColumn();
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("[tag:chat-column] renders empty state when no history", () => {
    renderColumn();
    expect(screen.getByText("Ask a question to test your knowledge base")).toBeInTheDocument();
  });

  it("[tag:chat-column] renders query bubbles from chatHistory", () => {
    const history = [
      makeEntry("First question", 1000),
      makeEntry("Second question", 2000),
    ];
    renderColumn({ chatHistory: history });

    expect(screen.getByText("First question")).toBeInTheDocument();
    expect(screen.getByText("Second question")).toBeInTheDocument();
  });

  it("[tag:chat-column] does not render empty state when history exists", () => {
    renderColumn({ chatHistory: [makeEntry("A question", 1000)] });
    expect(screen.queryByText("Ask a question to test your knowledge base")).not.toBeInTheDocument();
  });

  it("[tag:chat-column] clicking a bubble calls onSelectQuery with correct index", async () => {
    const onSelectQuery = vi.fn();
    const history = [makeEntry("Q1", 1000), makeEntry("Q2", 2000)];
    renderColumn({ chatHistory: history, onSelectQuery });

    const user = userEvent.setup();
    await user.click(screen.getByText("Q2"));
    expect(onSelectQuery).toHaveBeenCalledWith(1);
  });

  it("[tag:chat-column] active query bubble has active class", () => {
    const history = [makeEntry("Q1", 1000), makeEntry("Q2", 2000)];
    renderColumn({ chatHistory: history, activeQueryIndex: 0 });

    const bubble = screen.getByText("Q1").closest(".playground-chat__bubble");
    expect(bubble).toHaveClass("playground-chat__bubble--active");

    const otherBubble = screen.getByText("Q2").closest(".playground-chat__bubble");
    expect(otherBubble).not.toHaveClass("playground-chat__bubble--active");
  });

  it("[tag:chat-column] typing in textarea and clicking send calls onSendQuery", async () => {
    const onSendQuery = vi.fn();
    renderColumn({ onSendQuery });

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type your question here...");
    await user.type(textarea, "My test query");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSendQuery).toHaveBeenCalledWith("My test query");
  });

  it("[tag:chat-column] send button is disabled when textarea is empty", () => {
    renderColumn();
    const sendBtn = screen.getByRole("button", { name: "Send" });
    expect(sendBtn).toBeDisabled();
  });

  it("[tag:chat-column] send button is disabled when isLoading is true", async () => {
    renderColumn({ isLoading: true });

    const textarea = screen.getByPlaceholderText("Type your question here...");
    expect(textarea).toBeDisabled();
  });

  it("[tag:chat-column] Enter key submits the query", async () => {
    const onSendQuery = vi.fn();
    renderColumn({ onSendQuery });

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type your question here...");
    await user.type(textarea, "Enter query");
    await user.keyboard("{Enter}");

    expect(onSendQuery).toHaveBeenCalledWith("Enter query");
  });

  it("[tag:chat-column] Shift+Enter does not submit", async () => {
    const onSendQuery = vi.fn();
    renderColumn({ onSendQuery });

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type your question here...");
    await user.type(textarea, "Multi line");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSendQuery).not.toHaveBeenCalled();
  });

  it("[tag:chat-column] textarea clears after successful send", async () => {
    const onSendQuery = vi.fn();
    renderColumn({ onSendQuery });

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type your question here...") as HTMLTextAreaElement;
    await user.type(textarea, "Clear me");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(textarea.value).toBe("");
  });

  it("[tag:chat-column] Enter key on bubble selects it", async () => {
    const onSelectQuery = vi.fn();
    const history = [makeEntry("Q1", 1000)];
    renderColumn({ chatHistory: history, onSelectQuery });

    const user = userEvent.setup();
    const bubble = screen.getByText("Q1").closest("[role='button']") as HTMLElement;
    bubble.focus();
    await user.keyboard("{Enter}");

    expect(onSelectQuery).toHaveBeenCalledWith(0);
  });

  it("[tag:chat-column] Space key on bubble selects it", async () => {
    const onSelectQuery = vi.fn();
    const history = [makeEntry("Q1", 1000)];
    renderColumn({ chatHistory: history, onSelectQuery });

    const user = userEvent.setup();
    const bubble = screen.getByText("Q1").closest("[role='button']") as HTMLElement;
    bubble.focus();
    await user.keyboard(" ");

    expect(onSelectQuery).toHaveBeenCalledWith(0);
  });

  it("[tag:chat-column] does not send whitespace-only input", async () => {
    const onSendQuery = vi.fn();
    renderColumn({ onSendQuery });

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type your question here...");
    await user.type(textarea, "   ");
    await user.keyboard("{Enter}");

    expect(onSendQuery).not.toHaveBeenCalled();
  });

  it("[tag:chat-column] non-Enter/Space key on bubble does not select", async () => {
    const onSelectQuery = vi.fn();
    const history = [makeEntry("Q1", 1000)];
    renderColumn({ chatHistory: history, onSelectQuery });

    const user = userEvent.setup();
    const bubble = screen.getByText("Q1").closest("[role='button']") as HTMLElement;
    bubble.focus();
    await user.keyboard("{Tab}");

    expect(onSelectQuery).not.toHaveBeenCalled();
  });

  it("[tag:chat-column] auto-scrolls body when chatHistory has entries", () => {
    const history = [makeEntry("Q1", 1000), makeEntry("Q2", 2000)];
    renderColumn({ chatHistory: history });

    // The useEffect for scroll runs without error in jsdom
    expect(screen.getByText("Q1")).toBeInTheDocument();
    expect(screen.getByText("Q2")).toBeInTheDocument();
  });

  it("[tag:chat-column] resets textarea height via requestAnimationFrame after send", async () => {
    const onSendQuery = vi.fn();
    renderColumn({ onSendQuery });

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type your question here...") as HTMLTextAreaElement;
    await user.type(textarea, "Query to send");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // flush the rAF callback
    for (const cb of rafCallbacks) {
      cb(0);
    }

    expect(textarea.style.height).toBe("auto");
  });

  it("[tag:chat-column] renders query settings trigger and opens dialog", async () => {
    renderColumn();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Retrieval configuration")).toBeInTheDocument();
    expect(screen.getByText("Reranking configuration")).toBeInTheDocument();
    expect(screen.getByLabelText("Enable reranking")).toHaveAttribute("aria-checked", "true");
  });

  it("[tag:chat-column] Save applies query settings changes", async () => {
    const onQuerySettingsChange = vi.fn();
    renderColumn({ onQuerySettingsChange });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    const topKInput = screen.getByLabelText("Current slider value");
    await user.clear(topKInput);
    await user.type(topKInput, "15");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onQuerySettingsChange).toHaveBeenCalledWith({
      topK: 15,
      searchMode: "hybrid",
      useReranking: true,
      fileTypes: ["pdf", "docx", "txt"],
    });
  });

  it("[tag:chat-column] Save applies search mode selection", async () => {
    const onQuerySettingsChange = vi.fn();
    renderColumn({ onQuerySettingsChange });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    const dialog = screen.getByRole("dialog");
    const retrievalSection = within(dialog).getByText("Retrieval configuration").closest("section") as HTMLElement;
    const searchModeTrigger = retrievalSection.querySelector('[data-slot="select-dropdown-trigger"]') as HTMLElement;
    await user.click(searchModeTrigger);
    const vectorOption = document.querySelector('[data-slot="select-dropdown-item"][data-value="vector"]')
      ?? Array.from(document.querySelectorAll('[data-slot="select-dropdown-item"]')).find((el) => el.textContent?.includes("Vector"));
    await user.click(vectorOption as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onQuerySettingsChange).toHaveBeenCalledWith({
      topK: 10,
      searchMode: "vector",
      useReranking: true,
      fileTypes: ["pdf", "docx", "txt"],
    });
  });

  it("[tag:chat-column] Cancel does not apply unsaved query settings edits", async () => {
    const onQuerySettingsChange = vi.fn();
    renderColumn({ onQuerySettingsChange });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    const topKInput = screen.getByLabelText("Current slider value");
    await user.clear(topKInput);
    await user.type(topKInput, "99");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onQuerySettingsChange).not.toHaveBeenCalled();
  });

  it("[tag:chat-column] disables reranking toggle when search mode is not hybrid", async () => {
    const vectorSettings: PlaygroundQuerySettings = {
      ...DEFAULT_PROPS.querySettings,
      searchMode: "vector",
    };
    renderColumn({
      querySettings: vectorSettings,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    expect(screen.getByLabelText("Enable reranking")).toHaveAttribute("data-disabled", "");
    expect(
      screen.getByText("Reranking is available when search mode is Hybrid (Vector + FTS)."),
    ).toBeInTheDocument();
  });

  it("[tag:chat-column] saved rerank and file-type settings persist across reopen", async () => {
    function ControlledHarness(): ReactElement {
      const [settings, setSettings] = React.useState<PlaygroundQuerySettings>(DEFAULT_PROPS.querySettings);
      return (
        <PlaygroundChatColumn
          {...DEFAULT_PROPS}
          querySettings={settings}
          onQuerySettingsChange={setSettings}
        />
      );
    }

    renderWithProviders(<ControlledHarness />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    await user.click(screen.getByLabelText("Enable reranking"));
    await user.click(screen.getByLabelText("Remove txt"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.click(screen.getByRole("button", { name: "Query settings" }));
    expect(screen.getByLabelText("Enable reranking")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByLabelText("Remove txt")).not.toBeInTheDocument();
  });
});

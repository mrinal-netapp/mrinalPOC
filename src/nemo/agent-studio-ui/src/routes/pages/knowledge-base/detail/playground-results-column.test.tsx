import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import type { AgentChunk } from "@/api/agent.types";
import { PlaygroundResultsColumn } from "./playground-results-column";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<AgentChunk> = {}): AgentChunk {
  return {
    chunkId: "chunk-1",
    content: "This is the chunk content for testing purposes.",
    score: 0.95,
    metadata: {
      fileName: "guide.pdf",
      chunkIndex: 0,
    },
    relevance_score: 0.95,
    ...overrides,
  };
}

const CHUNKS: AgentChunk[] = [
  makeChunk({
    chunkId: "c-1",
    content: "Installation guide content for the product.",
    score: 0.97,
    metadata: { fileName: "install.pdf", chunkIndex: 0, datasetName: "Product Docs" },
    relevance_score: 0.97,
  }),
  makeChunk({
    chunkId: "c-2",
    content: "Troubleshooting common issues and workarounds.",
    score: 0.85,
    metadata: { fileName: "troubleshoot.md", chunkIndex: 1, datasetName: "Support KB" },
    relevance_score: 0.85,
  }),
  makeChunk({
    chunkId: "c-3",
    content: "Configuration reference for advanced settings.",
    score: 0.72,
    metadata: { fileName: "config-ref.txt", chunkIndex: 2 },
    relevance_score: 0.72,
  }),
];

const DEFAULT_PROPS = {
  chunks: [] as AgentChunk[],
  selectedChunkId: null as string | null,
  onSelectChunk: vi.fn(),
};

function renderColumn(overrides: Partial<typeof DEFAULT_PROPS> = {}) {
  const props = { ...DEFAULT_PROPS, ...overrides };
  return renderWithProviders(<PlaygroundResultsColumn {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlaygroundResultsColumn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:results-column] renders header with 'Retrieved results' title", () => {
    renderColumn();
    expect(screen.getByText("Retrieved results")).toBeInTheDocument();
  });

  it("[tag:results-column] renders empty state when no chunks", () => {
    renderColumn();
    expect(screen.getByText("Send a query to see retrieved results")).toBeInTheDocument();
  });

  it("[tag:results-column] renders correct number of chunk cards", () => {
    renderColumn({ chunks: CHUNKS });
    const cards = screen.getAllByRole("button");
    expect(cards).toHaveLength(3);
  });

  it("[tag:results-column] does not render empty state when chunks exist", () => {
    renderColumn({ chunks: CHUNKS });
    expect(screen.queryByText("Send a query to see retrieved results")).not.toBeInTheDocument();
  });

  it("[tag:results-column] each card displays fileName", () => {
    renderColumn({ chunks: CHUNKS });
    expect(screen.getByText("install.pdf")).toBeInTheDocument();
    expect(screen.getByText("troubleshoot.md")).toBeInTheDocument();
    expect(screen.getByText("config-ref.txt")).toBeInTheDocument();
  });

  it("[tag:results-column] each card displays datasetName when present", () => {
    renderColumn({ chunks: CHUNKS });
    expect(screen.getByText("Product Docs")).toBeInTheDocument();
    expect(screen.getByText("Support KB")).toBeInTheDocument();
  });

  it("[tag:results-column] each card displays content preview", () => {
    renderColumn({ chunks: CHUNKS });
    expect(screen.getByText("Installation guide content for the product.")).toBeInTheDocument();
    expect(screen.getByText("Troubleshooting common issues and workarounds.")).toBeInTheDocument();
    expect(screen.getByText("Configuration reference for advanced settings.")).toBeInTheDocument();
  });

  it("[tag:results-column] each card displays score badge with relevance label", () => {
    renderColumn({ chunks: CHUNKS });
    // 97% → "Highly relevant", 85% → "Relevant", 72% → "Somewhat relevant"
    expect(screen.getByText("97% (Highly relevant)")).toBeInTheDocument();
    expect(screen.getByText("85% (Relevant)")).toBeInTheDocument();
    expect(screen.getByText("72% (Somewhat relevant)")).toBeInTheDocument();
  });

  it("[tag:results-column] score badge colors: green for >= 90%", () => {
    renderColumn({ chunks: [CHUNKS[0]] });
    const statusDot = document.querySelector(".card-block__status-dot--success");
    expect(statusDot).toBeInTheDocument();
  });

  it("[tag:results-column] score badge colors: blue for >= 80%", () => {
    renderColumn({ chunks: [CHUNKS[1]] });
    const statusDot = document.querySelector(".card-block__status-dot--info");
    expect(statusDot).toBeInTheDocument();
  });

  it("[tag:results-column] score badge colors: orange for < 80%", () => {
    renderColumn({ chunks: [CHUNKS[2]] });
    const statusDot = document.querySelector(".card-block__status-dot--warning");
    expect(statusDot).toBeInTheDocument();
  });

  it("[tag:results-column] clicking a card calls onSelectChunk with correct chunkId", async () => {
    const onSelectChunk = vi.fn();
    renderColumn({ chunks: CHUNKS, onSelectChunk });

    const user = userEvent.setup();
    await user.click(screen.getByText("troubleshoot.md"));
    expect(onSelectChunk).toHaveBeenCalledWith("c-2");
  });

  it("[tag:results-column] selected card has the selected class", () => {
    renderColumn({ chunks: CHUNKS, selectedChunkId: "c-1" });

    const selectedCard = screen.getByText("install.pdf").closest(".playground-results__chunk-card");
    expect(selectedCard).toHaveClass("playground-results__chunk-card--selected");

    const otherCard = screen.getByText("troubleshoot.md").closest(".playground-results__chunk-card");
    expect(otherCard).not.toHaveClass("playground-results__chunk-card--selected");
  });

  it("[tag:results-column] Enter key on card selects it", async () => {
    const onSelectChunk = vi.fn();
    renderColumn({ chunks: CHUNKS, onSelectChunk });

    const user = userEvent.setup();
    const card = screen.getByText("install.pdf").closest("[role='button']") as HTMLElement;
    card.focus();
    await user.keyboard("{Enter}");

    expect(onSelectChunk).toHaveBeenCalledWith("c-1");
  });

  it("[tag:results-column] Space key on card selects it", async () => {
    const onSelectChunk = vi.fn();
    renderColumn({ chunks: CHUNKS, onSelectChunk });

    const user = userEvent.setup();
    const card = screen.getByText("config-ref.txt").closest("[role='button']") as HTMLElement;
    card.focus();
    await user.keyboard(" ");

    expect(onSelectChunk).toHaveBeenCalledWith("c-3");
  });

  it("[tag:results-column] card without datasetName does not render subtitle", () => {
    renderColumn({ chunks: [CHUNKS[2]] });
    expect(screen.getByText("config-ref.txt")).toBeInTheDocument();
    // c-3 has no datasetName — ensure no extra subtitle element
    const titleContainer = screen.getByText("config-ref.txt").closest(".playground-results__chunk-title");
    const spans = titleContainer?.querySelectorAll("[class*='typography']");
    // only fileName, no dataset subtitle
    expect(spans?.length).toBe(1);
  });

  it("[tag:results-column] chunks are rendered sorted by score descending", () => {
    renderColumn({ chunks: CHUNKS });

    const cards = screen.getAllByRole("button");
    const fileNames = cards.map((card) => {
      const title = card.querySelector(".playground-results__chunk-title");
      return title?.querySelector("[class*='typography']")?.textContent;
    });

    // c-1 (0.97) > c-2 (0.85) > c-3 (0.72)
    expect(fileNames).toEqual(["install.pdf", "troubleshoot.md", "config-ref.txt"]);
  });

  it("[tag:results-column] lower-score chunk rendered first when it has highest relevance after re-order", () => {
    const reversed: AgentChunk[] = [
      CHUNKS[2], // 0.72
      CHUNKS[0], // 0.97
      CHUNKS[1], // 0.85
    ];
    renderColumn({ chunks: reversed });

    const cards = screen.getAllByRole("button");
    const fileNames = cards.map((card) => {
      const title = card.querySelector(".playground-results__chunk-title");
      return title?.querySelector("[class*='typography']")?.textContent;
    });

    // sorted desc: 0.97, 0.85, 0.72 regardless of input order
    expect(fileNames).toEqual(["install.pdf", "troubleshoot.md", "config-ref.txt"]);
  });

  it("[tag:results-column] non-Enter/Space key on card does not select", async () => {
    const onSelectChunk = vi.fn();
    renderColumn({ chunks: CHUNKS, onSelectChunk });

    const user = userEvent.setup();
    const card = screen.getByText("install.pdf").closest("[role='button']") as HTMLElement;
    card.focus();
    await user.keyboard("{Tab}");

    expect(onSelectChunk).not.toHaveBeenCalled();
  });
});

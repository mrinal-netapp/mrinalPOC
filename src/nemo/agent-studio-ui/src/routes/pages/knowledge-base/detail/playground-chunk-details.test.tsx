import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders } from "@test/render";
import type { AgentChunk } from "@/api/agent.types";
import { PlaygroundChunkDetails } from "./playground-chunk-details";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_CHUNK: AgentChunk = {
  chunkId: "chunk-full",
  content: "This is the full content of the chunk used for testing.",
  score: 0.93,
  metadata: {
    fileName: "architecture.pdf",
    chunkIndex: 4,
  },
  relevance_score: 0.93,
};

const MINIMAL_CHUNK: AgentChunk = {
  chunkId: "chunk-minimal",
  content: "Minimal chunk content.",
  score: 0.72,
  metadata: {
    fileName: "readme.md",
    chunkIndex: 0,
  },
  relevance_score: 0.72,
};

function renderDetails(chunk: AgentChunk | null = null) {
  return renderWithProviders(<PlaygroundChunkDetails chunk={chunk} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlaygroundChunkDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:chunk-details] renders header with 'Chunk details' title", () => {
    renderDetails();
    expect(screen.getByText("Chunk details")).toBeInTheDocument();
  });

  it("[tag:chunk-details] shows empty state when chunk is null", () => {
    renderDetails(null);
    expect(screen.getByText("Select a chunk to view details")).toBeInTheDocument();
  });

  it("[tag:chunk-details] does not show empty state when chunk is provided", () => {
    renderDetails(FULL_CHUNK);
    expect(screen.queryByText("Select a chunk to view details")).not.toBeInTheDocument();
  });

  it("[tag:chunk-details] renders all field labels", () => {
    renderDetails(FULL_CHUNK);

    const labels = [
      "Score",
      "Full content",
      "Source document",
      "Chunk position",
    ];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("[tag:chunk-details] does not render removed metadata field labels", () => {
    renderDetails(FULL_CHUNK);

    const removedLabels = [
      "Dataset",
      "File path",
      "Page",
      "Section",
      "Last modified",
    ];
    for (const label of removedLabels) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("[tag:chunk-details] renders correct field values for a fully populated chunk", () => {
    renderDetails(FULL_CHUNK);

    expect(screen.getByText("This is the full content of the chunk used for testing.")).toBeInTheDocument();
    expect(screen.getByText("architecture.pdf")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("[tag:chunk-details] score displays percentage and relevance tier text", () => {
    renderDetails(FULL_CHUNK);
    expect(screen.getByText("93% (Highly relevant)")).toBeInTheDocument();
  });

  it("[tag:chunk-details] score shows description text", () => {
    renderDetails(FULL_CHUNK);
    expect(screen.getByText("Excellent match! This content directly answers your question.")).toBeInTheDocument();
  });

  it("[tag:chunk-details] score has correct status dot for highly relevant", () => {
    renderDetails(FULL_CHUNK);
    const statusDot = document.querySelector(".card-block__status-dot--success");
    expect(statusDot).toBeInTheDocument();
  });

  it("[tag:chunk-details] chunk position displays chunkIndex from API", () => {
    renderDetails(MINIMAL_CHUNK);

    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("[tag:chunk-details] missing chunkIndex shows '---' fallback", () => {
    const chunkWithoutIndex: AgentChunk = {
      ...FULL_CHUNK,
      metadata: { fileName: "architecture.pdf", chunkIndex: undefined as unknown as number },
    };
    renderDetails(chunkWithoutIndex);

    expect(screen.getByText("---")).toBeInTheDocument();
  });

  it("[tag:chunk-details] renders score tier for a lower-scoring chunk", () => {
    renderDetails(MINIMAL_CHUNK);
    expect(screen.getByText("72% (Somewhat relevant)")).toBeInTheDocument();
    expect(screen.getByText("Partial match. This content may contain useful information.")).toBeInTheDocument();
  });

  it("[tag:chunk-details] renders warning status dot for lower score", () => {
    renderDetails(MINIMAL_CHUNK);
    const statusDot = document.querySelector(".card-block__status-dot--warning");
    expect(statusDot).toBeInTheDocument();
  });

  it("[tag:chunk-details] empty fileName shows fallback", () => {
    const chunkWithEmptyFileName: AgentChunk = {
      ...FULL_CHUNK,
      chunkId: "chunk-empty-fn",
      metadata: { ...FULL_CHUNK.metadata, fileName: "" },
    };
    renderDetails(chunkWithEmptyFileName);

    expect(screen.getByText("---")).toBeInTheDocument();
  });
});

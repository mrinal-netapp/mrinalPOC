import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { KBEmbeddingChunkingSection } from "./kb-embedding-chunking-section"
import { TestFormWrapper } from "./test-helpers"

const mockUseKbEmbeddingModelOptions = vi.fn(() => ({
  items: [
    {
      key: "all-minilm-l6-v2",
      value: "sentence-transformers/all-MiniLM-L6-v2",
      label: "all-MiniLM-L6-v2 (Default)",
    },
    {
      key: "mdl-remote-1",
      value: "Text Embedding 3 Large",
      label: "Text Embedding 3 Large (openai)",
    },
  ],
  dimensionsByName: {
    "sentence-transformers/all-MiniLM-L6-v2": 384,
    "Text Embedding 3 Large": 3072,
  },
  isLoading: false,
}))

vi.mock("./use-kb-embedding-model-options", () => ({
  useKbEmbeddingModelOptions: () => mockUseKbEmbeddingModelOptions(),
}))

describe("KBEmbeddingChunkingSection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-embedding-section] renders section header", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBEmbeddingChunkingSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Embedding & chunking configuration")).toBeInTheDocument()
  })

  it("[tag:kb-embedding-section] renders embedding model dropdown", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBEmbeddingChunkingSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Embedding model")).toBeInTheDocument()
  })

  it("[tag:kb-embedding-section] renders chunking strategy dropdown with default selection", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBEmbeddingChunkingSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Chunking strategy")).toBeInTheDocument()
    expect(screen.getByText("Fixed Size")).toBeInTheDocument()
  })

  it("[tag:kb-embedding-section] renders embedding dimensions value beside label", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBEmbeddingChunkingSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Embedding dimensions - 384")).toBeInTheDocument()
  })

  it("[tag:kb-embedding-section] renders fixed size strategy sliders by default", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBEmbeddingChunkingSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Chunk size")).toBeInTheDocument()
    expect(screen.getByText("Chunk overlap")).toBeInTheDocument()
  })

  it("[tag:kb-embedding-section] loads merged embedding options from the project catalog hook", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBEmbeddingChunkingSection form={form} />}</TestFormWrapper>,
    )
    expect(mockUseKbEmbeddingModelOptions).toHaveBeenCalled()
    expect(mockUseKbEmbeddingModelOptions.mock.results[0]?.value.items).toHaveLength(2)
  })
})

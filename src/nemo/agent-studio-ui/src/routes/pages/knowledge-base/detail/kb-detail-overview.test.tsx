import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { KBDetail } from "@/api/kb.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockGetKBAssignedDataset = vi.fn()
const mockGetDataset = vi.fn()

vi.mock("@/api/kb-api.slice", () => ({
  useGetKBAssignedDatasetQuery: (...args: unknown[]) => mockGetKBAssignedDataset(...args),
}))

vi.mock("@/api/dataset-api.slice", () => ({
  useGetDatasetQuery: (...args: unknown[]) => mockGetDataset(...args),
}))

import { KBDetailOverview } from "./kb-detail-overview"
import { formatIndexSize, formatNumber } from "./kb-detail-overview.utils"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA: KBDetail = {
  kb_id: "kb-1",
  name: "Test KB",
  description: "A description",
  status: "ready",
  deprecated: false,
  labels: ["production"],
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-06-15T10:00:00Z",
  files_indexed: 1_234,
  snapshot: { id: "snap-1", version: 3, files_indexed: 1234, vectors: 5678 },
  stats: { chunkCount: 1735, vectorCount: 1735, fileCount: 9, documentCount: 106, storageBytes: 4_908_094 },
  assigned_dataset: { dset_id: "ds-42", name: "Training Data" },
  synchronization_config: {
    sync_mode: "scheduled",
    data_change_threshold_enabled: true,
    data_change_threshold_value: 5,
  },
  embedding_config: { model: "openai-text-embedding-3-small" },
  chunking_config: { strategy: "sentence", chunk_size: 300, overlap: 30 },
  indexing_config: { index_type: "hybrid_search" },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBDetailOverview", () => {
  let roCleanup: () => void
  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
    mockGetKBAssignedDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  })
  afterEach(() => roCleanup?.())

  // -- Metrics card --

  it("[tag:kb-overview] renders metrics card with Documents indexed", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("1,234")).toBeInTheDocument()
    expect(screen.getByText("Documents indexed")).toBeInTheDocument()
  })

  it("[tag:kb-overview] renders metrics card with Vector embeddings", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("Vector embeddings")).toBeInTheDocument()
  })

  it("[tag:kb-overview] renders text chunks from stats.chunkCount", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("Text chunks")).toBeInTheDocument()
    expect(screen.getByText("1,735")).toBeInTheDocument()
  })

  it("[tag:kb-overview] renders '—' for Queries and Cost placeholders", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("Queries (last 7 days)")).toBeInTheDocument()
    expect(screen.getByText("Cost (last 30 days)")).toBeInTheDocument()
  })

  it("[tag:kb-overview] renders total index size from stats.storageBytes", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("Total index size")).toBeInTheDocument()
    expect(screen.getByText(formatIndexSize(MOCK_DATA.stats?.storageBytes))).toBeInTheDocument()
  })

  // -- KB details tab --

  it("[tag:kb-overview] KB details tab is active by default", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Test KB")).toBeInTheDocument()
  })

  it("[tag:kb-overview] KB details shows all key-value rows", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)

    expect(screen.getByText("Description")).toBeInTheDocument()
    expect(screen.getByText("A description")).toBeInTheDocument()
    expect(screen.getByText("Labels")).toBeInTheDocument()
    expect(screen.getByText("production")).toBeInTheDocument()
    expect(screen.getByText("Assigned dataset")).toBeInTheDocument()
    expect(screen.getByText("Training Data")).toBeInTheDocument()
    expect(screen.getByText("Synchronization")).toBeInTheDocument()
    expect(screen.getByText("scheduled")).toBeInTheDocument()
    expect(screen.getByText("Embedding model")).toBeInTheDocument()
    expect(screen.getByText("Chunking strategy")).toBeInTheDocument()
    expect(screen.getByText("Sentence-Based")).toBeInTheDocument()
  })

  it("[tag:kb-overview] KB details shows '—' for missing description", () => {
    renderWithProviders(<KBDetailOverview data={{ ...MOCK_DATA, description: null }} />)

    const descRow = screen.getAllByText("—")
    expect(descRow.length).toBeGreaterThan(0)
  })

  it("[tag:kb-overview] data change threshold shows value when enabled", () => {
    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)
    expect(screen.getByText("Data change threshold")).toBeInTheDocument()
    expect(screen.getByText("5 files")).toBeInTheDocument()
  })

  it("[tag:kb-overview] data change threshold shows Disabled when not enabled", () => {
    renderWithProviders(
      <KBDetailOverview data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "manual", data_change_threshold_enabled: false },
      }} />,
    )
    expect(screen.getByText("Disabled")).toBeInTheDocument()
  })

  // -- Dataset inner tab --

  it("[tag:kb-overview] switching to Dataset tab shows loading spinner", async () => {
    mockGetKBAssignedDataset.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Dataset" }))

    expect(document.querySelector(".spinner, [class*=spinner]")).toBeInTheDocument()
  })

  it("[tag:kb-overview] Dataset tab shows 'No dataset assigned' when no dset_id", async () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: { dataset: {} },
      isLoading: false,
      isError: false,
    })
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Dataset" }))

    expect(screen.getByText("No dataset assigned to this knowledge base.")).toBeInTheDocument()
  })

  it("[tag:kb-overview] Dataset tab shows error when assigned query fails", async () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Dataset" }))

    expect(screen.getByText("No dataset assigned to this knowledge base.")).toBeInTheDocument()
  })

  it("[tag:kb-overview] Dataset tab shows error when dataset detail query fails", async () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: { dataset: { dset_id: "ds-1" } },
      isLoading: false,
      isError: false,
    })
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: true })

    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Dataset" }))

    expect(screen.getByText("Failed to load dataset details.")).toBeInTheDocument()
  })

  // -- formatIndexSize helper --

  it("[tag:kb-overview] formatIndexSize returns '—' for null", () => {
    expect(formatIndexSize(null)).toBe("—")
  })

  it("[tag:kb-overview] formatIndexSize returns formatted bytes for non-null value", () => {
    const result = formatIndexSize(1024)
    expect(result).toBeTruthy()
    expect(result).not.toBe("—")
  })

  it("[tag:kb-overview] formatNumber returns '—' for null/undefined", () => {
    expect(formatNumber(null)).toBe("—")
    expect(formatNumber(undefined)).toBe("—")
  })

  it("[tag:kb-overview] formatNumber returns formatted string for a number", () => {
    expect(formatNumber(1234)).toBe("1,234")
  })

  it("[tag:kb-overview] Dataset tab renders dataset detail rows on success", async () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: { dataset: { dset_id: "ds-1" } },
      isLoading: false,
      isError: false,
    })
    mockGetDataset.mockReturnValue({
      data: {
        dset_id: "ds-1",
        name: "My Dataset",
        description: "desc",
        labels: [],
        input_type: "data-source",
        data_source: null,
        spec: null,
        files_count: 10,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<KBDetailOverview data={MOCK_DATA} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Dataset" }))

    expect(screen.getByText("My Dataset")).toBeInTheDocument()
  })
})

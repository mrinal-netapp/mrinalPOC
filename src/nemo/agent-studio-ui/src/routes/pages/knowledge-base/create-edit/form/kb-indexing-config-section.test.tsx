import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { KBIndexingConfigSection } from "./kb-indexing-config-section"
import { TestFormWrapper } from "./test-helpers"

describe("KBIndexingConfigSection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-indexing-section] renders section header", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBIndexingConfigSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Indexing configuration")).toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] renders index type dropdown", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBIndexingConfigSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Index type")).toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] renders vector index dropdown", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBIndexingConfigSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Vector Index")).toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] hides placeholder estimate content", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBIndexingConfigSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.queryByText(/Estimate, per vector/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Storage estimate, per 1M vectors/)).not.toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] hides vector index configuration dropdown", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBIndexingConfigSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.queryByText("Vector index configuration")).not.toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] renders ivf_pq tuning fields when selected", () => {
    renderWithProviders(
      <TestFormWrapper overrides={{ vector_quantization: "ivf_pq" }}>
        {(form) => <KBIndexingConfigSection form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("Num Partitions")).toBeInTheDocument()
    expect(screen.getByText("Num Sub-Vectors")).toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] renders scalar tuning fields when selected", () => {
    renderWithProviders(
      <TestFormWrapper overrides={{ vector_quantization: "scalar" }}>
        {(form) => <KBIndexingConfigSection form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("ef_construction")).toBeInTheDocument()
    expect(screen.getByText("m (Connectivity)")).toBeInTheDocument()
  })

  it("[tag:kb-indexing-section] renders ivf_rq tuning fields when selected", () => {
    renderWithProviders(
      <TestFormWrapper overrides={{ vector_quantization: "ivf_rq" }}>
        {(form) => <KBIndexingConfigSection form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("Num Bits")).toBeInTheDocument()
  })
})

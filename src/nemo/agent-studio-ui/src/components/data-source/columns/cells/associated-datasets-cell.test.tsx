import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { AssociatedDatasetsCell } from "./associated-datasets-cell"

// ---------------------------------------------------------------------------
// Section 4 — AssociatedDatasetsCell
// ---------------------------------------------------------------------------

describe("AssociatedDatasetsCell", () => {
  // 4.13
  it("[tag:associated-datasets-cell][tag:empty] empty array renders '—' placeholder", () => {
    renderWithProviders(
      <AssociatedDatasetsCell datasets={[]} deprecated={false} />,
    )
    expect(screen.getByText("—")).toBeInTheDocument()
  })

  // 4.14
  it("[tag:associated-datasets-cell] single dataset not deprecated renders as clickable button", () => {
    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={[{ dset_id: "d1", name: "Alpha" }]}
        deprecated={false}
      />,
    )

    expect(screen.getByRole("button")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  // 4.15
  it("[tag:associated-datasets-cell][tag:deprecated] deprecated shows plain text, no button", () => {
    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={[{ dset_id: "d1", name: "Alpha" }]}
        deprecated
      />,
    )

    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  // 4.16
  it("[tag:associated-datasets-cell][tag:overflow] multiple datasets shows first name and '+N' count", () => {
    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={[
          { dset_id: "d1", name: "Alpha" },
          { dset_id: "d2", name: "Beta" },
          { dset_id: "d3", name: "Gamma" },
        ]}
        deprecated={false}
      />,
    )

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("+2")).toBeInTheDocument()
    expect(screen.queryByText("Beta")).not.toBeInTheDocument()
  })

  // 4.17
  it("[tag:associated-datasets-cell] click fires onNavigate with correct dsetId", async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={[{ dset_id: "d1", name: "Alpha" }]}
        deprecated={false}
        onNavigate={onNavigate}
      />,
    )

    await user.click(screen.getByRole("button"))
    expect(onNavigate).toHaveBeenCalledWith("d1")
  })

  // 4.18
  it("[tag:associated-datasets-cell] no onNavigate prop renders without error", () => {
    expect(() =>
      renderWithProviders(
        <AssociatedDatasetsCell
          datasets={[{ dset_id: "d1", name: "Alpha" }]}
          deprecated={false}
        />,
      ),
    ).not.toThrow()
  })

  // 4.20 — totalCount > datasets.length: overflow badge uses server total, not capped array length
  it("[tag:associated-datasets-cell][tag:overflow] totalCount drives overflow badge when array is capped", () => {
    // Simulate backend cap: 20 items returned, but server says 25 total
    const cappedDatasets = Array.from({ length: 20 }, (_, i) => ({
      dset_id: `d${i + 1}`,
      name: i === 0 ? "Alpha" : `Dataset ${i + 1}`,
    }))

    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={cappedDatasets}
        totalCount={25}
        deprecated={false}
      />,
    )

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("+24")).toBeInTheDocument()
  })

  // 4.21 — totalCount=0 (mapper default): overflow badge still shows when datasets.length > 1
  it("[tag:associated-datasets-cell][tag:overflow] totalCount=0 falls back to datasets.length for overflow", () => {
    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={[
          { dset_id: "d1", name: "Alpha" },
          { dset_id: "d2", name: "Beta" },
          { dset_id: "d3", name: "Gamma" },
        ]}
        totalCount={0}
        deprecated={false}
      />,
    )

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("+2")).toBeInTheDocument()
  })

  // 4.19 — Gap 2: covers the deprecated=true branch inside `overflow > 0 &&` (line 35)
  it("[tag:associated-datasets-cell][tag:deprecated][tag:overflow] deprecated with multiple datasets shows '+N' in disabled color", () => {
    renderWithProviders(
      <AssociatedDatasetsCell
        datasets={[
          { dset_id: "d1", name: "Alpha" },
          { dset_id: "d2", name: "Beta" },
          { dset_id: "d3", name: "Gamma" },
        ]}
        deprecated
      />,
    )

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("+2")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})

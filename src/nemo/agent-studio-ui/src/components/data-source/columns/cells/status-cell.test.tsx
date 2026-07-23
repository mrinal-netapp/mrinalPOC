import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"
import { StatusCell, ScanStatusCell, DatasetStatusCell, ActivityStatusCell } from "./status-cell"

// ---------------------------------------------------------------------------
// Section 4 — StatusCell / ScanStatusCell / DatasetStatusCell / ActivityStatusCell
// ---------------------------------------------------------------------------

describe("StatusCell", () => {
  // 4.1
  it("[tag:status-cell][tag:healthy] renders check icon area and 'Healthy' label", () => {
    renderWithProviders(<StatusCell status="Healthy" deprecated={false} />)
    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })

  // 4.2
  it("[tag:status-cell][tag:unhealthy] renders 'Unhealthy' label", () => {
    renderWithProviders(<StatusCell status="Unhealthy" deprecated={false} />)
    expect(screen.getByText("Unhealthy")).toBeInTheDocument()
  })

  // 4.3
  it("[tag:status-cell][tag:failed] renders 'Failed' label", () => {
    renderWithProviders(<StatusCell status="Failed" deprecated={false} />)
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  // 4.4
  it("[tag:status-cell][tag:initializing] renders Spinner for Initializing (not an icon)", () => {
    const { container } = renderWithProviders(<StatusCell status="Initializing" deprecated={false} />)
    // StatusIcon with type='spinner' renders the Spinner component — no <svg> for an icon
    expect(container.querySelector(".spinner")).toBeInTheDocument()
    expect(screen.getByText("Initializing")).toBeInTheDocument()
  })

  // 4.5
  it("[tag:status-cell][tag:deprecated] overrides to 'Deprecated' label regardless of status", () => {
    renderWithProviders(<StatusCell status="Healthy" deprecated />)
    expect(screen.getByText("Deprecated")).toBeInTheDocument()
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument()
  })
})

describe("ScanStatusCell", () => {
  // 4.6
  it("[tag:scan-status-cell][tag:completed] renders 'Scanned' label (not 'Completed')", () => {
    renderWithProviders(<ScanStatusCell status="Completed" />)
    expect(screen.getByText("Scanned")).toBeInTheDocument()
    expect(screen.queryByText("Completed")).not.toBeInTheDocument()
  })

  // 4.7
  it("[tag:scan-status-cell][tag:scanning] renders Spinner for Scanning", () => {
    const { container } = renderWithProviders(<ScanStatusCell status="Scanning" />)
    expect(container.querySelector(".spinner")).toBeInTheDocument()
  })

  // 4.8
  it("[tag:scan-status-cell][tag:unscanned] renders warning icon area and 'Unscanned' label", () => {
    renderWithProviders(<ScanStatusCell status="Unscanned" />)
    expect(screen.getByText("Unscanned")).toBeInTheDocument()
  })

  // 4.9
  it("[tag:scan-status-cell][tag:failed] renders error icon area and 'Failed' label", () => {
    renderWithProviders(<ScanStatusCell status="Failed" />)
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })
})

describe("DatasetStatusCell", () => {
  // 4.10
  it("[tag:dataset-status-cell] renders correct label for each DatasetStatus", () => {
    const statuses = ["Draft", "Healthy", "Unhealthy", "Ready", "Failed"] as const

    for (const status of statuses) {
      const { unmount } = renderWithProviders(<DatasetStatusCell status={status} />)
      expect(screen.getByText(status)).toBeInTheDocument()
      unmount()
    }
  })

  it("[tag:dataset-status-cell] Draft uses spinner-free icon (CircleMinus)", () => {
    const { container } = renderWithProviders(<DatasetStatusCell status="Draft" />)
    // Draft uses type='icon' — a spinner element should NOT be present
    expect(container.querySelector(".spinner")).not.toBeInTheDocument()
  })
})

describe("ActivityStatusCell", () => {
  // 4.11
  it("[tag:activity-status-cell][tag:in-progress] renders Spinner for 'In Progress'", () => {
    const { container } = renderWithProviders(<ActivityStatusCell status="In Progress" />)
    expect(container.querySelector(".spinner")).toBeInTheDocument()
  })

  // 4.12
  it("[tag:activity-status-cell] Success, Failed, Warning each render the correct label", () => {
    const statuses = ["Success", "Failed", "Warning"] as const

    for (const status of statuses) {
      const { unmount } = renderWithProviders(<ActivityStatusCell status={status} />)
      expect(screen.getByText(status)).toBeInTheDocument()
      unmount()
    }
  })
})

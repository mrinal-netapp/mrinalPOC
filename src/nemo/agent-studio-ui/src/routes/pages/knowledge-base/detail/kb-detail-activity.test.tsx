import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import type { ReactNode } from "react"
import { vi } from "vitest"

import { renderWithProviders } from "@test/render"
import type { KBDetail } from "@/api/kb.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    columns,
  }: {
    data: Array<Record<string, unknown>>
    columns: Array<{ cell?: (ctx: { row: { original: Record<string, unknown> } }) => ReactNode }>
  }) => (
    <div data-testid="activity-table">
      {data.length === 0 && <span data-testid="table-empty">No data</span>}
      {data.map((row, i) => (
        <div key={i} data-testid="activity-row">
          {columns.map((col, ci) => (
            <span key={ci}>{col.cell?.({ row: { original: row } })}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}))

import { KBDetailActivity } from "./kb-detail-activity"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA_WITH_ACTIVITY: KBDetail = {
  kb_id: "kb-1",
  name: "Test KB",
  status: "ready",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  activity: [
    {
      event: "Sync started",
      status: "ready",
      duration: 5,
      timestamp: "2024-06-15T10:00:00Z",
    },
    {
      event: "Sync completed",
      status: "ready",
      duration: 10,
      timestamp: "2024-06-15T10:05:00Z",
    },
  ],
}

const MOCK_DATA_EMPTY: KBDetail = {
  kb_id: "kb-2",
  name: "Empty KB",
  status: "in_progress",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  activity: [],
}

const MOCK_DATA_NO_ACTIVITY: KBDetail = {
  kb_id: "kb-3",
  name: "No Activity KB",
  status: "in_progress",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBDetailActivity", () => {
  it("[tag:kb-detail-activity] renders activity rows from data", () => {
    renderWithProviders(<KBDetailActivity data={MOCK_DATA_WITH_ACTIVITY} />)

    const rows = screen.getAllByTestId("activity-row")
    expect(rows).toHaveLength(2)
    expect(screen.getByText("Sync started")).toBeInTheDocument()
    expect(screen.getByText("Sync completed")).toBeInTheDocument()
  })

  it("[tag:kb-detail-activity] renders duration text", () => {
    renderWithProviders(<KBDetailActivity data={MOCK_DATA_WITH_ACTIVITY} />)
    expect(screen.getByText("5 minutes")).toBeInTheDocument()
  })

  it("[tag:kb-detail-activity] renders empty table when activity is empty array", () => {
    renderWithProviders(<KBDetailActivity data={MOCK_DATA_EMPTY} />)
    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  it("[tag:kb-detail-activity] renders empty table when activity is undefined", () => {
    renderWithProviders(<KBDetailActivity data={MOCK_DATA_NO_ACTIVITY} />)
    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  it("[tag:kb-detail-activity] generates row id with empty string when timestamp is nullish", () => {
    const data: KBDetail = {
      kb_id: "kb-4",
      name: "Nullish Timestamp KB",
      status: "in_progress",
      deprecated: false,
      labels: [],
      created_at: "2024-01-01T00:00:00Z",
      activity: [
        {
          event: "Sync started",
          status: "ready",
          duration: 1,
          timestamp: undefined,
        },
      ],
    }
    renderWithProviders(<KBDetailActivity data={data} />)

    expect(screen.getByTestId("activity-row")).toBeInTheDocument()
    expect(screen.getByText("Sync started")).toBeInTheDocument()
  })

  it("[tag:kb-detail-activity] sorts rows with nullish timestamps to the end", () => {
    const data: KBDetail = {
      kb_id: "kb-5",
      name: "Mixed Timestamps KB",
      status: "in_progress",
      deprecated: false,
      labels: [],
      created_at: "2024-01-01T00:00:00Z",
      activity: [
        {
          event: "No timestamp entry",
          status: "ready",
          duration: 1,
          timestamp: undefined,
        },
        {
          event: "Recent entry",
          status: "ready",
          duration: 2,
          timestamp: "2024-06-15T10:00:00Z",
        },
        {
          event: "Another no timestamp",
          status: "ready",
          duration: 3,
          timestamp: undefined,
        },
      ],
    }
    renderWithProviders(<KBDetailActivity data={data} />)

    const rows = screen.getAllByTestId("activity-row")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent("Recent entry")
    expect(rows[1]).toHaveTextContent("No timestamp entry")
    expect(rows[2]).toHaveTextContent("Another no timestamp")
  })
})

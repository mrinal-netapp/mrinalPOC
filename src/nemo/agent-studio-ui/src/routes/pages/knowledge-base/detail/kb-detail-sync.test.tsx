import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"
import type { KBDetail } from "@/api/kb.types"
import { KBDetailSync } from "./kb-detail-sync"

const MOCK_DATA: KBDetail = {
  kb_id: "kb-1",
  name: "Test KB",
  status: "ready",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  synchronization_status: "Completed",
  synchronization_config: {
    sync_mode: "scheduled",
    schedule_type: "daily",
    time_of_day: "10:00",
  },
  synchronization_summary: {
    status: "Completed",
    schedule: "Daily",
    last_completed_synchronization: "2024-06-15T10:00:00Z",
    next_scheduled_synchronization: "2024-06-16T10:00:00Z",
  },
}

describe("KBDetailSync", () => {
  it("[tag:kb-detail-sync] renders sync card with status", () => {
    renderWithProviders(<KBDetailSync data={MOCK_DATA} />)
    expect(screen.getByText("Synchronization schedule")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] renders schedule label", () => {
    renderWithProviders(<KBDetailSync data={MOCK_DATA} />)
    expect(screen.getByText("Runs every day at 10:00 AM")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] renders last completed synchronization date", () => {
    renderWithProviders(<KBDetailSync data={MOCK_DATA} />)
    expect(screen.getByText("Last completed synchronization")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] manual config shows 'Manual'", () => {
    renderWithProviders(
      <KBDetailSync data={{ ...MOCK_DATA, synchronization_config: { sync_mode: "manual" } }} />,
    )
    expect(screen.getByText("Manual")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] after_dataset_updates shows label", () => {
    renderWithProviders(
      <KBDetailSync data={{ ...MOCK_DATA, synchronization_config: { sync_mode: "after_dataset_updates" } }} />,
    )
    expect(screen.getByText("After dataset updates")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] hourly 30 min shows 'Runs every 30 minutes'", () => {
    renderWithProviders(
      <KBDetailSync data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "scheduled", schedule_type: "hourly", interval_minutes: 30 },
      }} />,
    )
    expect(screen.getByText("Runs every 30 minutes")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] hourly 1 min shows 'Runs every minute'", () => {
    renderWithProviders(
      <KBDetailSync data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "scheduled", schedule_type: "hourly", interval_minutes: 1 },
      }} />,
    )
    expect(screen.getByText("Runs every minute")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] hourly 120 min shows 'Runs every 2 hours'", () => {
    renderWithProviders(
      <KBDetailSync data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "scheduled", schedule_type: "hourly", interval_minutes: 120 },
      }} />,
    )
    expect(screen.getByText("Runs every 2 hours")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] weekly shows 'Runs weekly'", () => {
    renderWithProviders(
      <KBDetailSync data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "scheduled", schedule_type: "weekly" },
      }} />,
    )
    expect(screen.getByText("Runs weekly")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] monthly shows 'Runs monthly'", () => {
    renderWithProviders(
      <KBDetailSync data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "scheduled", schedule_type: "monthly" },
      }} />,
    )
    expect(screen.getByText("Runs monthly")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] cron shows expression", () => {
    renderWithProviders(
      <KBDetailSync data={{
        ...MOCK_DATA,
        synchronization_config: { sync_mode: "scheduled", schedule_type: "cron", cron_expression: "0 3 * * *" },
      }} />,
    )
    expect(screen.getByText("Cron: 0 3 * * *")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] null config shows 'Manual'", () => {
    renderWithProviders(
      <KBDetailSync data={{ ...MOCK_DATA, synchronization_config: undefined }} />,
    )
    expect(screen.getByText("Manual")).toBeInTheDocument()
  })

  it("[tag:kb-detail-sync] shows em dash when sync status is missing", () => {
    renderWithProviders(
      <KBDetailSync data={{ ...MOCK_DATA, synchronization_status: undefined }} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })
})

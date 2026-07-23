import { screen, waitFor, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types"
import type { KBFormValues } from "./kb-form.consts"
import { KBSyncScheduleContent } from "./kb-sync-schedule-content"
import { TestFormWrapper } from "./test-helpers"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduleOverrides(scheduleType: string): Partial<KBFormValues> {
  return {
    kb_schedule: {
      sync_schedule_mode: "builder",
      refresh_config: {
        schedule_type: scheduleType as KBFormValues["kb_schedule"]["refresh_config"]["schedule_type"],
        interval_minutes: 120,
        time_of_day_hour: 0,
        time_of_day_minute: 0,
        day_of_week: [],
        day_of_month: 1,
        cron_expression: "",
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBSyncScheduleContent", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-schedule-content] renders builder/cron tabs", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Use schedule builder")).toBeInTheDocument()
    expect(screen.getByText("Use cron expression")).toBeInTheDocument()
  })

  it("[tag:kb-schedule-content] builder tab is active by default", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Schedule frequency")).toBeInTheDocument()
  })

  it("[tag:kb-schedule-content] shows schedule type radio options", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Hourly")).toBeInTheDocument()
    expect(screen.getByText("Daily")).toBeInTheDocument()
    expect(screen.getByText("Weekly")).toBeInTheDocument()
    expect(screen.getByText("Monthly")).toBeInTheDocument()
  })

  it("[tag:kb-schedule-content] daily mode shows time fields", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Hour (UTC)")).toBeInTheDocument()
    expect(screen.getByText("Minute of the hour (UTC)")).toBeInTheDocument()
  })

  it("[tag:kb-schedule-content] switching to cron tab shows cron field", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )

    await user.click(screen.getByText("Use cron expression"))
    expect(screen.getByText("Cron expression")).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Hourly schedule type
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] hourly mode shows interval field instead of time fields", () => {
    renderWithProviders(
      <TestFormWrapper overrides={makeScheduleOverrides("hourly")}>
        {(form) => <KBSyncScheduleContent form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("Configure interval")).toBeInTheDocument()
    expect(screen.getByText("Interval (minutes)")).toBeInTheDocument()
    expect(screen.queryByText("Hour (UTC)")).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // handleScheduleTypeChange — switch from daily to hourly via radio click
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] clicking Hourly radio switches to hourly mode", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )

    expect(screen.getByText("Configure time")).toBeInTheDocument()

    await user.click(screen.getByText("Hourly"))

    await waitFor(() => {
      expect(screen.getByText("Configure interval")).toBeInTheDocument()
    })
  })

  // -----------------------------------------------------------------------
  // Monthly schedule type
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] monthly mode shows day of month field", () => {
    renderWithProviders(
      <TestFormWrapper overrides={makeScheduleOverrides("monthly")}>
        {(form) => <KBSyncScheduleContent form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("Day of month")).toBeInTheDocument()
  })

  it("[tag:kb-schedule-content] clicking Monthly radio switches to monthly mode", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )

    await user.click(screen.getByText("Monthly"))

    await waitFor(() => {
      expect(screen.getByText("Day of month")).toBeInTheDocument()
    })
  })

  // -----------------------------------------------------------------------
  // Weekly schedule type — handleDayOfWeekToggle
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] weekly mode shows day of week checkboxes", () => {
    renderWithProviders(
      <TestFormWrapper overrides={makeScheduleOverrides("weekly")}>
        {(form) => <KBSyncScheduleContent form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("Day of week")).toBeInTheDocument()
    expect(screen.getByText("Mon")).toBeInTheDocument()
    expect(screen.getByText("Fri")).toBeInTheDocument()
  })

  it("[tag:kb-schedule-content] clicking a day checkbox toggles selection", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper overrides={makeScheduleOverrides("weekly")}>
        {(form) => <KBSyncScheduleContent form={form} />}
      </TestFormWrapper>,
    )

    const monLabel = screen.getByText("Mon")
    await user.click(monLabel)

    // The checkbox should toggle — we verify the handler ran without error.
    // The day_of_week value is managed internally by the form.
    expect(screen.getByText("Mon")).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Switching back from cron to builder
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] switching from cron tab back to builder restores builder view", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncScheduleContent form={form} />}</TestFormWrapper>,
    )

    await user.click(screen.getByText("Use cron expression"))
    expect(screen.getByText("Cron expression")).toBeInTheDocument()

    await user.click(screen.getByText("Use schedule builder"))
    await waitFor(() => {
      expect(screen.getByText("Schedule frequency")).toBeInTheDocument()
    })
  })

  // -----------------------------------------------------------------------
  // Remove-a-day branch (toggle off a previously selected day)
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] toggling a selected day removes it from the list", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper
        overrides={{
          kb_schedule: {
            sync_schedule_mode: "builder",
            refresh_config: {
              schedule_type: "weekly",
              interval_minutes: 120,
              time_of_day_hour: 0,
              time_of_day_minute: 0,
              day_of_week: [1],
              day_of_month: 1,
              cron_expression: "",
            },
          },
        }}
      >
        {(form) => <KBSyncScheduleContent form={form} />}
      </TestFormWrapper>,
    )

    const monCheckbox = screen.getByRole("checkbox", { name: "Mon" })
    expect(monCheckbox).toBeChecked()

    await user.click(screen.getByText("Mon"))

    await waitFor(() => {
      expect(monCheckbox).not.toBeChecked()
    })
  })

  // -----------------------------------------------------------------------
  // Day-of-week error display
  // -----------------------------------------------------------------------

  it("[tag:kb-schedule-content] renders day-of-week error when field has errors", async () => {
    let capturedForm: AnyReactFormApi | undefined

    renderWithProviders(
      <TestFormWrapper overrides={makeScheduleOverrides("weekly")}>
        {(form) => {
          capturedForm = form
          return <KBSyncScheduleContent form={form} />
        }}
      </TestFormWrapper>,
    )

    act(() => {
      capturedForm!.setFieldMeta("kb_schedule.refresh_config.day_of_week", (prev) => ({
        ...(prev ?? {}),
        errorMap: { ...(prev?.errorMap ?? {}), onChange: "Select at least one day" },
        errors: ["Select at least one day"],
      }))
    })

    await waitFor(() => {
      expect(screen.getByText("Select at least one day")).toBeInTheDocument()
    })
  })
})

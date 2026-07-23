import { screen, fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { EvalScheduleSection } from "./eval-schedule-section"

function setup(props: Partial<Parameters<typeof EvalScheduleSection>[0]> = {}) {
  const handlers = {
    onScheduleEnabledChange: vi.fn(),
    onScheduleModeChange: vi.fn(),
    onScheduleCadenceChange: vi.fn(),
    onScheduleHourUtcChange: vi.fn(),
    onScheduleMinuteUtcChange: vi.fn(),
    onScheduleCronChange: vi.fn(),
  }
  const utils = renderWithProviders(
    <EvalScheduleSection
      scheduleEnabled={false}
      scheduleMode="builder"
      scheduleCadence="daily"
      scheduleHourUtc={10}
      scheduleMinuteUtc={0}
      scheduleCron=""
      {...handlers}
      {...props}
    />,
  )
  return { ...handlers, ...utils }
}

describe("EvalScheduleSection", () => {
  it("[tag:eval] hides the builder until scheduling is enabled and toggles it on", async () => {
    const user = userEvent.setup()
    const { onScheduleEnabledChange } = setup()

    expect(screen.queryByText("Use schedule builder")).not.toBeInTheDocument()
    await user.click(screen.getByRole("checkbox"))
    expect(onScheduleEnabledChange).toHaveBeenCalledWith(true)
  })

  it("[tag:eval] shows the builder with time inputs for non-hourly cadence", () => {
    setup({ scheduleEnabled: true, scheduleCadence: "daily" })

    expect(screen.getByText("Use schedule builder")).toBeInTheDocument()
    expect(screen.getByText("Hour (UTC)")).toBeInTheDocument()
    expect(screen.getByText("Minute")).toBeInTheDocument()
  })

  it("[tag:eval] hides the time inputs for hourly cadence", () => {
    setup({ scheduleEnabled: true, scheduleCadence: "hourly" })

    expect(screen.queryByText("Hour (UTC)")).not.toBeInTheDocument()
  })

  it("[tag:eval] clamps the hour and minute inputs to valid ranges", () => {
    const { onScheduleHourUtcChange, onScheduleMinuteUtcChange } = setup({ scheduleEnabled: true })

    fireEvent.change(screen.getByDisplayValue("10"), { target: { value: "99" } })
    expect(onScheduleHourUtcChange).toHaveBeenCalledWith(23)

    fireEvent.change(screen.getByDisplayValue("0"), { target: { value: "99" } })
    expect(onScheduleMinuteUtcChange).toHaveBeenCalledWith(59)
  })

  it("[tag:eval] switches to the cron tab and edits the expression", async () => {
    const user = userEvent.setup()
    const { onScheduleModeChange } = setup({ scheduleEnabled: true })

    await user.click(screen.getByText("Use cron expression"))
    expect(onScheduleModeChange).toHaveBeenCalledWith("cron")
  })

  it("[tag:eval] edits the cron expression when on the cron tab", async () => {
    const user = userEvent.setup()
    const { onScheduleCronChange } = setup({ scheduleEnabled: true, scheduleMode: "cron" })

    await user.type(screen.getByPlaceholderText("e.g. 0 10 * * *"), "0")
    expect(onScheduleCronChange).toHaveBeenCalledWith("0")
  })

  it("[tag:eval] changes the cadence", async () => {
    const user = userEvent.setup()
    const { onScheduleCadenceChange } = setup({ scheduleEnabled: true })

    await user.click(screen.getByText("Weekly"))
    expect(onScheduleCadenceChange).toHaveBeenCalledWith("weekly")
  })
})

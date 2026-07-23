import type { TimeRangeOption } from "./overview-panel.types"

const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  "Last week",
  "Last month",
  "Last 3 months",
  "Last 6 months",
]

// Rolling window (days) each option maps to when querying usage stats. Bifrost's
// logs store retains 90 days, so "Last 6 months" is effectively capped there.
const TIME_RANGE_TO_DAYS: Record<TimeRangeOption, number> = {
  "Last week": 7,
  "Last month": 30,
  "Last 3 months": 90,
  "Last 6 months": 180,
}

export { TIME_RANGE_OPTIONS, TIME_RANGE_TO_DAYS }

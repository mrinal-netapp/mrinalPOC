import type { ReactElement } from "react"
import {
  IconArrowsUpDown,
  IconClock,
  IconCurrencyDollar,
  IconTargetArrow,
} from "@tabler/icons-react"

import { MetricsRow } from "./metrics-row"
import type { MetricItem } from "./metrics-row.types"

// Most common case — a single row of KPI tiles at the top of a detail page.
// `value` is rendered as the headline number and `subtitle` as the caption.
// Use this when the entity has 2–4 headline metrics worth surfacing.
function Basic(): ReactElement {
  const metrics: MetricItem[] = [
    { icon: <IconArrowsUpDown size={24} />, value: "1,200,000", subtitle: "Requests" },
    { icon: <IconTargetArrow size={24} />, value: "99.2%", subtitle: "Success rate" },
    { icon: <IconClock size={24} />, value: "245", units: "ms", subtitle: "Average latency" },
  ]
  return <MetricsRow metrics={metrics} />
}

// Use the optional `units` slot when the metric's unit is shorter than the
// value and reads better as a suffix (ms, %, GB). The unit renders next to
// the value at the same font size so the row stays visually aligned.
function WithUnits(): ReactElement {
  const metrics: MetricItem[] = [
    { icon: <IconCurrencyDollar size={24} />, value: "582.01", units: "USD", subtitle: "Cost" },
    { icon: <IconClock size={24} />, value: "245", units: "ms", subtitle: "Average latency" },
  ]
  return <MetricsRow metrics={metrics} />
}

// A row stays usable with a single tile — the divider between tiles is only
// drawn between adjacent items, so single-item callsites render cleanly.
function SingleMetric(): ReactElement {
  const metrics: MetricItem[] = [
    { icon: <IconArrowsUpDown size={24} />, value: "1,200,000", subtitle: "Requests" },
  ]
  return <MetricsRow metrics={metrics} />
}

export { Basic, WithUnits, SingleMetric }

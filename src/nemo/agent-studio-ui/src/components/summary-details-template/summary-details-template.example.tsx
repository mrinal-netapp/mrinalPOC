import type { ReactElement } from "react"
import { IconChartBar, IconClock, IconRefresh, IconTool } from "@tabler/icons-react"

import { SummaryDetailsTemplate } from "./summary-details-template"
import { MetricsRow } from "@/components/metrics-row/metrics-row"
import { DetailCard } from "@/components/detail-card/detail-card"
import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import type { MetricItem } from "@/components/metrics-row/metrics-row.types"
import type { DetailCardRow } from "@/components/detail-card/detail-card.types"
import type { SummaryField, TabPanel } from "./summary-details-template.types"

const SUMMARY_FIELDS: SummaryField[] = [
  { label: "Name", value: "sample-entity-01" },
  { label: "Status", value: "Healthy" },
  { label: "Type", value: "Custom" },
  { label: "Associated agents", value: "agent-sample-name" },
]

const METRICS: MetricItem[] = [
  { icon: <IconTool size={24} />, value: "6", subtitle: "Tools" },
  { icon: <IconChartBar size={24} />, value: "99.2%", subtitle: "Success rate" },
  { icon: <IconClock size={24} />, value: "245", units: "ms", subtitle: "Average latency" },
]

const DETAIL_ROWS: DetailCardRow[] = [
  { label: "Name", value: "sample-entity-01" },
  { label: "Type", value: "Custom" },
  { label: "Created", value: "Feb 10, 2026, 7:15:06 AM" },
]

// Most common case — the full layout a new detail page should start from.
// Header (breadcrumbs + title + actions), summary bar, and a 3-tab strip
// with an Overview that combines MetricsRow + DetailCard. Copy this whole
// function into your feature folder and swap the data sources.
function Basic(): ReactElement {
  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: "Overview" },
      content: (
        <>
          <MetricsRow metrics={METRICS} />
          <DetailCard rows={DETAIL_ROWS} />
        </>
      ),
    },
    {
      tab: { id: "testing", label: "Testing" },
      content: <Typography fontSize="fs14">Inject testing content here.</Typography>,
    },
    {
      tab: { id: "activity", label: "Activity" },
      content: <Typography fontSize="fs14">Inject activity content here.</Typography>,
    },
  ]

  return (
    <SummaryDetailsTemplate
      title="Entity details"
      breadcrumbs={[
        { label: "Entities", href: "/entities" },
        { label: "sample-entity-01", href: "/entities/sample-entity-01" },
      ]}
      actions={(
        <>
          <Button variant="icon" size="large" icon={<IconRefresh size={18} />} aria-label="Refresh" />
          <Button variant="solid" size="large" label="Edit" />
        </>
      )}
      summaryFields={SUMMARY_FIELDS}
      tabPanels={tabPanels}
    />
  )
}

// Minimal — no breadcrumbs, no actions. Useful at top-level entry points
// where the user arrived by clicking a nav item and there's no parent
// crumb worth showing.
function Minimal(): ReactElement {
  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: "Overview" },
      content: <MetricsRow metrics={METRICS} />,
    },
  ]

  return (
    <SummaryDetailsTemplate
      title="Entity details"
      summaryFields={SUMMARY_FIELDS}
      tabPanels={tabPanels}
    />
  )
}

// Disabled tab — the template auto-selects the first enabled tab. If a tab
// becomes disabled at runtime (e.g. permissions revoked, dataset not yet
// indexed) the template re-derives the active id so you never end up with
// a stale TabGroup value.
function WithDisabledTab(): ReactElement {
  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: "Overview", isDisabled: true },
      content: <MetricsRow metrics={METRICS} />,
    },
    {
      tab: { id: "activity", label: "Activity" },
      content: <Typography fontSize="fs14">Activity content.</Typography>,
    },
  ]

  return (
    <SummaryDetailsTemplate
      title="Entity details"
      summaryFields={SUMMARY_FIELDS}
      tabPanels={tabPanels}
    />
  )
}

// Placeholder content — passing `null` for `content` makes the template
// render its built-in "Content for ..." placeholder. Reach for this while
// a tab is in flight so the wiring is in place but the content isn't yet.
function WithPlaceholderContent(): ReactElement {
  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: "Overview" },
      content: <MetricsRow metrics={METRICS} />,
    },
    { tab: { id: "testing", label: "Testing" }, content: null },
  ]

  return (
    <SummaryDetailsTemplate
      title="Entity details"
      summaryFields={SUMMARY_FIELDS}
      tabPanels={tabPanels}
    />
  )
}

export { Basic, Minimal, WithDisabledTab, WithPlaceholderContent }

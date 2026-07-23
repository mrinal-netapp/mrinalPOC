import type { DetailCardRow } from "@/components/detail-card/detail-card.types"
import type { MetricItem } from "@/components/metrics-row/metrics-row.types"

export type TimeRangeOption = "Last week" | "Last month" | "Last 3 months" | "Last 6 months"

export type ToolsetOverviewPanelProps = {
  metrics: MetricItem[]
  detailRows: DetailCardRow[]
}

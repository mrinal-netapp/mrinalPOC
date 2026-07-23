import { useMemo, useState, type ReactElement } from "react"
import {
  IconFilter,
  IconX,
  IconChevronDown,
  IconChevronUp,
  IconArrowsUpDown,
  IconCurrencyDollar,
  IconClock,
  IconTargetArrow,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { MetricsRow } from "@/components/metrics-row/metrics-row"
import type { MetricItem } from "@/components/metrics-row/metrics-row.types"
import { DetailCard } from "@/components/detail-card/detail-card"
import { TabContent } from "@/ui-lib/base-components/tab/tab-group"
import type { DetailCardRow } from "@/components/detail-card/detail-card.types"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import { useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import { useGetModelUsageStatsQuery } from "../../model-detail-page.api"
import { TIME_RANGE_OPTIONS, TIME_RANGE_TO_DAYS } from "./overview-panel.consts"
import type { OverviewPanelProps, TimeRangeOption } from "./overview-panel.types"

/** Format a per-1M-token price (USD) for display; "-" when unavailable. */
function formatPer1M(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-"
  return `$${value.toFixed(2)}`
}

/** Format a USD amount for display; "-" when unavailable. */
function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-"
  if (value === 0) return "$0.00"
  const abs = Math.abs(value)
  // Cent-and-above amounts read best as standard two-decimal currency.
  if (abs >= 0.01) return `$${value.toFixed(2)}`
  // Sub-cent amounts (e.g. the cost of a single small request) would collapse
  // to "$0.00" at two decimals, so keep 4 significant figures instead. The
  // Number round-trip drops trailing zeros without scientific notation.
  return `$${Number(value.toPrecision(4))}`
}

function OverviewPanel({ model, dependentCount, pricingDefaults }: OverviewPanelProps): ReactElement {
  const [timeRange, setTimeRange] = useState<TimeRangeOption | null>("Last month")
  const [isMetricsCollapsed, setIsMetricsCollapsed] = useState(false)

  // Live usage metrics (requests / cost / latency / success rate) aggregated by
  // config-service from Bifrost's logs store, scoped to the selected time range.
  // Clearing the range (null) asks for all retained logs.
  const projectId = useAppSelector(projectContextSelector.activeProjectId)
  const { data: usageStats } = useGetModelUsageStatsQuery(
    {
      projectId: projectId ?? "",
      modelId: model.id,
      days: timeRange ? TIME_RANGE_TO_DAYS[timeRange] : undefined,
    },
    { skip: !projectId || !model.id },
  )

  // I18-002: format numbers via Intl.NumberFormat. Locale is browser default
  // today; swap the argument to `i18n.language` (from useTranslation) once the
  // app gains an i18n provider. Memoized so the formatter survives re-renders.
  const numberFmt = useMemo(() => new Intl.NumberFormat(), [])
  const labels = model.labels ?? []
  const costConfig = model.costConfig ?? {
    inputCostPer1MTokens: "-",
    outputCostPer1MTokens: "-",
    customPricing: "Disabled" as const,
    customInputCostPer1MTokens: "-",
    customOutputCostPer1MTokens: "-",
    markup: "-",
    spendingLimitUsd: "-",
    spendingThresholdAlert: "-",
    currentSpending: "-",
  }
  // Effective price per 1M tokens = the model's custom override when set,
  // otherwise the provider list (catalog) price. `customPricing === "Disabled"`
  // (or a "-" custom field) means no override, so the default applies.
  const defaultInputCost = formatPer1M(pricingDefaults?.inputCostPer1M)
  const defaultOutputCost = formatPer1M(pricingDefaults?.outputCostPer1M)
  const hasCustomInput = costConfig.customInputCostPer1MTokens !== "-"
  const hasCustomOutput = costConfig.customOutputCostPer1MTokens !== "-"
  const effectiveInputCost = hasCustomInput
    ? costConfig.customInputCostPer1MTokens
    : defaultInputCost
  const effectiveOutputCost = hasCustomOutput
    ? costConfig.customOutputCostPer1MTokens
    : defaultOutputCost

  // Prefer live Bifrost stats when loaded; otherwise fall back to whatever the
  // model detail carries (placeholder values until the stats query resolves).
  const requestsValue = usageStats ? usageStats.requests : model.requests
  const costValue = usageStats
    ? usageStats.available
      ? formatUsd(usageStats.totalCost)
      : "-"
    : model.cost
  const latencyValue = usageStats
    ? Math.round(usageStats.averageLatencyMs)
    : model.avgLatencyMs
  const successRateValue = usageStats
    ? usageStats.successRate != null
      ? `${usageStats.successRate.toFixed(1)}%`
      : "—"
    : model.successRate

  const metrics: MetricItem[] = [
    {
      icon: <IconArrowsUpDown size={24} />,
      value: numberFmt.format(requestsValue),
      subtitle: "Requests",
    },
    {
      icon: <IconCurrencyDollar size={24} />,
      value: costValue,
      subtitle: "Cost",
    },
    {
      icon: <IconClock size={24} />,
      value: String(latencyValue),
      units: "ms",
      subtitle: "Average latency",
    },
    {
      icon: <IconTargetArrow size={24} />,
      value: successRateValue,
      subtitle: "Success rate",
    },
  ]

  const detailRows: DetailCardRow[] = [
    { label: "Name", value: model.name },
    { label: "Description", value: model.description },
    { label: "Type", value: model.type },
    { label: "Labels", value: labels.length > 0 ? labels.join(", ") : "-" },
    { label: "Provider", value: model.provider || "Unknown" },
    { label: "Model", value: model.model },
    {
      label: "Maximum requests per minute",
      value: numberFmt.format(model.maxRequestsPerMinute),
    },
    {
      label: "Maximum tokens per minute",
      value: numberFmt.format(model.maxTokensPerMinute),
    },
    {
      label: "Associated resources",
      value: numberFmt.format(dependentCount ?? 0),
    },
    { label: "Input cost (USD per 1M tokens)", value: effectiveInputCost },
    { label: "Output cost (USD per 1M tokens)", value: effectiveOutputCost },
    { label: "Last time updated", value: model.lastTimeUpdated },
    { label: "Created", value: model.created },
  ]

  const costConfigRows: DetailCardRow[] = [
    { label: "Input cost (USD per 1M tokens)", value: effectiveInputCost },
    { label: "Output cost (USD per 1M tokens)", value: effectiveOutputCost },
    { label: "Custom pricing", value: costConfig.customPricing },
    { label: "Default input cost per 1M tokens", value: defaultInputCost },
    { label: "Default output cost per 1M tokens", value: defaultOutputCost },
    {
      label: "Custom input cost per 1M tokens",
      value: costConfig.customInputCostPer1MTokens,
    },
    {
      label: "Custom output cost per 1M tokens",
      value: costConfig.customOutputCostPer1MTokens,
    },
    { label: "Markup", value: costConfig.markup },
    { label: "Spending limit, USD", value: costConfig.spendingLimitUsd },
    { label: "Spending threshold alert", value: costConfig.spendingThresholdAlert },
    { label: "Current spending", value: costConfig.currentSpending },
  ]

  return (
    <div className="model-overview">
      {/* Filter bar */}
      <div className="model-overview__filter-bar">
        <div className="model-overview__filter-bar-left">
          <IconFilter size={16} className="model-overview__filter-icon" />
          <Typography fontSize="fs14" boldness="regular" Component="span">
            Filters:
          </Typography>

          <div className="model-overview__filter-chip-row">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button type="button" className="model-overview__filter-chip">
                    <span>{timeRange === null ? "Time range" : `Time range: ${timeRange}`}</span>
                    <IconChevronDown size={13} />
                  </button>
                }
              />
              <DropdownMenuContent align="start" sideOffset={4}>
                {TIME_RANGE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option} onClick={() => setTimeRange(option)}>
                    {option}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {timeRange !== null && (
              <Button
                variant="icon"
                size="small"
                icon={<IconX size={12} />}
                aria-label="Clear time range filter"
                onClick={() => setTimeRange(null)}
              />
            )}
          </div>
        </div>

        <Button
          variant="icon"
          size="small"
          icon={isMetricsCollapsed ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
          aria-label={isMetricsCollapsed ? "Expand metrics" : "Collapse metrics"}
          onClick={() => setIsMetricsCollapsed((v) => !v)}
        />
      </div>

      {/* Metrics row — hidden when collapsed */}
      {!isMetricsCollapsed && <MetricsRow metrics={metrics} />}

      {/* Detail card with Details + Cost configuration tabs */}
      <DetailCard
        rows={detailRows}
        extraTabs={[{ id: "cost-config", label: "Cost configuration" }]}
      >
        <TabContent tabId="cost-config">
          <div className="model-overview__cost-config-rows">
            {costConfigRows.map((row, idx) => (
              <div
                key={row.label}
                className={`model-overview__cost-config-row${idx < costConfigRows.length - 1 ? " model-overview__cost-config-row--separator" : ""}`}
              >
                <Typography
                  fontSize="fs14"
                  boldness="regular"
                  Component="span"
                  className="model-overview__cost-config-label"
                >
                  {row.label}
                </Typography>
                <Typography
                  fontSize="fs14"
                  boldness="semibold"
                  Component="span"
                  className="model-overview__cost-config-value"
                >
                  {row.value}
                </Typography>
              </div>
            ))}
          </div>
        </TabContent>
      </DetailCard>
    </div>
  )
}

export { OverviewPanel }

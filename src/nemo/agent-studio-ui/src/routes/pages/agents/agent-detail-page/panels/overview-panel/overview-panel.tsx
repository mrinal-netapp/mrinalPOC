import { useMemo, useState, type ReactElement } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconFilter,
  IconMessage,
  IconTargetArrow,
  IconUsers,
  IconX,
} from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { MetricsRow } from "@/components/metrics-row/metrics-row";
import type { MetricItem } from "@/components/metrics-row/metrics-row.types";
import { DetailCard } from "@/components/detail-card/detail-card";
import type { DetailCardRow } from "@/components/detail-card/detail-card.types";

import {
  OVERVIEW_PANEL_STRINGS,
  SHOW_AGENT_METRICS_ROW,
  TIME_RANGE_OPTIONS,
} from "./overview-panel.consts";
import type {
  OverviewPanelProps,
  TimeRangeOption,
} from "./overview-panel.types";

// Styles for this panel live in the consolidated
// `agent-detail-page.scss`, loaded once by the page component.

function OverviewPanel({
  detail,
  lastUpdatedFormatted,
  createdFormatted,
}: OverviewPanelProps): ReactElement {
  const [timeRange, setTimeRange] = useState<TimeRangeOption | null>("Last month");
  const [isMetricsCollapsed, setIsMetricsCollapsed] = useState(false);

  // I18-002: format numbers via Intl.NumberFormat. Locale is browser default
  // today; swap the argument for `i18n.language` once an i18n provider lands.
  const numberFmt = useMemo(() => new Intl.NumberFormat(), []);
  const percentFmt = useMemo(
    () => new Intl.NumberFormat(undefined, {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
    [],
  );

  const metrics: MetricItem[] = [
    {
      icon: <IconUsers size={24} />,
      value: numberFmt.format(detail.metrics.activeUsers),
      subtitle: OVERVIEW_PANEL_STRINGS.METRIC_ACTIVE_USERS,
    },
    {
      icon: <IconMessage size={24} />,
      value: numberFmt.format(detail.metrics.conversations),
      subtitle: OVERVIEW_PANEL_STRINGS.METRIC_CONVERSATIONS,
    },
    {
      icon: <IconTargetArrow size={24} />,
      value: percentFmt.format(detail.metrics.successRatePercent / 100),
      subtitle: OVERVIEW_PANEL_STRINGS.METRIC_SUCCESS_RATE,
    },
  ];

  const detailRows: DetailCardRow[] = [
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_NAME, value: detail.name },
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_DESCRIPTION, value: detail.description },
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_LABELS, value: detail.labels.join(", ") },
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_TYPE, value: detail.type },
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_MODELS, value: detail.models.join(", ") },
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_LAST_UPDATED, value: lastUpdatedFormatted },
    { label: OVERVIEW_PANEL_STRINGS.DETAIL_CREATED, value: createdFormatted },
  ];

  return (
    <div className="agent-overview">
      {SHOW_AGENT_METRICS_ROW && (
        <>
          {/* Filter bar — gated alongside the metrics row because the
              time-range chip and collapse toggle exist solely for that
              row. Flip `SHOW_AGENT_METRICS_ROW` to `true` once the
              telemetry endpoints are wired to bring both back. */}
          <div className="agent-overview__filter-bar">
            <div className="agent-overview__filter-bar-left">
              <IconFilter size={16} className="agent-overview__filter-icon" />
              <Typography fontSize="fs14" boldness="regular" Component="span">
                {OVERVIEW_PANEL_STRINGS.FILTERS_LABEL}
              </Typography>

              <div className="agent-overview__filter-chip-row">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button type="button" className="agent-overview__filter-chip">
                        <span>
                          {timeRange === null
                            ? OVERVIEW_PANEL_STRINGS.FILTER_TIME_RANGE
                            : `${OVERVIEW_PANEL_STRINGS.FILTER_TIME_RANGE}: ${timeRange}`}
                        </span>
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
                    aria-label={OVERVIEW_PANEL_STRINGS.CLEAR_TIME_RANGE}
                    onClick={() => setTimeRange(null)}
                  />
                )}
              </div>
            </div>

            <Button
              variant="icon"
              size="small"
              icon={isMetricsCollapsed ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
              aria-label={
                isMetricsCollapsed
                  ? OVERVIEW_PANEL_STRINGS.TOGGLE_COLLAPSE_EXPAND
                  : OVERVIEW_PANEL_STRINGS.TOGGLE_COLLAPSE_COLLAPSE
              }
              onClick={() => setIsMetricsCollapsed((v) => !v)}
            />
          </div>

          {!isMetricsCollapsed && <MetricsRow metrics={metrics} />}
        </>
      )}

      {/* Details card — built-in "Details" tab from the cherry-picked component */}
      <DetailCard rows={detailRows} />
    </div>
  );
}

export { OverviewPanel };

import type { ReactElement } from "react"
import { IconChevronDown, IconChevronUp, IconFilter, IconX } from "@tabler/icons-react"

import { useAppDispatch, useAppSelector } from "@/store"
import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { MetricsRow } from "@/components/metrics-row/metrics-row"
import { DetailCard } from "@/components/detail-card/detail-card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import type { DetailCardRow } from "@/components/detail-card/detail-card.types"
import type { MetricItem } from "@/components/metrics-row/metrics-row.types"

import { setDetailMetricsCollapsed, setDetailOverviewTimeRange } from "../reducer"
import { toolsetSelector } from "../selectors"
import type { ToolsetAgentRow } from "../toolset.types"
import { TOOLSET_OVERVIEW_TIME_RANGE_OPTIONS } from "./toolset-overview.consts"
import type { TimeRangeOption } from "./toolset-overview.types"

type ToolsetOverviewPanelProps = {
  metrics: MetricItem[]
  detailRows: DetailCardRow[]
  /** Agents that reference this tool (via their `mcpServerIds`). */
  agents?: ToolsetAgentRow[]
  /** Navigate to an agent's detail page when its name is clicked. */
  onAgentClick?: (agentId: string) => void
}

function ToolsetOverviewPanel({
  metrics,
  detailRows,
  agents = [],
  onAgentClick,
}: ToolsetOverviewPanelProps): ReactElement {
  const dispatch = useAppDispatch()
  const timeRange = useAppSelector(toolsetSelector.detailOverviewTimeRange)
  const isMetricsCollapsed = useAppSelector(toolsetSelector.detailIsMetricsCollapsed)

  const setTimeRange = (option: TimeRangeOption | null): void => {
    dispatch(setDetailOverviewTimeRange(option))
  }

  return (
    <div className="toolset-overview">
      <div className="toolset-overview__filter-bar">
        <div className="toolset-overview__filter-bar-left">
          <IconFilter size={16} className="toolset-overview__filter-icon" aria-hidden="true" />
          <Typography fontSize="fs12" boldness="regular" Component="span" className="toolset-overview__filter-label">
            Filters:
          </Typography>

          <div className="toolset-overview__filter-chip-row">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button type="button" className="toolset-overview__filter-chip">
                    <span>{timeRange === null ? "Time range" : `Time range: ${timeRange}`}</span>
                    <IconChevronDown size={13} aria-hidden="true" />
                  </button>
                }
              />
              <DropdownMenuContent align="start" sideOffset={4}>
                {TOOLSET_OVERVIEW_TIME_RANGE_OPTIONS.map((option) => (
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
          onClick={() => dispatch(setDetailMetricsCollapsed(!isMetricsCollapsed))}
        />
      </div>

      {!isMetricsCollapsed && <MetricsRow metrics={metrics} />}
      <DetailCard rows={detailRows} />

      <section className="toolset-overview__agents">
        <div className="toolset-overview__agents-header">
          <Typography Component="h3" fontSize="fs16" boldness="semibold">
            Associated agents
          </Typography>
          <span className="toolset-overview__agents-count">{agents.length}</span>
        </div>

        {agents.length === 0 ? (
          <Typography fontSize="fs14" color="var(--text-secondary)">
            No agents are using this tool yet.
          </Typography>
        ) : (
          <ul className="toolset-overview__agents-list">
            {agents.map((agent) => (
              <li key={agent.id} className="toolset-overview__agents-item">
                {onAgentClick ? (
                  <button
                    type="button"
                    className="toolset-detail__agent-link"
                    onClick={() => onAgentClick(agent.id)}
                  >
                    {agent.name}
                  </button>
                ) : (
                  <Typography fontSize="fs14">{agent.name}</Typography>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export { ToolsetOverviewPanel }

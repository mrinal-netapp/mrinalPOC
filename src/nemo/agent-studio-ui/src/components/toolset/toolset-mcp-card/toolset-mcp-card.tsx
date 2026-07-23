import type { ReactElement, ReactNode } from "react"
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconPlugConnected } from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Card } from "@/ui-lib/base-components/card/card"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { Typography } from "@/ui-lib/base-components/typography/typography"

import "./toolset-mcp-card.scss"

type McpConnectionStatus = "not-configured" | "connected" | "error"

type McpDetailRow = {
  label: string
  value: string | ReactNode
}

type ToolsetMcpCardProps = {
  /** Omit or pass empty strings when a parent card already provides the section header. */
  title?: string
  subtitle?: string
  connectionStatus?: McpConnectionStatus
  configureLabel?: string
  onConfigure?: () => void
  details?: McpDetailRow[]
}

const STATUS_CONFIG: Record<McpConnectionStatus, { label: string; icon: ReactElement; className: string }> = {
  "not-configured": {
    label: "Not configured",
    icon: <IconAlertTriangle size={14} />,
    className: "toolset-mcp-card__status--warning",
  },
  connected: {
    label: "Connected",
    icon: <IconCircleCheck size={14} />,
    className: "toolset-mcp-card__status--success",
  },
  error: {
    label: "Error",
    icon: <IconCircleX size={14} />,
    className: "toolset-mcp-card__status--error",
  },
}

function ToolsetMcpCard({
  title = "",
  subtitle = "",
  connectionStatus = "not-configured",
  configureLabel = "Configure",
  onConfigure,
  details,
}: ToolsetMcpCardProps): ReactElement {
  const status = STATUS_CONFIG[connectionStatus]
  const showHeader = Boolean(title.trim() || subtitle.trim())

  return (
    <Card className="toolset-mcp-card">
      {showHeader && (
        <CardHeader title={title} subtitle={subtitle} hasSeparator />
      )}
      <CardContent>
        <div className="toolset-mcp-card__panel">
          <div className="toolset-mcp-card__server-row">
            <div className="toolset-mcp-card__server-left">
              <IconPlugConnected size={20} stroke={1.5} />
              <Typography fontSize="fs14">MCP server</Typography>
            </div>
            {onConfigure && (
              <Button variant="flat" size="small" label={configureLabel} onClick={onConfigure} />
            )}
          </div>

          <div className="toolset-mcp-card__detail-row">
            <Typography fontSize="fs14" color="var(--text-secondary)">
              Connection status
            </Typography>
            <div className={`toolset-mcp-card__status ${status.className}`}>
              {status.icon}
              <Typography fontSize="fs14">{status.label}</Typography>
            </div>
          </div>

          {details?.map((row, index) => (
            <div key={`${row.label}-${index}`} className="toolset-mcp-card__detail-row">
              <Typography fontSize="fs14" color="var(--text-secondary)">
                {row.label}
              </Typography>
              {typeof row.value === "string" ? (
                <Typography fontSize="fs14">{row.value}</Typography>
              ) : (
                row.value
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export { ToolsetMcpCard }
export type { ToolsetMcpCardProps, McpConnectionStatus, McpDetailRow }

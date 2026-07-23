import { useState, type ReactElement } from "react"
import { useNavigate, useParams } from "react-router"
import {
  IconRefresh,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconChevronDown,
  IconChevronUp,
  IconPlugConnected,
  IconDots,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import { SummaryDetailsTemplate } from "@/components/summary-details-template/summary-details-template"
import type { TabPanel } from "@/components/summary-details-template/summary-details-template"
import type { SummaryField } from "@/components/summary-details-template/summary-details-template.types"
import { ToolsetOverviewPanel } from "./toolset-overview-panel"
import { getToolsetSummaryStatusPresentation } from "./toolset-detail-status"
import BaseTable from "@/ui-lib/base-components/baseTableMcpBxp/baseTable"
import type { BaseElement } from "@/ui-lib/base-components/baseTableMcpBxp"
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { ROUTES } from "@/routes/routes.consts"
import { useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"

import type { ToolsetAgentRow } from "../toolset.types"
import { summarizeMcpRefresh, useDeleteMcpServerMutation, formatMcpServerDeleteError } from "../toolset.api"
import { useToolsetDetail } from "./toolset-detail.actions"
import { TOOLSET_DETAIL_STRINGS } from "./toolset-detail.consts"

import "./toolset-detail.scss"

type AgentRow = BaseElement & ToolsetAgentRow

type McpDetailField = {
  label: string
  value: string
}

type ConfirmDialogState = {
  open: boolean
  variant: "default" | "danger"
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
}

const CLOSED_DIALOG: ConfirmDialogState = {
  open: false,
  variant: "default",
  title: "",
  description: "",
  confirmLabel: "Confirm",
  onConfirm: () => {},
}

const STATUS_ICON = {
  connected: <IconCircleCheck size={16} className="toolset-detail__mcp-status-icon--success" />,
  error: <IconCircleX size={16} className="toolset-detail__mcp-status-icon--error" />,
  "not-configured": <IconAlertTriangle size={16} className="toolset-detail__mcp-status-icon--warning" />,
} as const

const STATUS_LABEL = {
  connected: "Connected",
  error: "Error",
  "not-configured": "Not configured",
} as const

function ToolsetDetail(): ReactElement {
  const { toolId } = useParams<{ toolId: string }>()
  const navigate = useNavigate()
  const projectId = useAppSelector(projectContextSelector.activeProjectId)
  const [deleteMcpServer, { isLoading: isDeleting }] = useDeleteMcpServerMutation()
  const [dialog, setDialog] = useState<ConfirmDialogState>(CLOSED_DIALOG)

  const {
    tool,
    agents,
    isLoading,
    isError,
    isRefreshing,
    mcpExpanded,
    metrics,
    detailRows,
    setMcpExpanded,
    refresh,
  } = useToolsetDetail(toolId)

  const handleRefresh = async (): Promise<void> => {
    const result = await refresh()
    if (!result) {
      toast.error("Unable to refresh health status. Please try again.")
      return
    }
    const { message, tone } = summarizeMcpRefresh(result)
    toast[tone](message)
  }

  const closeDialog = (): void => {
    setDialog(CLOSED_DIALOG)
  }

  // const handleDeprecate = (): void => {
  //   if (!tool) return
  //   setDialog({
  //     open: true,
  //     variant: "default",
  //     title: "Deprecate",
  //     description: `Are you sure you want to deprecate "${tool.name}"?`,
  //     confirmLabel: "Deprecate",
  //     onConfirm: () => {
  //       closeDialog()
  //     },
  //   })
  // }

  const handleDelete = (): void => {
    if (!tool) return
    setDialog({
      open: true,
      variant: "danger",
      title: "Delete",
      description: `Are you sure you want to delete "${tool.name}"?`,
      confirmLabel: "Delete",
      onConfirm: () => {
        if (!projectId || !toolId || isDeleting) return
        void deleteMcpServer({ projectId, id: toolId })
          .unwrap()
          .then(() => {
            toast.success(`"${tool.name}" was deleted.`)
            closeDialog()
            navigate(`/${ROUTES.TOOLSET}`)
          })
          .catch((err) => {
            toast.error(formatMcpServerDeleteError(err))
          })
      },
    })
  }

  const handleTestConnection = (): void => {
    toast.info("Testing connection...")
  }

  const handleConfigure = (): void => {
    navigate(`/${ROUTES.TOOLSET}/${toolId}/${ROUTES.EDIT}`)
  }

  if (isLoading) {
    return (
      <div className="toolset-detail toolset-detail__state" role="status">
        {TOOLSET_DETAIL_STRINGS.LOADING_MESSAGE}
      </div>
    )
  }

  if (isError) {
    return (
      <div className="toolset-detail toolset-detail__state toolset-detail__state--error" role="alert">
        {TOOLSET_DETAIL_STRINGS.ERROR_MESSAGE}
      </div>
    )
  }

  if (!tool) {
    return (
      <div className="toolset-detail toolset-detail__state" role="status">
        {TOOLSET_DETAIL_STRINGS.EMPTY_MESSAGE}
      </div>
    )
  }

  const statusPresentation = getToolsetSummaryStatusPresentation(tool.status)

  const summaryFields: SummaryField[] = [
    { label: "Name", value: tool.name },
    {
      label: "Status",
      value: (
        <div className={`toolset-detail__status ${statusPresentation.className}`}>
          {statusPresentation.icon}
          <Typography fontSize="fs14" boldness="semibold">{tool.status}</Typography>
        </div>
      ),
    },
    { label: "Type", value: tool.type },
    { label: "Associated agents", value: tool.associatedAgents },
  ]

  const mcpDetails: McpDetailField[] = [
    { label: "Connection status", value: STATUS_LABEL[tool.connectionStatus] },
    { label: "Server", value: tool.mcpServer },
    { label: "Authentication type", value: tool.authType },
    { label: "Forwarded headers", value: tool.forwardedHeaders },
  ]

  const agentColumns = [
    {
      accessorKey: "name" as const,
      header: "Name",
      size: 200,
      cell: ({ row }: { row: { original: AgentRow } }) => (
        <button
          type="button"
          className="toolset-detail__agent-link"
          onClick={() => navigate(`/${ROUTES.AGENTS}/${row.original.id}`)}
        >
          {row.original.name}
        </button>
      ),
    },
    { accessorKey: "status" as const, header: "Status", size: 120 },
    { accessorKey: "labels" as const, header: "Labels", size: 200, cell: ({ row }: { row: { original: AgentRow } }) => <div className="toolset-label-list">{row.original.labels.map((label) => <span key={label} className="toolset-label-pill">{label}</span>)}</div> },
    { accessorKey: "created" as const, header: "Created", size: 250 },
  ]

  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: "Overview" },
      content: (
        <ToolsetOverviewPanel
          metrics={metrics}
          detailRows={detailRows}
          agents={agents}
          onAgentClick={(agentId) => navigate(`/${ROUTES.AGENTS}/${agentId}`)}
        />
      ),
    },
    {
      tab: { id: "testing", label: "Testing" },
      content: (
        <div className="toolset-detail__mcp-section">
          <div className="toolset-detail__mcp-header">
            <div className="toolset-detail__mcp-title">
              <IconPlugConnected size={20} />
              <Typography Component="h3" fontSize="fs16" boldness="semibold">MCP server details</Typography>
            </div>
            <div className="toolset-detail__mcp-actions">
              <button type="button" className="toolset-detail__mcp-test-link" onClick={handleTestConnection}>
                Test connection
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button type="button" className="toolset-detail__mcp-dots" aria-label="MCP actions">
                      <IconDots size={18} />
                    </button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={handleConfigure}>Configure</DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                className="toolset-detail__mcp-collapse"
                onClick={() => setMcpExpanded(!mcpExpanded)}
                aria-expanded={mcpExpanded}
                aria-label="Toggle MCP details"
              >
                {mcpExpanded ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
              </button>
            </div>
          </div>

          {mcpExpanded && (
            <div className="toolset-detail__mcp-details">
              <div className="toolset-detail__mcp-grid">
                {mcpDetails.map((field) => (
                  <div key={field.label} className="toolset-detail__mcp-field">
                    {field.label === "Connection status" ? (
                      <>
                        <div className="toolset-detail__mcp-field-value toolset-detail__mcp-status-row">
                          {STATUS_ICON[tool.connectionStatus]}
                          <Typography fontSize="fs14" boldness="semibold">{field.value}</Typography>
                        </div>
                        <Typography fontSize="fs12" color="var(--text-secondary)">{field.label}</Typography>
                      </>
                    ) : (
                      <>
                        <Typography fontSize="fs14">{field.value}</Typography>
                        <Typography fontSize="fs12" color="var(--text-secondary)">{field.label}</Typography>
                      </>
                    )}
                  </div>
                ))}
              </div>

              <div className="toolset-detail__mcp-footer">
                <Typography fontSize="fs12" color="var(--text-secondary)">
                  All API calls are routed through the MCP Gateway with full audit logging and security controls.
                </Typography>
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      tab: { id: "associated-agents", label: `Associated agents (${agents.length})` },
      content: (
        <BaseTable<AgentRow>
          data={agents}
          columns={agentColumns}
          options={{
            enableColumnSorting: true,
            enablePagination: true,
            enableTableTopBar: true,
            topBarOptions: { rowCountLabel: "Assigned agents", showSearch: true },
          }}
        />
      ),
    },
  ]

  return (
    <div className="toolset-detail">
      <SummaryDetailsTemplate
        title="Toolset details"
        summaryStripLayout="split"
        breadcrumbs={[
          { label: "Toolset", href: `/${ROUTES.TOOLSET}` },
          { label: toolId ?? "", href: `/${ROUTES.TOOLSET}/${toolId}` },
        ]}
        actions={(
          <>
            <Button
              variant="icon"
              size="large"
              icon={<IconRefresh size={18} />}
              aria-label="Refresh health status"
              loading={isRefreshing}
              onClick={() => void handleRefresh()}
              isDisabled={!toolId}
            />
            <Button
              variant="outline"
              size="large"
              label="Edit"
              onClick={() => navigate(`/${ROUTES.TOOLSET}/${toolId}/${ROUTES.EDIT}`)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="solid"
                    size="large"
                    label="Actions"
                    icon={<IconChevronDown size={16} />}
                  />
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {/* <DropdownMenuItem onClick={handleDeprecate}>Deprecate</DropdownMenuItem> */}
                  <DropdownMenuItem variant="destructive" onClick={handleDelete}>Delete</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        summaryFields={summaryFields}
        tabPanels={tabPanels}
      />

      <ConfirmDialog
        open={dialog.open}
        title={dialog.title}
        description={dialog.description}
        confirmLabel={dialog.confirmLabel}
        variant={dialog.variant}
        loading={isDeleting}
        onConfirm={dialog.onConfirm}
        onCancel={closeDialog}
      />
    </div>
  )
}

export { ToolsetDetail }

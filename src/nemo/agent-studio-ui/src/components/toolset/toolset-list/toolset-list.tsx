import { useCallback, useMemo, useState, type ReactElement } from "react"
import { useNavigate } from "react-router"

import { ROUTES } from "@/routes/routes.consts"
import { useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import { toast } from "@/ui-lib/base-components/toast/toast"
import BaseTable from "@/ui-lib/base-components/baseTableMcpBxp/baseTable"
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog"

import { summarizeMcpRefresh, useRefreshMcpServersMutation, useDeleteMcpServerMutation, formatMcpServerDeleteError } from "../toolset.api"
import { TOOLSET_STRINGS } from "./toolset-list.consts"
import { mapToolListItemToToolsetRow } from "./utils/toolset.mappers"
import { createToolsetTableColumns } from "./columns/toolset-list.columns"
import type { ToolListItem, ToolsetRow } from "./toolset-list.types"
import { useToolsetListQuery } from "./utils/toolset-list-query"

import "./toolset-list.scss"

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

function ToolsetList(): ReactElement {
  const navigate = useNavigate()
  const { data, isLoading, isError } = useToolsetListQuery()
  const apiRows: ToolListItem[] = (data as { data?: ToolListItem[] } | undefined)?.data ?? []
  const rows: ToolsetRow[] = apiRows.map(mapToolListItemToToolsetRow)
  const [dialog, setDialog] = useState<ConfirmDialogState>(CLOSED_DIALOG)
  const projectId = useAppSelector(projectContextSelector.activeProjectId)
  const [refreshMcpServers, { isLoading: isRefreshing }] = useRefreshMcpServersMutation()
  const [deleteMcpServer, { isLoading: isDeleting }] = useDeleteMcpServerMutation()
  const [deleteState, setDeleteState] = useState<{ id: string; name: string } | null>(null)

  const closeDialog = useCallback((): void => {
    setDialog(CLOSED_DIALOG)
  }, [])

  const closeDeleteDialog = useCallback((): void => {
    setDeleteState(null)
  }, [])

  const confirmDeleteTool = useCallback((): void => {
    if (!projectId || !deleteState || isDeleting) return
    void deleteMcpServer({ projectId, id: deleteState.id })
      .unwrap()
      .then(() => {
        toast.success(`"${deleteState.name}" was deleted.`)
        closeDeleteDialog()
      })
      .catch((err) => {
        toast.error(formatMcpServerDeleteError(err))
      })
  }, [closeDeleteDialog, deleteMcpServer, deleteState, isDeleting, projectId])

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    try {
      const result = await refreshMcpServers({ projectId }).unwrap()
      const { message, tone } = summarizeMcpRefresh(result)
      toast[tone](message)
    } catch {
      toast.error("Unable to refresh health status. Please try again.")
    }
  }, [projectId, refreshMcpServers])

  const columns = useMemo(
    () =>
      createToolsetTableColumns({
        onViewDetails: (toolId) => {
          navigate(`/${ROUTES.TOOLSET}/${toolId}`)
        },
        onEdit: (toolId) => {
          navigate(`/${ROUTES.TOOLSET}/${toolId}/${ROUTES.EDIT}`)
        },
        onDeprecate: (_toolId, toolName) => {
          setDialog({
            open: true,
            variant: "default",
            title: "Deprecate",
            description: `Are you sure you want to deprecate "${toolName}"?`,
            confirmLabel: "Deprecate",
            onConfirm: () => {
              closeDialog()
            },
          })
        },
        onDelete: (toolId, toolName) => {
          setDeleteState({ id: toolId, name: toolName })
        },
      }),
    [closeDialog, navigate],
  )

  const tableOptions = {
    enableColumnSorting: true,
    enablePagination: true,
    enableColumnResizing: true,
    enableStickyHeaders: true,
    enableTableTopBar: true,
    enableRowFilter: true,
    topBarOptions: {
      rowCountLabel: TOOLSET_STRINGS.TABLE_ROW_COUNT_LABEL,
      showSearch: true,
      showSecondaryAction: false,
      onRefresh: () => {
        void handleRefresh()
      },
      refreshLabel: "Refresh",
      isRefreshing,
      primaryActionLabel: TOOLSET_STRINGS.PRIMARY_ACTION_LABEL,
      showPrimaryActionPlusIcon: true,
      onPrimaryAction: () => {
        navigate(`/${ROUTES.TOOLSET}/${ROUTES.TOOLSET_ADD_TOOL}`)
      },
    },
  } as const

  return (
    <div className="toolset-list">
      <header className="toolset-list__header">
        <h1 className="toolset-list__title">{TOOLSET_STRINGS.PAGE_TITLE}</h1>
        <p className="toolset-list__subtitle">{TOOLSET_STRINGS.PAGE_SUBTITLE}</p>
      </header>

      <div className="toolset-list__content">
        {isLoading && (
          <div className="toolset-list__state">{TOOLSET_STRINGS.LOADING_MESSAGE}</div>
        )}

        {!isLoading && isError && (
          <div className="toolset-list__state toolset-list__state--error" role="alert">
            {TOOLSET_STRINGS.ERROR_MESSAGE}
          </div>
        )}

        {!isLoading && !isError && (
          <BaseTable<ToolsetRow>
            data={rows}
            columns={columns}
            isLoading={false}
            isError={false}
            options={tableOptions}
          />
        )}
      </div>

      <ConfirmDialog
        open={dialog.open}
        title={dialog.title}
        description={dialog.description}
        confirmLabel={dialog.confirmLabel}
        variant={dialog.variant}
        onConfirm={dialog.onConfirm}
        onCancel={closeDialog}
      />

      <ConfirmDialog
        open={deleteState !== null}
        title="Delete"
        description={
          deleteState
            ? `Are you sure you want to delete "${deleteState.name}"?`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        loading={isDeleting}
        onConfirm={confirmDeleteTool}
        onCancel={closeDeleteDialog}
      />
    </div>
  )
}

export { ToolsetList }

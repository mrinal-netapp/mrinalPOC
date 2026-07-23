import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useAppSelector } from "@/store";
import { kbSelector } from "@/store/selectors/kb.selector";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListKnowledgeBasesQuery, useDeleteKnowledgeBaseMutation, kbApi } from "@/api/kb-api.slice";
import { kbListPollingInterval } from "@/components/knowledge-base/utils/kb.utils";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { showKnowledgeBaseDeleteErrorToast } from "@/utils/delete-dependents.utils";
import {
  createKBListColumns,
  type KBListTableRow,
  type ActionMenuItem,
} from "@/components/knowledge-base/columns/kb-list.columns";
import type { KBListItem } from "@/api/kb.types";
import { kbPaths } from "../knowledge-base.consts";

import "./kb-list-content.scss";

function KBListContent(): ReactElement {
  const navigate = useNavigate();

  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const listFilters = useAppSelector(kbSelector.listFilters);
  const listQueryArg = useMemo(
    () => ({ projectId, ...listFilters }),
    [projectId, listFilters],
  );
  const cachedListSelector = useMemo(
    () => kbApi.endpoints.listKnowledgeBases.select(listQueryArg),
    [listQueryArg],
  );
  const cachedList = useAppSelector(cachedListSelector);
  const { data, isLoading, isError } = useListKnowledgeBasesQuery(
    listQueryArg,
    {
      pollingInterval: kbListPollingInterval(cachedList.data?.data?.map((item) => item.status)),
      refetchOnMountOrArgChange: true,
      skip: !projectId,
    },
  );
  const [deleteKnowledgeBase, { isLoading: isDeleting }] = useDeleteKnowledgeBaseMutation();

  const [deleteTarget, setDeleteTarget] = useState<{ kbId: string; name: string } | null>(null);

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: "Knowledge bases",
        showSearch: true,
        onPrimaryAction: () => navigate(kbPaths.create),
        primaryActionLabel: "Add",
      },
    }),
    [navigate],
  );

  const handleDelete = useCallback(async () => {
    /* v8 ignore start */
    if (!deleteTarget) return;
    /* v8 ignore stop */
    try {
      await deleteKnowledgeBase({ projectId, kbId: deleteTarget.kbId }).unwrap();
      toast.success(`"${deleteTarget.name}" deleted successfully.`);
    } catch (err) {
      showKnowledgeBaseDeleteErrorToast(err, deleteTarget.name);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteKnowledgeBase, projectId]);

  const getActionMenuItems = useCallback(
    (row: KBListTableRow): ActionMenuItem<KBListTableRow>[] => [
      {
        label: "View details",
        onClick: () => navigate(kbPaths.detail(row.kb_id)),
      },
      {
        label: "Edit",
        onClick: () => navigate(kbPaths.edit(row.kb_id)),
      },
      {
        label: "Delete",
        onClick: () => setDeleteTarget({ kbId: row.kb_id, name: row.name }),
      },
    ],
    [navigate],
  );

  const columns = useMemo(
    () =>
      createKBListColumns({
        onNavigateDetail: (kbId) => navigate(kbPaths.detail(kbId)),
        actionMenuItems: getActionMenuItems,
      }),
    [navigate, getActionMenuItems],
  );

  const tableData: KBListTableRow[] = useMemo(
    () =>
      /* v8 ignore start */
      (data?.data ?? [])
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .map((item: KBListItem) => ({ ...item, id: item.kb_id })),
    /* v8 ignore stop */
    [data],
  );

  return (
    <>
      <BaseTable<KBListTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete knowledge base"
        description={<>Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This action cannot be undone.</>}
        variant="danger"
        confirmLabel="Delete"
        loading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

export { KBListContent };

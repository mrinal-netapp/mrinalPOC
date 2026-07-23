import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import {
  useListCredentialsQuery,
  useDeleteCredentialMutation,
  useValidateCredentialMutation,
} from "./credential-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import {
  createCredentialListColumns,
  type CredentialTableRow,
  type ActionMenuItem,
} from "@/components/credential/columns/credential-list.columns";
import { credentialPaths } from "./credentials.consts";
import "./credentials-list.scss";

const createTableOptions = (onCreateClick: () => void): BaseTableOptions => ({
  enablePagination: true,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  enableRowFilter: true,
  topBarOptions: {
    rowCountLabel: "Credentials",
    showSearch: true,
    onPrimaryAction: onCreateClick,
    primaryActionLabel: "Add credential",
  },
});

function CredentialsList(): ReactElement {
  const navigate = useNavigate();

  const tableOptions: BaseTableOptions = useMemo(
    () => createTableOptions(() => navigate(credentialPaths.create)),
    [navigate],
  );

  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListCredentialsQuery(
    { projectId },
    { skip: !projectId },
  );
  const [deleteCredential, { isLoading: isDeleting }] = useDeleteCredentialMutation();
  const [validateCredential] = useValidateCredentialMutation();

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteBlockerMessage, setDeleteBlockerMessage] = useState<string | null>(null);

  const closeDeleteDialog = useCallback(() => {
    setDeleteTarget(null);
    setDeleteBlockerMessage(null);
  }, []);

  const handleDelete = useCallback(async () => {
    /* v8 ignore start */
    if (!deleteTarget) return;
    /* v8 ignore stop */
    try {
      await deleteCredential({ projectId, id: deleteTarget.id }).unwrap();
      toast.success(`"${deleteTarget.name}" deleted successfully.`);
      closeDeleteDialog();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        const data = (err as { data?: { error?: string; message?: string } }).data;
        const msg = data?.error ?? data?.message ?? "This credential is referenced by other resources and cannot be deleted.";
        setDeleteBlockerMessage(msg);
      } else {
        toast.error(`Failed to delete "${deleteTarget.name}".`);
        closeDeleteDialog();
      }
    }
  }, [deleteTarget, deleteCredential, closeDeleteDialog, projectId]);

  const handleValidate = useCallback(async (row: CredentialTableRow) => {
    try {
      const result = await validateCredential({ projectId, id: row.id }).unwrap();
      if (result.valid) {
        toast.success(`"${row.name}" is valid.`);
      } else {
        toast.error(`"${row.name}" validation failed: ${result.error ?? "unknown error"}`);
      }
    } catch {
      toast.error(`Failed to validate "${row.name}".`);
    }
  }, [validateCredential, projectId]);

  const getActionMenuItems = useCallback(
    (): ActionMenuItem<CredentialTableRow>[] => [
      { label: "Edit", onClick: (r) => navigate(credentialPaths.edit(r.id)) },
      { label: "Rotate secrets", onClick: (r) => navigate(credentialPaths.rotate(r.id)) },
      { label: "Validate", onClick: (r) => void handleValidate(r) },
      { label: "Delete", onClick: (r) => setDeleteTarget({ id: r.id, name: r.name }) },
    ],
    [navigate, handleValidate],
  );

  const columns = useMemo(
    () => createCredentialListColumns({ actionMenuItems: getActionMenuItems }),
    [getActionMenuItems],
  );

  const tableData: CredentialTableRow[] = useMemo(
    () => (data ?? []).map((item) => ({ ...item, id: item.id })),
    [data],
  );

  return (
    <>
      <BaseTable<CredentialTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      {deleteBlockerMessage ? (
        <ConfirmDialog
          open={deleteTarget !== null}
          title="Cannot delete credential"
          description={deleteBlockerMessage}
          cancelLabel="Close"
          hideConfirm
          onConfirm={closeDeleteDialog}
          onCancel={closeDeleteDialog}
        />
      ) : (
        <ConfirmDialog
          open={deleteTarget !== null}
          title="Delete credential"
          description={
            <>Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This action cannot be undone.</>
          }
          variant="danger"
          confirmLabel="Delete"
          loading={isDeleting}
          onConfirm={() => void handleDelete()}
          onCancel={closeDeleteDialog}
        />
      )}
    </>
  );
}

export { CredentialsList };

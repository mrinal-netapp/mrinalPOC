import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { useAddProjectMemberMutation,
  useListProjectMembersQuery,
  useRemoveProjectMemberMutation,
  useUpdateProjectMemberRoleMutation,
} from "@/api/project-api.slice";
import { extractApiErrorMessage } from "@/utils/api-error.utils";
import { createMemberListColumns } from "@/components/projects/columns/member-list.columns";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { TableSearch } from "@/ui-lib/base-components/baseTableMcpBxp/tableSearch";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { toApiMemberRole } from "@/routes/pages/projects/create-edit/project-access.consts";
import {
  ADMINISTRATION_MEMBER_FORM_DEFAULTS,
  ADMINISTRATION_MEMBERS_STRINGS,
  type AdministrationMemberFormValues,
} from "./administration-members.consts";
import { STUB_MEMBER_ROWS, shouldUseStubMembers } from "./administration-members.stub";
import { AdministrationMembersSummary } from "./administration-members-summary";
import {
  accessRoleFromDisplayRole,
  computeMemberRoleSummary,
  createMemberRowFromFormValues,
  filterMemberRows,
  isEmailAddress,
  mapProjectMembersToTableRows,
  type MemberListTableRow,
} from "./administration-members.utils";
import { useIsProjectAdmin } from "./hooks/use-is-project-admin";
import { MemberDeleteDialog } from "./member-delete-dialog";
import { MemberForm } from "./member-form";
import "./administration-members.scss";

interface AdministrationMembersProps {
  onMemberCountChange?: (count: number) => void;
}

function AdministrationMembers({
  onMemberCountChange,
}: AdministrationMembersProps): ReactElement {
  const activeProjectId = useAppSelector(projectContextSelector.activeProjectId);

  const {
    data: membersData,
    isLoading,
    isError,
    error,
  } = useListProjectMembersQuery(activeProjectId, { skip: !activeProjectId });

  const useStubData = shouldUseStubMembers(isError, error);
  const isProjectAdmin = useIsProjectAdmin(activeProjectId, useStubData);

  const [addProjectMember, { isLoading: isAdding }] = useAddProjectMemberMutation();
  const [removeProjectMember, { isLoading: isRemoving }] = useRemoveProjectMemberMutation();
  const [updateProjectMemberRole, { isLoading: isUpdating }] = useUpdateProjectMemberRoleMutation();

  const [stubMembers, setStubMembers] = useState<MemberListTableRow[]>(STUB_MEMBER_ROWS);
  const [searchInput, setSearchInput] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [memberFormMode, setMemberFormMode] = useState<"add" | "edit" | null>(null);
  const [memberFormInitialValues, setMemberFormInitialValues] =
    useState<AdministrationMemberFormValues>(ADMINISTRATION_MEMBER_FORM_DEFAULTS);
  const [deleteTarget, setDeleteTarget] = useState<MemberListTableRow | null>(null);

  const tableData = useMemo(() => {
    if (useStubData) {
      return stubMembers;
    }

    return mapProjectMembersToTableRows(membersData?.members ?? []);
  }, [membersData?.members, stubMembers, useStubData]);

  const filteredTableData = useMemo(
    () => filterMemberRows(tableData, searchInput),
    [searchInput, tableData],
  );

  const roleSummary = useMemo(
    () => computeMemberRoleSummary(tableData),
    [tableData],
  );

  useEffect(() => {
    onMemberCountChange?.(tableData.length);
  }, [onMemberCountChange, tableData.length]);

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableStickyHeaders: true,
    }),
    [],
  );

  const openAddMemberForm = useCallback(() => {
    setMemberFormInitialValues(ADMINISTRATION_MEMBER_FORM_DEFAULTS);
    setMemberFormMode("add");
  }, []);

  const openEditMemberForm = useCallback((row: MemberListTableRow) => {
    setMemberFormInitialValues({
      name: row.name,
      email: row.email,
      role: accessRoleFromDisplayRole(row.displayRole),
    });
    setMemberFormMode("edit");
  }, []);

  const closeMemberForm = useCallback(() => {
    setMemberFormMode(null);
  }, []);

  const getActionMenuItems = useCallback(
    (row: MemberListTableRow) => [
      {
        label: "Edit",
        onClick: () => openEditMemberForm(row),
        isDisabled: !isProjectAdmin,
      },
      {
        label: "Delete",
        onClick: () => setDeleteTarget(row),
        className: "dropdown-menu-item--destructive",
        isDisabled: !isProjectAdmin,
      },
    ],
    [isProjectAdmin, openEditMemberForm],
  );

  const columns = useMemo(
    () => createMemberListColumns({
      actionMenuItems: getActionMenuItems,
      isActionsDisabled: !isProjectAdmin,
      onEditMember: isProjectAdmin ? openEditMemberForm : undefined,
    }),
    [getActionMenuItems, isProjectAdmin, openEditMemberForm],
  );

  const handleAddMember = useCallback(async (values: AdministrationMemberFormValues) => {
    if (!activeProjectId) return;

    const identifier = values.email.trim();
    const normalizedIdentifier = identifier.toLowerCase();
    if (tableData.some((row) => row.email.trim().toLowerCase() === normalizedIdentifier)) {
      toast.error(ADMINISTRATION_MEMBERS_STRINGS.DUPLICATE_MEMBER);
      return;
    }

    if (useStubData) {
      setStubMembers((current) => [...current, createMemberRowFromFormValues(values)]);
      toast.success(ADMINISTRATION_MEMBERS_STRINGS.ADD_SUCCESS(identifier));
      closeMemberForm();
      return;
    }

    try {
      if (!isEmailAddress(identifier)) {
        throw new Error("Enter a valid email address");
      }

      await addProjectMember({
        projectId: activeProjectId,
        body: {
          email: identifier,
          role: toApiMemberRole(values.role),
        },
      }).unwrap();

      toast.success(ADMINISTRATION_MEMBERS_STRINGS.ADD_SUCCESS(identifier));
      closeMemberForm();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : extractApiErrorMessage(error, ADMINISTRATION_MEMBERS_STRINGS.ADD_ERROR);
      toast.error(message);
    }
  }, [activeProjectId, addProjectMember, closeMemberForm, tableData, useStubData]);

  const handleEditMember = useCallback(async (values: AdministrationMemberFormValues) => {
    if (!activeProjectId) return;

    const email = values.email.trim();

    if (useStubData) {
      setStubMembers((current) => current.map((row) => (
        row.userId === email ? createMemberRowFromFormValues(values) : row
      )));
      toast.success(ADMINISTRATION_MEMBERS_STRINGS.UPDATE_SUCCESS);
      closeMemberForm();
      return;
    }

    try {
      await updateProjectMemberRole({
        projectId: activeProjectId,
        body: { email, role: toApiMemberRole(values.role) },
      }).unwrap();

      toast.success(ADMINISTRATION_MEMBERS_STRINGS.UPDATE_SUCCESS);
      closeMemberForm();
    } catch {
      toast.error(ADMINISTRATION_MEMBERS_STRINGS.UPDATE_ERROR);
    }
  }, [activeProjectId, closeMemberForm, updateProjectMemberRole, useStubData]);

  const handleDeleteMember = useCallback(async () => {
    if (!activeProjectId || !deleteTarget) return;

    if (useStubData) {
      setStubMembers((current) => current.filter((row) => row.userId !== deleteTarget.userId));
      toast.success(ADMINISTRATION_MEMBERS_STRINGS.DELETE_SUCCESS(deleteTarget.name));
      setDeleteTarget(null);
      return;
    }

    try {
      const targetEmail = deleteTarget.email?.trim();
      if (!targetEmail) {
        throw new Error("Cannot remove member without an email");
      }
      await removeProjectMember({
        projectId: activeProjectId,
        body: { email: targetEmail },
      }).unwrap();
      toast.success(ADMINISTRATION_MEMBERS_STRINGS.DELETE_SUCCESS(deleteTarget.name));
    } catch {
      toast.error(ADMINISTRATION_MEMBERS_STRINGS.DELETE_ERROR);
    } finally {
      setDeleteTarget(null);
    }
  }, [activeProjectId, deleteTarget, removeProjectMember, useStubData]);

  if (isLoading && !useStubData) {
    return (
      <div className="administration-members__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError && !useStubData) {
    return (
      <Typography Component="p" fontSize="fs14" color="var(--notification-error)">
        {ADMINISTRATION_MEMBERS_STRINGS.LOAD_ERROR}
      </Typography>
    );
  }

  if (memberFormMode !== null) {
    return (
      <div className="administration-members-form-shell">
        <MemberForm
          open
          mode={memberFormMode}
          initialValues={memberFormInitialValues}
          isSubmitting={isAdding || isUpdating}
          onSubmit={memberFormMode === "edit" ? handleEditMember : handleAddMember}
          onCancel={closeMemberForm}
        />
      </div>
    );
  }

  return (
    <>
      <div className="administration-members">
        {useStubData && (
          <Typography
            Component="p"
            fontSize="fs14"
            className="administration-members__stub-banner"
          >
            {ADMINISTRATION_MEMBERS_STRINGS.STUB_PREVIEW_BANNER}
          </Typography>
        )}

        <AdministrationMembersSummary summary={roleSummary} />

        <div className="administration-members__table-section">
          <div className="administration-members__table-header dt-table">
            <div className="dt-top-bar">
              <div className="dt-table-title">
                <Typography Component="span" fontSize="fs16" boldness="semibold">
                  {ADMINISTRATION_MEMBERS_STRINGS.TABLE_TITLE(filteredTableData.length)}
                </Typography>
              </div>

              <div className="dt-actions-group administration-members__table-actions">
                <TableSearch
                  value={searchInput}
                  onChange={setSearchInput}
                  placeholder={ADMINISTRATION_MEMBERS_STRINGS.SEARCH_PLACEHOLDER}
                  isOpen={isSearchOpen}
                  isEnabled
                  onToggle={() => {
                    if (isSearchOpen) {
                      setSearchInput("");
                    }
                    setIsSearchOpen((current) => !current);
                  }}
                />

                <Button
                  variant="solid"
                  size="medium"
                  label={ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL}
                  isDisabled={!isProjectAdmin}
                  onClick={openAddMemberForm}
                />
              </div>
            </div>
          </div>

          {tableData.length === 0 ? (
            <Typography Component="p" fontSize="fs14" className="administration-members__empty">
              {ADMINISTRATION_MEMBERS_STRINGS.EMPTY_STATE}
            </Typography>
          ) : (
            <BaseTable<MemberListTableRow>
              options={tableOptions}
              data={filteredTableData}
              columns={columns}
            />
          )}
        </div>
      </div>

      <MemberDeleteDialog
        open={deleteTarget !== null}
        memberName={deleteTarget?.name ?? ""}
        loading={isRemoving}
        onConfirm={handleDeleteMember}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

export { AdministrationMembers };

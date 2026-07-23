import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { useAppSelector /* , useAppDispatch */ } from "@/store";

import {
  useDeleteAgentMutation,
  useListAgentsQuery,
  useListMcpServersQuery,
  useUpdateAgentStatusMutation,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import {
  createAgentsListColumns,
  type AgentTableRow,
} from "./columns/agents-list.columns";
import "./columns/agent-list.scss";

import {
  AGENTS_LIST_FETCH_LIMIT,
  AGENTS_LIST_STRINGS,
  AGENTS_STRINGS,
  agentsPaths,
} from "./agents.consts";
import { toSingleAgent } from "./utils/agents-api-mapper";
import { getSingleAgentTeamDependencyCount } from "./utils/agent-team-dependency.utils";
import { buildActionMenu, type DeleteTarget } from "./agents-list-actions";
import {
  selectSingleDeprecatedIds,
  // setAgentDeprecated,
  // clearAgentDeprecated,
} from "@/store";

function SingleAgentsList(): ReactElement {
  const navigate = useNavigate();
  // const dispatch = useAppDispatch();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  // Deprecated state lives in Redux so it persists across tab switches.
  const rawDeprecatedIds = useAppSelector(selectSingleDeprecatedIds);
  const deprecatedSet = useMemo(() => new Set(rawDeprecatedIds), [rawDeprecatedIds]);
  const isDeprecated = useCallback((id: string) => deprecatedSet.has(id), [deprecatedSet]);
  // const deprecate = useCallback((id: string) => dispatch(setAgentDeprecated({ kind: "single", id })), [dispatch]);
  // const undeprecate = useCallback((id: string) => dispatch(clearAgentDeprecated({ kind: "single", id })), [dispatch]);

  const { data, isLoading, isError } = useListAgentsQuery(
    { projectId, limit: AGENTS_LIST_FETCH_LIMIT },
    { skip: !projectId },
  );

  // The agents list payload carries attached toolsets only as bare
  // `mcpServerIds`, so join the project's MCP servers to resolve their names
  // for the "Associated resources" column (KBs + teams are already resolved).
  const { data: mcpServers } = useListMcpServersQuery(
    { projectId },
    { skip: !projectId },
  );
  const resolveMcpServerName = useMemo(() => {
    const byId = new Map((mcpServers ?? []).map((s) => [s.id, s.name]));
    return (id: string): string | undefined => byId.get(id);
  }, [mcpServers]);

  const [deleteAgent, { isLoading: isDeleting }] = useDeleteAgentMutation();
  const [updateAgentStatus] = useUpdateAgentStatusMutation();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  // Deploy from the list row. Fires the real status mutation; the mutation's
  // `invalidatesTags` refreshes the row so its deployment status updates.
  const handleDeploy = useCallback(
    async (row: AgentTableRow): Promise<void> => {
      if (!projectId) {
        toast.error(
          `${AGENTS_LIST_STRINGS.DEPLOY_MISSING_PROJECT_PREFIX} "${row.name}": ${AGENTS_LIST_STRINGS.DELETE_MISSING_PROJECT_SUFFIX}`,
        );
        return;
      }
      try {
        await updateAgentStatus({
          projectId,
          id: row.id,
          body: { deploymentStatus: "deployed" },
        }).unwrap();
        toast.success(`"${row.name}" ${AGENTS_LIST_STRINGS.DEPLOY_SUCCESS_SUFFIX}`);
      } catch {
        toast.error(`${AGENTS_LIST_STRINGS.DEPLOY_FAILURE_PREFIX} "${row.name}".`);
      }
    },
    [projectId, updateAgentStatus],
  );

  // Draft from the list row — mirrors handleDeploy but transitions to draft.
  const handleDraft = useCallback(
    async (row: AgentTableRow): Promise<void> => {
      if (!projectId) {
        toast.error(
          `${AGENTS_LIST_STRINGS.DRAFT_MISSING_PROJECT_PREFIX} "${row.name}": ${AGENTS_LIST_STRINGS.DELETE_MISSING_PROJECT_SUFFIX}`,
        );
        return;
      }
      try {
        await updateAgentStatus({
          projectId,
          id: row.id,
          body: { deploymentStatus: "draft" },
        }).unwrap();
        toast.success(`"${row.name}" ${AGENTS_LIST_STRINGS.DRAFT_SUCCESS_SUFFIX}`);
      } catch {
        toast.error(`${AGENTS_LIST_STRINGS.DRAFT_FAILURE_PREFIX} "${row.name}".`);
      }
    },
    [projectId, updateAgentStatus],
  );

  const handleConfirmDelete = useCallback(async (): Promise<void> => {
    /* v8 ignore start -- only runs while the dialog is open, which requires deleteTarget to be set */
    if (!deleteTarget) return;
    /* v8 ignore stop */

    if (!projectId) {
      toast.error(
        `${AGENTS_LIST_STRINGS.DELETE_MISSING_PROJECT_PREFIX} "${deleteTarget.name}": ${AGENTS_LIST_STRINGS.DELETE_MISSING_PROJECT_SUFFIX}`,
      );
      setDeleteTarget(null);
      return;
    }

    try {
      await deleteAgent({ projectId, id: deleteTarget.id }).unwrap();
      toast.success(`"${deleteTarget.name}" ${AGENTS_LIST_STRINGS.DELETE_SUCCESS_SUFFIX}`);
    } catch {
      toast.error(`${AGENTS_LIST_STRINGS.DELETE_FAILURE_PREFIX} "${deleteTarget.name}".`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteAgent, deleteTarget, projectId]);

  const tableData: AgentTableRow[] = useMemo(
    () =>
      (data ?? []).map((agent) => {
        const single = toSingleAgent(agent, resolveMcpServerName);
        return {
          ...single,
          associatedItems: single.associatedResources,
          teamDependencyCount: getSingleAgentTeamDependencyCount(agent),
        };
      }),
    [data, resolveMcpServerName],
  );

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: AGENTS_STRINGS.ROW_LABEL_SINGLE,
        showSearch: true,
        primaryActionLabel: AGENTS_STRINGS.PRIMARY_ACTION,
        onPrimaryAction: () => navigate(agentsPaths.create),
      },
    }),
    [navigate],
  );

  const handleNavigateDetail = useCallback(
    (id: string) => {
      navigate(agentsPaths.detail(id));
    },
    [navigate],
  );

  const columns = useMemo(
    () =>
      createAgentsListColumns({
        associatedColumnHeader: AGENTS_STRINGS.ASSOCIATED_RESOURCES,
        onNavigateDetail: handleNavigateDetail,
        isDeprecated,
        actionMenuItems: (row) =>
          buildActionMenu(row, {
            navigate,
            isDeprecated,
            // deprecate,
            // undeprecate,
            onRequestDelete: setDeleteTarget,
            deploy: handleDeploy,
            draft: handleDraft,
          }),
      }),
    [
      handleNavigateDetail,
      navigate,
      isDeprecated,
      // deprecate,
      // undeprecate,
      handleDeploy,
      handleDraft,
    ],
  );

  return (
    <>
      <BaseTable<AgentTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={AGENTS_LIST_STRINGS.DELETE_AGENT_TITLE}
        description={
          <>
            Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            This action cannot be undone.
          </>
        }
        variant="danger"
        confirmLabel={AGENTS_LIST_STRINGS.DELETE_CONFIRM_LABEL}
        loading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

export { SingleAgentsList };

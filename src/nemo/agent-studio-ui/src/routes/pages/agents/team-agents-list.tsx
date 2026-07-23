import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { useAppSelector, useAppDispatch } from "@/store";

import {
  agentsConfigApi,
  useDeleteAgentTeamMutation,
  useListAgentsQuery,
  useListAgentTeamsQuery,
  useUpdateAgentTeamStatusMutation,
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
import { toTeamAgent } from "./utils/agents-api-mapper";
import { getTeamDependentsCountFromPage } from "./utils/agent-team-dependency.utils";
import { hasBlockingMemberRequirements } from "./utils/agent-requirements.utils";
import { buildActionMenu, type DeleteTarget } from "./agents-list-actions";
import {
  selectTeamDeprecatedIds,
  // setAgentDeprecated,
  // clearAgentDeprecated,
} from "@/store";

function TeamAgentsList(): ReactElement {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  // Deprecated state lives in Redux so it persists across tab switches.
  const rawDeprecatedIds = useAppSelector(selectTeamDeprecatedIds);
  const deprecatedSet = useMemo(() => new Set(rawDeprecatedIds), [rawDeprecatedIds]);
  const isDeprecated = useCallback((id: string) => deprecatedSet.has(id), [deprecatedSet]);
  // const deprecate = useCallback((id: string) => dispatch(setAgentDeprecated({ kind: "team", id })), [dispatch]);
  // const undeprecate = useCallback((id: string) => dispatch(clearAgentDeprecated({ kind: "team", id })), [dispatch]);

  const { data, isLoading, isError } = useListAgentTeamsQuery(
    { projectId, limit: AGENTS_LIST_FETCH_LIMIT },
    { skip: !projectId },
  );
  const {
    data: singleAgents,
    isLoading: isSingleAgentsLoading,
    isFetching: isSingleAgentsFetching,
    isUninitialized: isSingleAgentsUninitialized,
    isError: isSingleAgentsError,
  } = useListAgentsQuery(
    { projectId },
    { skip: !projectId },
  );

  const [deleteAgentTeam, { isLoading: isDeleting }] =
    useDeleteAgentTeamMutation();
  const [updateAgentTeamStatus] = useUpdateAgentTeamStatusMutation();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [teamDependencyCounts, setTeamDependencyCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!projectId || !data || data.length === 0) {
      setTeamDependencyCounts({});
      return;
    }
    let cancelled = false;
    const loadDependencyCounts = async (): Promise<void> => {
      const entries = await Promise.all(
        data.map(async (team) => {
          try {
            // Team delete rules are based on "who depends on this team", not
            // team membership. Fetch the dedicated dependents endpoint with the
            // same `kind=agent_team` filter used on the detail page.
            const page = await dispatch(
              agentsConfigApi.endpoints.listAgentTeamDependents.initiate(
                // We only read `totalByKind` for delete gating, so keep payload
                // tiny and allow RTK Query to reuse cached pages.
                { projectId, id: team.id, kind: "agent_team", limit: 1 },
                { subscribe: false },
              ),
            ).unwrap();
            return [team.id, getTeamDependentsCountFromPage(page)] as const;
          } catch {
            // Keep list actions usable if the dependency pre-check fails; the
            // backend delete endpoint still enforces true dependency blocking.
            return [team.id, 0] as const;
          }
        }),
      );
      if (cancelled) return;
      setTeamDependencyCounts(Object.fromEntries(entries));
    };
    void loadDependencyCounts();
    return () => {
      cancelled = true;
    };
  }, [data, dispatch, projectId]);

  // Deploy from the list row. Fires the real team status mutation; the
  // mutation's `invalidatesTags` refreshes the row so its status updates.
  const handleDeploy = useCallback(
    async (row: AgentTableRow): Promise<void> => {
      if (!projectId) {
        toast.error(
          `${AGENTS_LIST_STRINGS.DEPLOY_MISSING_PROJECT_PREFIX} "${row.name}": ${AGENTS_LIST_STRINGS.DELETE_MISSING_PROJECT_SUFFIX}`,
        );
        return;
      }
      try {
        await updateAgentTeamStatus({
          projectId,
          id: row.id,
          body: { deploymentStatus: "deployed" },
        }).unwrap();
        toast.success(`"${row.name}" ${AGENTS_LIST_STRINGS.DEPLOY_SUCCESS_SUFFIX}`);
      } catch {
        toast.error(`${AGENTS_LIST_STRINGS.DEPLOY_FAILURE_PREFIX} "${row.name}".`);
      }
    },
    [projectId, updateAgentTeamStatus],
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
        await updateAgentTeamStatus({
          projectId,
          id: row.id,
          body: { deploymentStatus: "draft" },
        }).unwrap();
        toast.success(`"${row.name}" ${AGENTS_LIST_STRINGS.DRAFT_SUCCESS_SUFFIX}`);
      } catch {
        toast.error(`${AGENTS_LIST_STRINGS.DRAFT_FAILURE_PREFIX} "${row.name}".`);
      }
    },
    [projectId, updateAgentTeamStatus],
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
      await deleteAgentTeam({ projectId, id: deleteTarget.id }).unwrap();
      toast.success(`"${deleteTarget.name}" ${AGENTS_LIST_STRINGS.DELETE_SUCCESS_SUFFIX}`);
    } catch {
      toast.error(`${AGENTS_LIST_STRINGS.DELETE_FAILURE_PREFIX} "${deleteTarget.name}".`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteAgentTeam, deleteTarget, projectId]);

  const tableData: AgentTableRow[] = useMemo(
    () =>
      (data ?? []).map((team) => {
        const teamAgent = toTeamAgent(team);
        const hasAgentMembers = team.members.some((member) => member.memberType === "agent");
        const memberRequirementsPending = hasAgentMembers && (
          isSingleAgentsLoading ||
          isSingleAgentsFetching ||
          isSingleAgentsUninitialized ||
          isSingleAgentsError
        );
        return {
          ...teamAgent,
          associatedItems: teamAgent.associatedAgents,
          teamDependencyCount: teamDependencyCounts[team.id] ?? 0,
          hasBlockingRequirements: memberRequirementsPending || hasBlockingMemberRequirements(team.members, singleAgents),
        };
      }),
    [
      data,
      singleAgents,
      isSingleAgentsLoading,
      isSingleAgentsFetching,
      isSingleAgentsUninitialized,
      isSingleAgentsError,
      teamDependencyCounts,
    ],
  );

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: AGENTS_STRINGS.ROW_LABEL_TEAM,
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
        associatedColumnHeader: AGENTS_STRINGS.ASSOCIATED_AGENTS,
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
        title={AGENTS_LIST_STRINGS.DELETE_TEAM_TITLE}
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

export { TeamAgentsList };

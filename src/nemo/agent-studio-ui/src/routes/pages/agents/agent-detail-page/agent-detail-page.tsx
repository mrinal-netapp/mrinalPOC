import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";
import { useAppSelector /* , useAppDispatch */ } from "@/store";
import { IconChevronDown, IconRefresh } from "@tabler/icons-react";

import {
  useGetAgentQuery,
  useGetAgentTeamQuery,
  useListAgentsQuery,
  useListAgentTeamDependentsQuery,
  useUpdateAgentStatusMutation,
  useUpdateAgentTeamStatusMutation,
  useDeleteAgentMutation,
  useDeleteAgentTeamMutation,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { SummaryDetailsTemplate } from "@/components/summary-details-template/summary-details-template";
import type {
  SummaryField,
  TabPanel,
} from "@/components/summary-details-template/summary-details-template.types";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";

import { DEPLOY_LOCKED_CLASS, LOCK_AGENT_DEPLOY, isDeployActivationLocked, agentsPaths } from "../agents.consts";
import {
  buildSingleAgentDetail,
  buildTeamAgentDetail,
  isTeamAgentId,
} from "../utils/agents-api-mapper";
import {
  getSingleAgentTeamDependencyCount,
  getTeamDependentsCountFromPage,
} from "../utils/agent-team-dependency.utils";
import {
  hasBlockingMemberRequirements,
  hasBlockingRequirements,
} from "../utils/agent-requirements.utils";
import {
  AGENT_DETAIL_STRINGS,
  DEPLOYMENT_STATUS_MAP,
  HEALTH_STATUS_MAP,
  SHOW_AGENT_CONFIGURATIONS_TAB,
} from "./agent-detail-page.consts";
import type { AgentDetail } from "./agent-detail-page.types";
import { OverviewPanel } from "./panels/overview-panel";
import { ToolsetsPanel, useAgentToolsets } from "./panels/toolsets-panel";
import { ConfigurationsPanel } from "./panels/configurations-panel";
import { AssignedKbPanel, useAgentAssignedKbs } from "./panels/assigned-kb-panel";
import {
  // setAgentDeprecated,
  // clearAgentDeprecated,
  selectSingleDeprecatedIds,
  selectTeamDeprecatedIds,
} from "@/store";
import "./agent-detail-page.scss";

const AGENT_TEAM_DEPENDENT_KIND = "agent_team";

// A 404 from the API means "agent with this id does not exist" — treat it as
// a distinct UX from a generic transport / 5xx failure.
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

function AgentDetailPage(): ReactElement {
  const navigate = useNavigate();
  // const dispatch = useAppDispatch();
  const { agentId } = useParams<{ agentId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const isTeam = !!agentId && isTeamAgentId(agentId);
  const isSingle = !!agentId && !isTeam;

  const singleQuery = useGetAgentQuery(
    { projectId, id: agentId ?? "" },
    { skip: !projectId || !isSingle },
  );
  const teamQuery = useGetAgentTeamQuery(
    { projectId, id: agentId ?? "" },
    { skip: !projectId || !isTeam },
  );
  const teamDependentsQuery = useListAgentTeamDependentsQuery(
    { projectId, id: agentId ?? "", kind: AGENT_TEAM_DEPENDENT_KIND },
    { skip: !projectId || !isTeam || !agentId },
  );
  const teamMembersSingleAgentsQuery = useListAgentsQuery(
    { projectId },
    { skip: !projectId || !isTeam },
  );
  const teamMemberRequirementsPending = isTeam && (
    teamMembersSingleAgentsQuery.isLoading ||
    teamMembersSingleAgentsQuery.isFetching ||
    teamMembersSingleAgentsQuery.isUninitialized ||
    teamMembersSingleAgentsQuery.isError
  );

  const isLoading = singleQuery.isLoading || teamQuery.isLoading;
  const isError = singleQuery.isError || teamQuery.isError;
  const queryError = singleQuery.error ?? teamQuery.error;

  const detail: AgentDetail | undefined = useMemo(() => {
    if (singleQuery.data) return buildSingleAgentDetail(singleQuery.data);
    if (teamQuery.data) return buildTeamAgentDetail(teamQuery.data);
    return undefined;
  }, [singleQuery.data, teamQuery.data]);

  // Tab row-count badges — hooks must run unconditionally (HK-001).
  const { rows: toolsetRows } = useAgentToolsets(agentId ?? "");
  const { rows: assignedKbRows } = useAgentAssignedKbs(agentId ?? "");

  // -- Deprecated state from Redux --
  const singleDeprecatedIds = useAppSelector(selectSingleDeprecatedIds);
  const teamDeprecatedIds = useAppSelector(selectTeamDeprecatedIds);
  const isDeprecated = useMemo(() => {
    if (!agentId) return false;
    return isTeam
      ? teamDeprecatedIds.includes(agentId)
      : singleDeprecatedIds.includes(agentId);
  }, [agentId, isTeam, singleDeprecatedIds, teamDeprecatedIds]);

  // -- Mutations --
  const [updateAgentStatus, { isLoading: isUpdatingSingleStatus }] =
    useUpdateAgentStatusMutation();
  const [updateAgentTeamStatus, { isLoading: isUpdatingTeamStatus }] =
    useUpdateAgentTeamStatusMutation();
  const [deleteAgent, { isLoading: isDeletingSingle }] =
    useDeleteAgentMutation();
  const [deleteAgentTeam, { isLoading: isDeletingTeam }] =
    useDeleteAgentTeamMutation();

  const isActionPending =
    isUpdatingSingleStatus ||
    isUpdatingTeamStatus ||
    isDeletingSingle ||
    isDeletingTeam;

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // -- Refresh --
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      if (isSingle) {
        await singleQuery.refetch().unwrap();
      } else if (isTeam) {
        await teamQuery.refetch().unwrap();
      }
      toast.success(AGENT_DETAIL_STRINGS.REFRESH_SUCCESS);
    } catch {
      toast.error(AGENT_DETAIL_STRINGS.REFRESH_ERROR);
    } finally {
      setIsRefreshing(false);
    }
  }, [isSingle, isTeam, singleQuery, teamQuery]);

  // -- Deploy --
  // Single agents are blocked from deploying while a required KB/MCP placeholder
  // is unresolved. Derived from the raw agent payload so it stays in sync with
  // the disabled menu item and the defensive guard below.
  const deployBlockedByRequirements =
    (isSingle && hasBlockingRequirements(singleQuery.data?.requirements)) ||
    (isTeam &&
      (
        teamMemberRequirementsPending ||
        hasBlockingMemberRequirements(
          teamQuery.data?.members,
          teamMembersSingleAgentsQuery.data,
        )
      ));

  const handleDeploy = useCallback(async (): Promise<void> => {
    if (!agentId || !projectId) return;
    /* v8 ignore start -- defense-in-depth: the Deploy menu item is already
       disabled when a required dependency is unresolved, so this guard is not
       reachable through the UI; it only protects against a programmatic bypass. */
    if (deployBlockedByRequirements) {
      toast.error(AGENT_DETAIL_STRINGS.DEPLOY_BLOCKED_REQUIREMENTS);
      return;
    }
    /* v8 ignore stop */
    try {
      if (isSingle) {
        await updateAgentStatus({ projectId, id: agentId, body: { deploymentStatus: "deployed" } }).unwrap();
      } else {
        await updateAgentTeamStatus({ projectId, id: agentId, body: { deploymentStatus: "deployed" } }).unwrap();
      }
      toast.success(AGENT_DETAIL_STRINGS.DEPLOY_SUCCESS);
    } catch {
      toast.error(AGENT_DETAIL_STRINGS.DEPLOY_ERROR);
    }
  }, [agentId, deployBlockedByRequirements, isSingle, projectId, updateAgentStatus, updateAgentTeamStatus]);

  // -- Draft (un-deploy) --
  const handleDraft = useCallback(async (): Promise<void> => {
    if (!agentId || !projectId) return;
    try {
      if (isSingle) {
        await updateAgentStatus({ projectId, id: agentId, body: { deploymentStatus: "draft" } }).unwrap();
      } else {
        await updateAgentTeamStatus({ projectId, id: agentId, body: { deploymentStatus: "draft" } }).unwrap();
      }
      toast.success(AGENT_DETAIL_STRINGS.DRAFT_SUCCESS);
    } catch {
      toast.error(AGENT_DETAIL_STRINGS.DRAFT_ERROR);
    }
  }, [agentId, isSingle, projectId, updateAgentStatus, updateAgentTeamStatus]);

  // -- Deprecate / Undeprecate (client-side until backend exposes the field) --
  // const handleDeprecate = useCallback((): void => {
  //   if (!agentId) return;
  //   dispatch(setAgentDeprecated({ kind: isTeam ? "team" : "single", id: agentId }));
  //   toast.success(AGENT_DETAIL_STRINGS.DEPRECATE_SUCCESS);
  // }, [agentId, dispatch, isTeam]);

  // const handleUndeprecate = useCallback((): void => {
  //   if (!agentId) return;
  //   dispatch(clearAgentDeprecated({ kind: isTeam ? "team" : "single", id: agentId }));
  //   toast.success(AGENT_DETAIL_STRINGS.UNDEPRECATE_SUCCESS);
  // }, [agentId, dispatch, isTeam]);

  // -- Delete --
  const handleConfirmDelete = useCallback(async (): Promise<void> => {
    if (!agentId || !projectId) return;
    try {
      if (isSingle) {
        await deleteAgent({ projectId, id: agentId }).unwrap();
      } else {
        await deleteAgentTeam({ projectId, id: agentId }).unwrap();
      }
      toast.success(AGENT_DETAIL_STRINGS.DELETE_SUCCESS);
      navigate(agentsPaths.root);
    } catch {
      toast.error(AGENT_DETAIL_STRINGS.DELETE_ERROR);
    } finally {
      setShowDeleteConfirm(false);
    }
  }, [agentId, deleteAgent, deleteAgentTeam, isSingle, navigate, projectId]);

  const dateTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [],
  );

  const renderNotFound = (): ReactElement => (
    <div className="agent-detail agent-detail__not-found">
      <Typography Component="h1" fontSize="fs20" boldness="semibold">
        {AGENT_DETAIL_STRINGS.NOT_FOUND_TITLE}
      </Typography>
      <Button
        variant="flat"
        size="medium"
        label={AGENT_DETAIL_STRINGS.NOT_FOUND_BACK}
        onClick={() => navigate(agentsPaths.root)}
      />
    </div>
  );

  if (isLoading) {
    return (
      <div className="agent-detail agent-detail__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError && isNotFoundError(queryError)) {
    return renderNotFound();
  }

  if (isError) {
    return (
      <div className="agent-detail agent-detail__not-found">
        <Typography Component="h1" fontSize="fs20" boldness="semibold">
          {AGENT_DETAIL_STRINGS.ERROR_TITLE}
        </Typography>
        <Button
          variant="flat"
          size="medium"
          label={AGENT_DETAIL_STRINGS.NOT_FOUND_BACK}
          onClick={() => navigate(agentsPaths.root)}
        />
      </div>
    );
  }

  if (!detail) {
    return renderNotFound();
  }

  const healthVisual = HEALTH_STATUS_MAP[detail.status];
  const deploymentVisual = DEPLOYMENT_STATUS_MAP[detail.deploymentStatus];
  const HealthIcon = healthVisual.icon;
  const DeploymentIcon = deploymentVisual.icon;
  const lastUpdatedFormatted = dateTimeFmt.format(new Date(detail.lastUpdatedISO));
  const createdFormatted = dateTimeFmt.format(new Date(detail.createdISO));
  const modelsLabel = detail.models[0] ?? "—";
  const isDeployed = detail.deploymentStatus === "deployed";
  const singleTeamDependencyCount = isSingle
    ? singleQuery.data
      ? getSingleAgentTeamDependencyCount(singleQuery.data)
      : /* v8 ignore next -- unreachable: the `!detail` guard above returns before this runs, and a rendered single agent always has singleQuery.data */ 0
    : 0;
  const teamDependentsDependencyCount = getTeamDependentsCountFromPage(
    teamDependentsQuery.data,
  );
  const teamDependencyCount = teamDependentsDependencyCount;
  const isTeamDependencyUnknown = isTeam && (
    teamDependentsQuery.isLoading ||
    teamDependentsQuery.isFetching ||
    teamDependentsQuery.isError ||
    teamDependentsQuery.isUninitialized
  );
  const deleteBlockedByDependency = isSingle
    ? singleTeamDependencyCount > 0
    : isTeam
      ? isTeamDependencyUnknown || teamDependencyCount > 0
      : /* v8 ignore next -- unreachable: a rendered detail is always either a single agent or a team, so this neither-kind fallback never runs */ false;

  const summaryFields: SummaryField[] = [
    { label: AGENT_DETAIL_STRINGS.SUMMARY_NAME, value: detail.name },
    {
      label: AGENT_DETAIL_STRINGS.SUMMARY_STATUS,
      value: (
        <div className={`agent-detail__status ${healthVisual.className}`}>
          <HealthIcon size={16} />
          <Typography fontSize="fs14" boldness="semibold">
            {healthVisual.label}
          </Typography>
        </div>
      ),
    },
    {
      label: AGENT_DETAIL_STRINGS.SUMMARY_DEPLOYMENT,
      value: (
        <div className={`agent-detail__status ${deploymentVisual.className}`}>
          <DeploymentIcon size={16} />
          <Typography fontSize="fs14" boldness="semibold">
            {deploymentVisual.label}
          </Typography>
        </div>
      ),
    },
    { label: AGENT_DETAIL_STRINGS.SUMMARY_MODELS, value: modelsLabel },
    { label: AGENT_DETAIL_STRINGS.SUMMARY_LAST_UPDATED, value: lastUpdatedFormatted },
  ];

  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: AGENT_DETAIL_STRINGS.TAB_OVERVIEW },
      content: (
        <OverviewPanel
          detail={detail}
          lastUpdatedFormatted={lastUpdatedFormatted}
          createdFormatted={createdFormatted}
        />
      ),
    },
    {
      tab: {
        id: "toolsets",
        label: `${AGENT_DETAIL_STRINGS.TAB_TOOLSETS} (${toolsetRows.length})`,
      },
      content: <ToolsetsPanel agentId={detail.id} />,
    },
    ...(SHOW_AGENT_CONFIGURATIONS_TAB
      ? [
          {
            tab: {
              id: "configurations",
              label: `${AGENT_DETAIL_STRINGS.TAB_CONFIGURATIONS} (${detail.related.configurations})`,
            },
            content: <ConfigurationsPanel configuration={detail.configuration} />,
          },
        ]
      : []),
    {
      tab: {
        id: "assigned-kb",
        label: `${AGENT_DETAIL_STRINGS.TAB_ASSIGNED_KB} (${assignedKbRows.length})`,
      },
      content: <AssignedKbPanel agentId={detail.id} />,
    },
  ];

  // Actions dropdown — mirrors the list page row menu, adapted for the detail context.
  // "View details" and "Edit" are omitted (we're already here / Edit is a top-level button).
  const actionsDropdown = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="solid"
              size="large"
              label={AGENT_DETAIL_STRINGS.ACTION_MENU}
              icon={<IconChevronDown size={16} />}
              isDisabled={isActionPending || isDeprecated}
            />
          }
        />
        <DropdownMenuContent align="end">
          {isDeployed ? (
            <DropdownMenuItem onClick={handleDraft}>
              {AGENT_DETAIL_STRINGS.ACTION_DRAFT}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className={LOCK_AGENT_DEPLOY ? DEPLOY_LOCKED_CLASS : undefined}
              aria-disabled={LOCK_AGENT_DEPLOY || undefined}
              disabled={LOCK_AGENT_DEPLOY ? undefined : deployBlockedByRequirements}
              onClick={(event) => {
                // True lock: also block keyboard/programmatic activation, not
                // just the mouse. QA can unlock via devtools (remove --locked).
                if (isDeployActivationLocked(event.currentTarget)) return;
                // Devtools-unlock lifts only the lock; the requirements gate
                // must still block deploy when a required KB/MCP is unresolved.
                if (deployBlockedByRequirements) return;
                handleDeploy();
              }}
            >
              {AGENT_DETAIL_STRINGS.ACTION_DEPLOY}
            </DropdownMenuItem>
          )}

          {/* <DropdownMenuItem onClick={handleDeprecate}>
            {AGENT_DETAIL_STRINGS.ACTION_DEPRECATE}
          </DropdownMenuItem> */}

          <DropdownMenuItem
            variant="destructive"
            disabled={deleteBlockedByDependency}
            onClick={() => setShowDeleteConfirm(true)}
          >
            {AGENT_DETAIL_STRINGS.ACTION_DELETE}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Show Undeprecate as a standalone button when the agent is deprecated,
          because the dropdown is disabled in that state. */}
      {/* {isDeprecated && (
        <Button
          variant="solid"
          size="large"
          label={AGENT_DETAIL_STRINGS.ACTION_UNDEPRECATE}
          onClick={handleUndeprecate}
        />
      )} */}
    </>
  );

  return (
    <>
      <div className="agent-detail">
        <SummaryDetailsTemplate
          title={AGENT_DETAIL_STRINGS.PAGE_TITLE}
          breadcrumbs={[
            { label: AGENT_DETAIL_STRINGS.BREADCRUMB_ROOT, href: agentsPaths.root },
            { label: detail.name, href: agentsPaths.detail(detail.id) },
          ]}
          actions={(
            <>
              <Button
                variant="icon"
                size="large"
                icon={<IconRefresh size={18} />}
                aria-label={AGENT_DETAIL_STRINGS.ACTION_REFRESH}
                loading={isRefreshing}
                isDisabled={isRefreshing}
                onClick={handleRefresh}
              />
              <Button
                variant="solid"
                size="large"
                label={AGENT_DETAIL_STRINGS.ACTION_EDIT}
                isDisabled={isDeployed || isDeprecated}
                onClick={() =>
                  navigate(agentsPaths.edit(detail.id), {
                    state: { returnTo: agentsPaths.detail(detail.id) },
                  })
                }
              />
              {actionsDropdown}
            </>
          )}
          summaryFields={summaryFields}
          tabPanels={tabPanels}
        />
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title={AGENT_DETAIL_STRINGS.DELETE_CONFIRM_TITLE}
        description={
          <>
            Are you sure you want to delete &quot;{detail.name}&quot;?
            This action cannot be undone.
          </>
        }
        variant="danger"
        confirmLabel={AGENT_DETAIL_STRINGS.DELETE_CONFIRM_LABEL}
        loading={isDeletingSingle || isDeletingTeam}
        onConfirm={handleConfirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  );
}

export { AgentDetailPage };

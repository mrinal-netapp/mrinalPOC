import type { ReactElement } from "react";
import { useLocation, useSearchParams, useParams } from "react-router";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  useGetAgentQuery,
  useGetAgentTeamQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import {
  isTeamAgentId,
  mapAgentToFormValues,
  mapTeamToFormValues,
} from "@/routes/pages/agents/utils/agents-api-mapper";

import { AgentForm } from "./form/agent-form";
import type { AgentConfiguration, AgentFormValues } from "./form/agent-form.consts";
import type { SaveAgentValues } from "./configure-dialogs/save-agent-dialog";

const VALID_CONFIGURATIONS: readonly AgentConfiguration[] = ["single", "team", "from_template"];

type LocationState = { returnTo?: string } | null;

function parseConfiguration(raw: string | null): AgentConfiguration | undefined {
  if (raw === null) return undefined;
  return VALID_CONFIGURATIONS.find((c) => c === raw);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

/**
 * Entry point for both /agents/create and /agents/:agentId/edit.
 *
 * - Detects edit mode from the `:agentId` route param.
 * - Fetches the existing agent in edit mode and maps it to `AgentFormValues`
 *   so the form is pre-populated without any manual state wiring.
 * - Reads `location.state.returnTo` (passed by the detail or list page) so
 *   the form can navigate back to the right page after saving.
 */
function AgentCreatePage(): ReactElement {
  const location = useLocation();
  const { agentId } = useParams<{ agentId?: string }>();
  const [searchParams] = useSearchParams();
  const configuration = parseConfiguration(searchParams.get("configuration"));

  const isEdit = Boolean(agentId);
  const state = location.state as LocationState;
  const returnTo = state?.returnTo;

  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  // Team ids use the `agr-` prefix; route the edit fetch to the right
  // endpoint so single agents and teams both hydrate the form.
  const isTeam = isEdit && Boolean(agentId) && isTeamAgentId(agentId!);

  // Skip the query in create mode or when there is no projectId yet. The two
  // queries are mutually exclusive — only the one matching the id prefix runs.
  const { data: agent, isLoading: isAgentLoading, isError: isAgentError, error: agentError } = useGetAgentQuery(
    { projectId, id: agentId! },
    { skip: !isEdit || isTeam || !projectId },
  );
  const { data: team, isLoading: isTeamLoading, isError: isTeamError, error: teamError } = useGetAgentTeamQuery(
    { projectId, id: agentId! },
    { skip: !isEdit || !isTeam || !projectId },
  );

  // Derive initialData: prefer the fetched agent/team, then fall back to the
  // ?configuration search param (used when "Add" is clicked with a tab
  // pre-selected).
  const initialData: Partial<AgentFormValues> | undefined = isEdit
    ? isTeam
      ? team
        ? mapTeamToFormValues(team)
        : undefined
      : agent
        ? mapAgentToFormValues(agent)
        : undefined
    : configuration
      ? { configuration }
      : undefined;

  // Identity (name / description / labels) for the SaveAgentDialog. Mapped here
  // from the loaded entity so editing pre-fills the dialog instead of opening
  // blank; identity isn't part of `AgentFormValues`, so it travels separately.
  const initialIdentity: SaveAgentValues | undefined = isEdit
    ? isTeam
      ? team
        ? { name: team.name, description: team.description ?? "", labels: team.labels ?? [] }
        : undefined
      : agent
        ? { name: agent.name, description: agent.description ?? "", labels: agent.labels ?? [] }
        : undefined
    : undefined;

  // In edit mode, hold off rendering the form until the entity loads so the
  // form doesn't flash with empty defaults before the real values arrive.
  const isLoading = isTeam ? isTeamLoading : isAgentLoading;
  const isError = isTeam ? isTeamError : isAgentError;
  const queryError = isTeam ? teamError : agentError;
  const loadedEntity = isTeam ? team : agent;

  if (isEdit && !projectId) {
    return <div className="dset-form-page" aria-busy="true" />;
  }

  if (isEdit && isLoading) {
    return <div className="dset-form-page" aria-busy="true" />;
  }

  if (isEdit && isError && isNotFoundError(queryError)) {
    return (
      <div className="dset-form-page" role="alert">
        Agent not found.
      </div>
    );
  }

  if (isEdit && isError) {
    return (
      <div className="dset-form-page" role="alert">
        Unable to load agent. Please try again.
      </div>
    );
  }

  // Defensive fallback: if the request settled with no entity payload, do not
  // open the edit form in an invalid state.
  if (isEdit && !loadedEntity) {
    return (
      <div className="dset-form-page" role="alert">
        Agent not found.
      </div>
    );
  }

  return (
    <AgentForm
      key={`${location.pathname}?${agent?.id ?? team?.id ?? configuration ?? ""}`}
      isEdit={isEdit}
      agentId={agentId}
      returnTo={returnTo}
      initialData={initialData}
      initialIdentity={initialIdentity}
    />
  );
}

export { AgentCreatePage };

import { useMemo } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  useListAgentsQuery,
  useListAgentTeamsQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import type { Agent, AgentTeam } from "@/routes/pages/agents/api/agents-config.types";
import { AGENTS_LIST_FETCH_LIMIT } from "@/routes/pages/agents/agents.consts";

import type { AgentSubEntity } from "./agent-form.consts";

export type TeamMemberOption = {
  key: string;
  value: string;
  label: string;
};

export type TeamMemberOptions = {
  /** Catalog entities mapped to the card shape rendered by AgentSubEntityCard. */
  entities: AgentSubEntity[];
  /** Dropdown items keyed by the entity id (what the form stores). */
  items: TeamMemberOption[];
  isLoading: boolean;
  isError: boolean;
};

// Config-service persists a binary health (`Healthy` | `Unhealthy`); the card
// renders the lowercase variant. `degraded` is never produced from this source.
function toCardStatus(status: Agent["status"]): AgentSubEntity["status"] {
  return status === "Healthy" ? "healthy" : "unhealthy";
}

// `deploymentStatus` arrives lowercase + snake_case (e.g. `not_deployed`).
// Present it as a single human-readable label ("Not deployed").
function toDeploymentLabel(deploymentStatus: string): string {
  const spaced = deploymentStatus.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function mapAgentToSubEntity(agent: Agent): AgentSubEntity {
  return {
    id: agent.id,
    name: agent.name,
    status: toCardStatus(agent.status),
    deployment: toDeploymentLabel(agent.deploymentStatus),
    labels: agent.labels ?? [],
  };
}

function mapAgentTeamToSubEntity(team: AgentTeam): AgentSubEntity {
  return {
    id: team.id,
    name: team.name,
    status: toCardStatus(team.status),
    deployment: toDeploymentLabel(team.deploymentStatus),
    labels: team.labels ?? [],
  };
}

function toItems(entities: AgentSubEntity[]): TeamMemberOption[] {
  return entities.map((entity) => ({
    key: entity.id,
    value: entity.id,
    label: entity.name,
  }));
}

/**
 * Loads the project's agents from config-service for the team form's Manager
 * and Agents pickers. Returns both the dropdown `items` (id-keyed) and the
 * mapped `entities` used to render the selected sub-entity cards.
 */
export function useTeamAgentOptions(): TeamMemberOptions {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListAgentsQuery(
    { projectId, limit: AGENTS_LIST_FETCH_LIMIT, include: "dependentsSummary=false" },
    { skip: !projectId },
  );

  const entities = useMemo<AgentSubEntity[]>(
    () => (data ?? []).map(mapAgentToSubEntity),
    [data],
  );
  const items = useMemo<TeamMemberOption[]>(() => toItems(entities), [entities]);

  return { entities, items, isLoading, isError: isError || !projectId };
}

/**
 * Loads the project's agent teams from config-service for the team form's
 * Teams picker. Same return shape as `useTeamAgentOptions`.
 */
export function useTeamTeamOptions(): TeamMemberOptions {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListAgentTeamsQuery(
    { projectId, limit: AGENTS_LIST_FETCH_LIMIT, include: "dependentsSummary=false" },
    { skip: !projectId },
  );

  const entities = useMemo<AgentSubEntity[]>(
    () => (data ?? []).map(mapAgentTeamToSubEntity),
    [data],
  );
  const items = useMemo<TeamMemberOption[]>(() => toItems(entities), [entities]);

  return { entities, items, isLoading, isError: isError || !projectId };
}

import { useMemo, type ReactElement } from 'react';
import { IconRobot, IconUsersGroup } from '@tabler/icons-react';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { SelectDropdown } from '@/ui-lib/base-components/select-dropdown/select-dropdown';
import type { SelectDropdownItemData } from '@/ui-lib/base-components/select-dropdown/select-dropdown.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { EvalPropertyStatus } from '@/components/evaluations/property-status/eval-property-status';
import {
  useListAgentsQuery,
  useListAgentTeamsQuery,
  useListProjectModelsQuery,
} from '@/routes/pages/agents/api/agents-config-api.slice';
import type { AgentDeploymentStatus } from '@/routes/pages/agents/api/agents-config.types';
import { useListKnowledgeBasesQuery } from '@/api/kb-api.slice';
import { encodeEvalTargetKey, parseEvalTargetKey } from '@/routes/pages/evaluations/api/eval-mappers';

import './eval-agent-section.scss';

const PLACEHOLDER_VALUE = '—';

/** Human-readable label for each agent deployment status enum value. */
const DEPLOYMENT_STATUS_LABEL: Record<AgentDeploymentStatus, string> = {
  draft: 'Draft',
  preview: 'Preview',
  not_deployed: 'Not deployed',
  deploying: 'Deploying',
  deployed: 'Deployed',
  failed: 'Failed',
  terminating: 'Terminating',
  terminated: 'Terminated',
};

type AgentPropertyRow = {
  label: string;
  value: string;
  isLink?: boolean;
  isStatus?: boolean;
};

type EvalTargetDropdownItem = SelectDropdownItemData & {
  kind: 'agent' | 'team';
};

type EvalAgentSectionProps = {
  agentVersionKey: string;
  submitted: boolean;
  onAgentVersionChange: (key: string) => void;
};

function renderTargetCell(item: EvalTargetDropdownItem): ReactElement {
  const Icon = item.kind === 'team' ? IconUsersGroup : IconRobot;
  return (
    <span className="eval-agent-section__option">
      <Icon size={16} aria-hidden className="eval-agent-section__option-icon" />
      <span>{item.label}</span>
    </span>
  );
}

function EvalAgentSection({
  agentVersionKey,
  submitted,
  onAgentVersionChange,
}: EvalAgentSectionProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: agents = [], isLoading: isAgentsLoading, isError: isAgentsError } = useListAgentsQuery(
    { projectId },
    { skip: !projectId },
  );
  const { data: teams = [], isLoading: isTeamsLoading, isError: isTeamsError } = useListAgentTeamsQuery(
    { projectId, include: 'dependentsSummary=false' },
    { skip: !projectId },
  );
  const { data: models = [] } = useListProjectModelsQuery(
    { projectId, modelType: 'llm' },
    { skip: !projectId },
  );
  const { data: kbResponse } = useListKnowledgeBasesQuery(
    { projectId },
    { skip: !projectId },
  );
  const knowledgeBases = useMemo(() => kbResponse?.data ?? [], [kbResponse]);

  const targetItems = useMemo<EvalTargetDropdownItem[]>(() => {
    const agentItems: EvalTargetDropdownItem[] = agents.map((agent) => ({
      key: encodeEvalTargetKey('agent', agent.id),
      value: encodeEvalTargetKey('agent', agent.id),
      label: agent.name,
      kind: 'agent',
    }));
    const teamItems: EvalTargetDropdownItem[] = teams.map((team) => ({
      key: encodeEvalTargetKey('team', team.id),
      value: encodeEvalTargetKey('team', team.id),
      label: team.name,
      kind: 'team',
    }));
    return [...agentItems, ...teamItems].sort((a, b) => a.label.localeCompare(b.label));
  }, [agents, teams]);

  const selectedTarget = useMemo(
    () => parseEvalTargetKey(agentVersionKey),
    [agentVersionKey],
  );

  const selectedAgent = useMemo(
    () => (selectedTarget.kind === 'agent'
      ? agents.find((agent) => agent.id === selectedTarget.id)
      : undefined),
    [agents, selectedTarget],
  );

  const selectedTeam = useMemo(
    () => (selectedTarget.kind === 'team'
      ? teams.find((team) => team.id === selectedTarget.id)
      : undefined),
    [teams, selectedTarget],
  );

  const properties = useMemo<AgentPropertyRow[] | undefined>(() => {
    if (selectedAgent) {
      const enrichedKbNames = (selectedAgent.associatedResources?.knowledgeBases ?? [])
        .map((kb) => kb.name)
        .filter((name): name is string => Boolean(name));
      const kbNames = enrichedKbNames.length > 0
        ? enrichedKbNames
        : (selectedAgent.knowledgeBaseIds ?? [])
          .map((kbId) => knowledgeBases.find((kb) => kb.kb_id === kbId)?.name)
          .filter((name): name is string => Boolean(name));

      const modelName = selectedAgent.model?.displayName
        ?? selectedAgent.model?.name
        ?? models.find((model) => model.id === selectedAgent.modelId)?.displayName
        ?? models.find((model) => model.id === selectedAgent.modelId)?.name
        ?? selectedAgent.modelClass
        ?? PLACEHOLDER_VALUE;

      const labels = selectedAgent.labels ?? [];
      const deployment = selectedAgent.deploymentStatus
        ? DEPLOYMENT_STATUS_LABEL[selectedAgent.deploymentStatus]
        : PLACEHOLDER_VALUE;
      const toolsetCount = selectedAgent.mcpServerIds?.length ?? 0;

      return [
        { label: 'Name', value: selectedAgent.name, isLink: true },
        { label: 'Status', value: selectedAgent.status ?? PLACEHOLDER_VALUE, isStatus: true },
        { label: 'Deployment', value: deployment, isStatus: true },
        { label: 'Labels', value: labels.length > 0 ? labels.join(', ') : PLACEHOLDER_VALUE },
        { label: 'Model', value: modelName },
        { label: 'Knowledge base', value: kbNames.length > 0 ? kbNames.join(', ') : PLACEHOLDER_VALUE },
        { label: 'Toolset', value: toolsetCount > 0 ? `${toolsetCount}` : PLACEHOLDER_VALUE },
      ];
    }

    if (selectedTeam) {
      const labels = selectedTeam.labels ?? [];
      const deployment = selectedTeam.deploymentStatus
        ? DEPLOYMENT_STATUS_LABEL[selectedTeam.deploymentStatus]
        : PLACEHOLDER_VALUE;
      const memberCount = selectedTeam.members?.length ?? 0;
      const sharedKbCount = selectedTeam.sharedKnowledgeBaseIds?.length ?? 0;

      return [
        { label: 'Name', value: selectedTeam.name, isLink: true },
        { label: 'Status', value: selectedTeam.status ?? PLACEHOLDER_VALUE, isStatus: true },
        { label: 'Deployment', value: deployment, isStatus: true },
        { label: 'Labels', value: labels.length > 0 ? labels.join(', ') : PLACEHOLDER_VALUE },
        { label: 'Members', value: memberCount > 0 ? `${memberCount}` : PLACEHOLDER_VALUE },
        { label: 'Shared knowledge bases', value: sharedKbCount > 0 ? `${sharedKbCount}` : PLACEHOLDER_VALUE },
        {
          label: 'Orchestration',
          value: selectedTeam.orchestrationPolicy ?? PLACEHOLDER_VALUE,
        },
      ];
    }

    return undefined;
  }, [selectedAgent, selectedTeam, models, knowledgeBases]);

  const isLoading = isAgentsLoading || isTeamsLoading;
  const isError = isAgentsError || isTeamsError;

  const dropdownError = submitted && !agentVersionKey
    ? 'Agent or team is required.'
    : isError
      ? 'Failed to load agents and teams.'
      : undefined;

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Agent
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          The agent or team under evaluation and its bound configuration.
        </Typography>
      </div>
      <div className="dset-form__fields">
        <div className="dset-form__field">
          <SelectDropdown
            label="Agent or team"
            items={targetItems}
            value={agentVersionKey}
            onValueChange={(val) => onAgentVersionChange(val as string)}
            placeholder="Select agent or team"
            size="fill"
            isLoading={isLoading}
            emptyMessage="No agents or teams available"
            error={dropdownError}
            options={{ isSearchable: true }}
            renderCell={(item) => renderTargetCell(item as EvalTargetDropdownItem)}
          />
        </div>

        {properties && (
          <dl className="eval-agent-properties">
            {properties.map((prop) => (
              <div key={prop.label} className="eval-agent-properties__row">
                <Typography Component="dt" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="eval-agent-properties__label">
                  {prop.label}
                </Typography>
                <dd className="eval-agent-properties__value">
                  {prop.isStatus ? (
                    <EvalPropertyStatus label={prop.value} />
                  ) : prop.isLink ? (
                    <Typography Component="span" fontSize="fs14" boldness="semibold" color="var(--text-button-primary)">
                      {prop.value}
                    </Typography>
                  ) : (
                    <Typography Component="span" fontSize="fs14" boldness="regular">
                      {prop.value}
                    </Typography>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

export { EvalAgentSection };

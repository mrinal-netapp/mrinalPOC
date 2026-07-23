import { useMemo, useState, type ReactElement } from 'react';

import type { EvaluationTemplate } from '@/routes/pages/evaluations/api/eval.types';
import { JUDGE_DIMENSIONS } from '@/components/evaluations/configure-dialogs/judge-config-dialog';
import { displayEvalActor } from '@/components/evaluations/eval-actor-display';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlockKeyValueList } from '@/ui-lib/base-components/card/card.block';
import type { KeyValueRow } from '@/ui-lib/base-components/card/card.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { TabContent, TabGroup } from '@/ui-lib/base-components/tab/tab-group';
import type { TabItem } from '@/ui-lib/base-components/tab/tab';
import { EvalPropertyStatus } from '@/components/evaluations/property-status/eval-property-status';
import { useListProjectModelsQuery } from '@/routes/pages/agents/api/agents-config-api.slice';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';

import './eval-overview-panel.scss';

type EvalOverviewPanelProps = {
  template: EvaluationTemplate;
  agentName: string;
};

const STRATEGY_LABEL: Record<string, string> = {
  both: 'Deterministic with AI judge',
  deterministic: 'Deterministic only',
  llm_judge: 'AI judge only',
};

const SUB_TABS: TabItem[] = [
  { id: 'details', label: 'Details' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'associated-agent', label: 'Associated agent' },
];

function EvalOverviewPanel({ template, agentName }: EvalOverviewPanelProps): ReactElement {
  const [activeSubTab, setActiveSubTab] = useState('details');
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: projectModels = [] } = useListProjectModelsQuery(
    { projectId, modelType: 'llm' },
    { skip: !projectId },
  );

  const templateExtra = template as EvaluationTemplate & {
    _knowledgeBase?: string;
    _toolset?: string;
  };

  const labels: string[] = useMemo(() => template.labels ?? [], [template.labels]);
  const labelsValue = labels.length > 0 ? labels.join(', ') : '—';
  const models: string[] = useMemo(() => template.models ?? [], [template.models]);
  const modelDisplayValue = useMemo(() => {
    const modelNames = models.map((modelId) => {
      const model = projectModels.find((candidate) => candidate.id === modelId);
      return model?.displayName ?? model?.name ?? modelId;
    });
    return modelNames.join(', ') || '—';
  }, [models, projectModels]);

  const dimensionLabels = useMemo(() => {
    const dims = template.evaluators?.aiJudge?.dimensions ?? [];
    const result = dims
      .map((id) => JUDGE_DIMENSIONS.find((d) => d.id === id)?.title ?? id)
      .filter(Boolean);
    return result.length > 0 ? result.join(', ') : '—';
  }, [template.evaluators]);

  const detailRows: KeyValueRow[] = useMemo(
    () => [
      { label: 'Name', value: template.evalName },
      { label: 'Description', value: template.description ?? '—' },
      { label: 'Labels', value: labelsValue },
      { label: 'Owner', value: displayEvalActor(template.owner) },
      { label: 'Last modified by', value: displayEvalActor(template.lastModifiedBy) },
      { label: 'Last updated', value: template.updatedAt ?? '—' },
      { label: 'Created', value: template.createdAt ?? '—' },
    ],
    [template, labelsValue],
  );

  const strategy = template.evaluators?.strategy;
  const configRows: KeyValueRow[] = useMemo(
    () => [
      { label: 'Strategy', value: STRATEGY_LABEL[strategy] ?? strategy ?? '—' },
      { label: 'Deterministic metrics', value: (template.evaluators?.deterministic?.metrics ?? []).join(', ') || '—' },
      {
        label: 'Model',
        value: (strategy === 'llm_judge' || strategy === 'both') ? modelDisplayValue : '—',
      },
      {
        label: 'Dimensions',
        value: (strategy === 'llm_judge' || strategy === 'both') ? dimensionLabels : '—',
      },
    ],
    [strategy, template.evaluators, modelDisplayValue, dimensionLabels],
  );

  const agentRows: KeyValueRow[] = useMemo(
    () => [
      {
        label: 'Agent name',
        value: (
          <Typography Component="span" fontSize="fs14" boldness="semibold" color="var(--text-button-primary)">
            {agentName}
          </Typography>
        ),
      },
      { label: 'Status', value: <EvalPropertyStatus label="Active" /> },
      { label: 'Deployment', value: <EvalPropertyStatus label="Deployed" /> },
      { label: 'Labels', value: labelsValue },
      { label: 'Model', value: modelDisplayValue },
      { label: 'Knowledge base', value: templateExtra._knowledgeBase ?? '—' },
      { label: 'Toolset', value: templateExtra._toolset ?? '—' },
    ],
    [agentName, labelsValue, modelDisplayValue, templateExtra],
  );

  return (
    <div className="eval-overview">
      <Card>
        <CardContent>
          <TabGroup
            tabs={SUB_TABS}
            activeTabId={activeSubTab}
            onTabChange={setActiveSubTab}
            ariaLabel="Overview sections"
            className="eval-overview__tabs"
          >
            <TabContent tabId="details">
              <CardBlockKeyValueList rows={detailRows} />
            </TabContent>
            <TabContent tabId="configuration">
              <CardBlockKeyValueList rows={configRows} />
            </TabContent>
            <TabContent tabId="associated-agent">
              <CardBlockKeyValueList rows={agentRows} />
            </TabContent>
          </TabGroup>
        </CardContent>
      </Card>
    </div>
  );
}

export { EvalOverviewPanel };

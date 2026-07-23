import { useCallback, type ReactElement } from 'react';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { useListRunsQuery, useTriggerRunMutation } from '@/routes/pages/evaluations/api/eval-api.slice';
import {
  extractDomainMetrics,
  extractGateOutcome,
} from '@/routes/pages/evaluations/api/eval.types';
import { Button } from '@/ui-lib/base-components/button/button';
import { toast } from '@/ui-lib/base-components/toast/toast';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import {
  EvalRunMetricSections,
  RunOverviewCard,
} from '@/components/evaluations/run-metric-sections/eval-run-metric-sections';

import './eval-run-overview-panel.scss';

type EvalRunOverviewPanelProps = {
  templateId: string;
};

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

function EvalRunOverviewPanel({ templateId }: EvalRunOverviewPanelProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: runsData } = useListRunsQuery(
    { projectId, templateId },
    { skip: !projectId || !templateId },
  );
  const [triggerRun, { isLoading: isTriggeringRun }] = useTriggerRunMutation();
  const latestRun = runsData?.data?.[0];

  const handleRunAgain = useCallback(async () => {
    if (!projectId) return;

    try {
      await triggerRun({ projectId, templateId, options: {} }).unwrap();
      toast.success('Run queued successfully.');
    } catch {
      toast.error('Failed to start run.');
    }
  }, [projectId, templateId, triggerRun]);

  if (!latestRun) {
    return (
      <div className="eval-run-overview">
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          No runs yet for this evaluation.
        </Typography>
      </div>
    );
  }

  // Persisted wire shape carries dimensions[].headline + triggeredGates[];
  // flatten via the adapters in eval.types so the metric-section
  // components keep their `domainMetrics` / `gateOutcome` contract.
  const domainMetrics = extractDomainMetrics(latestRun.results);
  const gateOutcome = extractGateOutcome(latestRun.results);

  return (
    <div className="eval-run-overview">
      <div className="eval-run-overview__actions">
        <Button
          type="button"
          variant="outline"
          size="medium"
          label="Run again"
          loading={isTriggeringRun}
          onClick={handleRunAgain}
        />
      </div>
      <RunOverviewCard run={latestRun} domainMetrics={domainMetrics} />
      <EvalRunMetricSections domainMetrics={domainMetrics} gateOutcome={gateOutcome} />
    </div>
  );
}

export { EvalRunOverviewPanel };

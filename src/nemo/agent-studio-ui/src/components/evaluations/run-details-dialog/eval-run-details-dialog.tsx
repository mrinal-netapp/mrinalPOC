import type { ReactElement } from 'react';

import type { EvaluationRun } from '@/routes/pages/evaluations/api/eval.types';
import {
  extractDomainMetrics,
  extractGateOutcome,
} from '@/routes/pages/evaluations/api/eval.types';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/ui-lib/base-components/dialog/dialog';
import { Button } from '@/ui-lib/base-components/button/button';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import {
  EvalRunMetricSections,
  RunOverviewCard,
} from '@/components/evaluations/run-metric-sections/eval-run-metric-sections';

import './eval-run-details-dialog.scss';

type EvalRunDetailsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: EvaluationRun;
};

function EvalRunDetailsDialog({
  open,
  onOpenChange,
  run,
}: EvalRunDetailsDialogProps): ReactElement {
  // Adapt the persisted wire shape (dimensions[]/triggeredGates) into the
  // flat domainMetrics map / gateOutcome object the metric-section
  // components consume. See `eval.types.ts` for the extractor docstrings.
  const domainMetrics = extractDomainMetrics(run.results);
  const hasDomainMetrics = Object.keys(domainMetrics).length > 0;
  const gateOutcome = extractGateOutcome(run.results);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogPopup className="eval-run-details-dialog__popup">
        <DialogHeader>
          <DialogTitle>{run.name}</DialogTitle>
        </DialogHeader>

        <div className="eval-run-details-dialog__body">
          {/* Overview headline card + grouped metric section cards */}
          {hasDomainMetrics ? (
            <>
              <RunOverviewCard run={run} domainMetrics={domainMetrics} />
              <EvalRunMetricSections domainMetrics={domainMetrics} gateOutcome={gateOutcome} />
            </>
          ) : (
            <div className="eval-run-details-dialog__empty">
              <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                {run.status === 'running' || run.status === 'queued'
                  ? 'Run in progress — metrics will appear when complete.'
                  : 'No results data available for this run.'}
              </Typography>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            label="Close"
            onClick={() => onOpenChange(false)}
          />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export { EvalRunDetailsDialog };

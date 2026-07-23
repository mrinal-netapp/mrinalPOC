import type { ReactElement } from 'react';
import { IconCircleCheck, IconCircleX } from '@tabler/icons-react';

import type { EvaluationRun } from '@/routes/pages/evaluations/api/eval.types';
import {
  extractDomainMetrics,
  extractGateOutcome,
} from '@/routes/pages/evaluations/api/eval.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardContent } from '@/ui-lib/base-components/card/card.content';

import './eval-run-results-breakdown.scss';

type EvalRunResultsBreakdownProps = {
  run: EvaluationRun;
};

/** Formats a metric value (0–100 percentage) as a percentage string. */
function formatMetricValue(value: number, key: string): string {
  // Failure / error rates are small percentages — show 1 decimal place.
  if (key.toLowerCase().includes('failure') || key.toLowerCase().includes('error')) {
    return `${value.toFixed(1)}%`;
  }
  return `${Math.round(value)}%`;
}

/**
 * Headline percentage values surfaced as the top KPI row, derived from the
 * persisted wire shape: `coverage.completedPct`, `infraFailureRate * 100`,
 * and the optional `qualityPct` score.
 */
function headlineMetrics(run: EvaluationRun): Array<[string, number]> {
  const r = run.results;
  if (!r) return [];
  const out: Array<[string, number]> = [];
  if (r.coverage && typeof r.coverage.completedPct === 'number') {
    out.push(['Test case coverage', r.coverage.completedPct]);
  }
  if (typeof r.infraFailureRate === 'number') {
    out.push(['Infrastructure failure rate', r.infraFailureRate * 100]);
  }
  if (typeof r.qualityPct === 'number') {
    out.push(['Quality', r.qualityPct]);
  }
  return out;
}

/**
 * Renders the results section of an evaluation run: a grid of headline KPIs
 * (coverage / infra failure / quality) plus per-metric domain scores, and the
 * gate outcome (passed flag + any failed gate names).
 *
 * This standalone breakdown view is not currently wired into the run panels.
 */
function EvalRunResultsBreakdown({ run }: EvalRunResultsBreakdownProps): ReactElement {
  const { results } = run;
  const hasResults = !!results;

  // Headline KPIs followed by per-metric domain scores (flattened from
  // each dimension's headline map; see extractDomainMetrics in eval.types).
  const headline = headlineMetrics(run);
  const domainEntries: Array<[string, number]> = Object.entries(extractDomainMetrics(results));
  const metricEntries: Array<[string, number]> = [...headline, ...domainEntries];

  const gateOutcome = extractGateOutcome(results);

  if (!hasResults) {
    return (
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
        {run.status === 'running' || run.status === 'queued'
          ? 'Run in progress — metrics will appear when complete.'
          : 'No results data available for this run.'}
      </Typography>
    );
  }

  return (
    <div className="eval-run-results-breakdown">
      {/* Metric KPI grid */}
      {metricEntries.length > 0 && (
        <Card>
          <CardContent>
            <div className="eval-run-results-breakdown__metrics">
              {metricEntries.map(([key, value]) => (
                <div key={key} className="eval-run-results-breakdown__metric-cell">
                  <Typography Component="span" fontSize="fs14" boldness="semibold">
                    {formatMetricValue(value, key)}
                  </Typography>
                  <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
                    {key}
                  </Typography>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Gate outcome */}
      {gateOutcome && (
        <div className="eval-run-results-breakdown__gates">
          <Typography Component="h4" fontSize="fs14" boldness="semibold">
            Gate results
          </Typography>
          <div className="eval-run-results-breakdown__gates-list">
            <div className="eval-run-results-breakdown__gate-row">
              <span className="eval-run-results-breakdown__gate-icon">
                {gateOutcome.passed
                  ? <IconCircleCheck size={16} color="var(--notification-success)" />
                  : <IconCircleX size={16} color="var(--notification-error)" />}
              </span>
              <Typography
                Component="span"
                fontSize="fs13"
                boldness="regular"
                className="eval-run-results-breakdown__gate-label"
              >
                {gateOutcome.passed
                  ? 'All gates passed'
                  : `Failed gates: ${gateOutcome.failedGates.join(', ') || '—'}`}
              </Typography>
              <Typography
                Component="span"
                fontSize="fs13"
                boldness="semibold"
                color={gateOutcome.passed ? 'var(--notification-success)' : 'var(--notification-error)'}
              >
                {gateOutcome.passed ? 'Pass' : 'Fail'}
              </Typography>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { EvalRunResultsBreakdown };

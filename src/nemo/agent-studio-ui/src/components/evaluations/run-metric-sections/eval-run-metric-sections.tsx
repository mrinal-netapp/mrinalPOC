/**
 * Shared metric section cards for eval run results.
 *
 * Used by both:
 *  - EvalRunDetailsDialog (the "View results" popup)
 *  - EvalRunOverviewPanel (the "Run overview" detail tab)
 *
 * Renders grouped metric section cards (AI judge, RAG quality, Correctness,
 * Performance, Token usage) from a flat domainMetrics map, plus a gate results
 * card, mirroring Mike's EvalRunOverviewCards wireframe.
 */

import { useMemo, type ReactElement } from 'react';
import {
  IconAlertTriangle,
  IconAward,
  IconChartBar,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconFileSearch,
  IconPlayerPlay,
  IconShieldCheck,
  IconSparkles,
} from '@tabler/icons-react';

import type { EvaluationRun } from '@/routes/pages/evaluations/api/eval.types';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardHeader } from '@/ui-lib/base-components/card/card.header';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlock, CardBlockLabel } from '@/ui-lib/base-components/card/card.block';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { InfoPopover } from '@/ui-lib/base-components/info-popover/info-popover';

import {
  bucketMetrics,
  expectedGroupMetrics,
  findDef,
  formatValue,
  GROUP_HEADLINE_KEYS,
  MEAN_JUDGE_KEYS,
  METRIC_GROUPS,
  metricStatus,
  type BucketedMetric,
  type MetricGroupId,
} from '@/routes/pages/evaluations/detail/panels/eval-run-overview.catalog';

import './eval-run-metric-sections.scss';

// ---------------------------------------------------------------------------
// Single metric column
// ---------------------------------------------------------------------------

function MetricBlock({
  metric,
}: {
  metric: BucketedMetric;
}): ReactElement {
  // A metric the backend didn't report comes through with value NaN — show a
  // placeholder and no status icon rather than "0%"/"NaN".
  const isAbsent = Number.isNaN(metric.value);
  const status = isAbsent
    ? 'neutral'
    : metricStatus(metric.value, metric.unit, metric.higherIsBetter);

  const statusIcon =
    status === 'pass' ? (
      <IconCircleCheck size={14} color="var(--notification-success)" />
    ) : status === 'warn' ? (
      <IconAlertTriangle size={14} color="var(--notification-warning)" />
    ) : null;

  return (
    <div className="eval-run-metric-sections__cell">
      <div className="eval-run-metric-sections__metric-value">
        {statusIcon}
        <Typography Component="span" fontSize="fs14" boldness="semibold">
          {isAbsent ? '—' : formatValue(metric.value, metric.unit)}
        </Typography>
      </div>
      <span className="eval-run-metric-sections__metric-label">
        <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
          {metric.label}
        </Typography>
        {metric.tooltip && <InfoPopover content={metric.tooltip} side="top" />}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Named metric group section card
// ---------------------------------------------------------------------------

const GROUP_ICONS: Record<string, ReactElement> = {
  'ai-judge':     <IconSparkles size={20} />,
  'rag-quality':  <IconFileSearch size={20} />,
  'correctness':  <IconAward size={20} />,
  'performance':  <IconClock size={20} />,
  'token-usage':  <IconChartBar size={20} />,
};

export function MetricGroupCard({
  groupId,
  metrics,
}: {
  groupId: MetricGroupId;
  metrics: BucketedMetric[];
}): ReactElement {
  const group = METRIC_GROUPS.find((g) => g.id === groupId)!;

  return (
    <Card>
      <CardHeader title={group.title} hasSeparator icon={GROUP_ICONS[groupId]} />
      <CardContent>
        <div className="eval-run-metric-sections__grid">
          {metrics.map((m) => (
            <MetricBlock key={m.key} metric={m} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Leftovers card (unrecognised metric keys)
// ---------------------------------------------------------------------------

function LeftoversCard({ metrics }: { metrics: BucketedMetric[] }): ReactElement {
  return (
    <Card>
      <CardHeader title="Other metrics" hasSeparator icon={<IconChartBar size={20} />} />
      <CardContent>
        <div className="eval-run-metric-sections__grid">
          {metrics.map((m) => (
            <MetricBlock key={m.key} metric={m} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Gate outcome card
// ---------------------------------------------------------------------------

export function GateOutcomeCard({
  passed,
  failedGates,
}: {
  passed: boolean;
  failedGates: string[];
}): ReactElement {
  return (
    <Card>
      <CardHeader title="Gate results" hasSeparator icon={<IconShieldCheck size={20} />} />
      <CardContent>
        <CardBlock type="key-value">
          <CardBlockLabel>Result</CardBlockLabel>
          <span className="eval-run-metric-sections__gate-result">
            {passed ? (
              <IconCircleCheck size={16} color="var(--notification-success)" />
            ) : (
              <IconCircleX size={16} color="var(--notification-error)" />
            )}
            <Typography
              Component="span"
              fontSize="fs14"
              boldness="semibold"
              color={passed ? 'var(--notification-success)' : 'var(--notification-error)'}
            >
              {passed
                ? 'All gates passed'
                : `Failed: ${failedGates.length > 0 ? failedGates.join(', ') : '—'}`}
            </Typography>
          </span>
        </CardBlock>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Overview card (run name + baseline + headline KPIs per group)
// ---------------------------------------------------------------------------

/**
 * A single scorecard column: value on top (with optional status icon),
 * label below (with optional info tooltip).
 */
function ScorecardField({
  value,
  label,
  tooltip,
  status,
}: {
  value: string;
  label: string;
  tooltip?: string;
  status?: 'pass' | 'warn' | 'neutral' | 'fail';
}): ReactElement {
  const statusIcon =
    status === 'pass' ? <IconCircleCheck size={14} color="var(--notification-success)" />
    : status === 'warn' ? <IconAlertTriangle size={14} color="var(--notification-warning)" />
    : status === 'fail' ? <IconCircleX size={14} color="var(--notification-error)" />
    : null;

  return (
    <div className="eval-run-overview__scorecard-field eval-run-overview__scorecard-field--divider">
      <div className="eval-run-overview__scorecard-value">
        {statusIcon}
        <Typography Component="span" fontSize="fs14" boldness="semibold">
          {value}
        </Typography>
      </div>
      <span className="eval-run-overview__scorecard-label">
        <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
          {label}
        </Typography>
        {tooltip && <InfoPopover content={tooltip} side="top" />}
      </span>
    </div>
  );
}

/** Run identity column: linked name on top, "Latest run" sublabel below. */
function RunIdentityField({ name }: { name: string }): ReactElement {
  return (
    <div className="eval-run-overview__scorecard-field">
      <Typography
        Component="span"
        fontSize="fs14"
        boldness="semibold"
        color="var(--text-button-primary)"
        isEllipsis
        title={name}
      >
        {name}
      </Typography>
      <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
        Latest run
      </Typography>
    </div>
  );
}

/**
 * Coverage-completeness status: how many test cases completed successfully.
 * < 50% → fail (red), 100% → pass (green), in between → warn (amber).
 */
function coverageStatus(pct: number): 'pass' | 'warn' | 'fail' {
  if (pct >= 100) return 'pass';
  if (pct < 50) return 'fail';
  return 'warn';
}

/**
 * Overview headline card: run identity + one headline KPI per metric group.
 * Shared by the run overview detail tab and the "View results" dialog.
 */
export function RunOverviewCard({
  run,
  domainMetrics,
}: {
  run: EvaluationRun;
  domainMetrics: Record<string, number>;
}): ReactElement {
  const headlineMetrics = useMemo<BucketedMetric[]>(() => {
    const items: BucketedMetric[] = [];
    const keys = Object.keys(domainMetrics);
    const norm = (k: string): string => k.trim().toLowerCase();

    const meanKey = keys.find((k) => MEAN_JUDGE_KEYS.has(norm(k)));
    if (meanKey !== undefined) {
      items.push({
        key: meanKey,
        label: 'Mean AI judge score',
        value: domainMetrics[meanKey],
        unit: 'percent',
        tooltip: 'Average AI judge score across all enabled dimensions and completed test cases.',
        higherIsBetter: true,
      });
    } else {
      // No explicit mean-judge key in the contract — derive it as the average of
      // the AI-judge dimension values (already on a 0–100 scale).
      const judgeMetrics = bucketMetrics(domainMetrics).groups.get('ai-judge') ?? [];
      if (judgeMetrics.length > 0) {
        const mean =
          judgeMetrics.reduce((sum, m) => sum + m.value, 0) / judgeMetrics.length;
        items.push({
          key: 'mean-ai-judge',
          label: 'Mean AI judge score',
          value: mean,
          unit: 'percent',
          tooltip: 'Average AI judge score across all enabled dimensions and completed test cases.',
          higherIsBetter: true,
        });
      }
    }

    for (const group of METRIC_GROUPS) {
      const preferred = GROUP_HEADLINE_KEYS[group.id as MetricGroupId];
      const match = keys.find(
        (k) => preferred.some((pk) => pk === norm(k)) && !MEAN_JUDGE_KEYS.has(norm(k)),
      );
      if (match !== undefined) {
        // Prefer the catalog definition so the headline uses the correct label,
        // unit (incl. 0–1 `fraction` scaling), and direction. Fall back to a
        // key-name heuristic for keys not yet in the catalog.
        const def = findDef(match);
        const isLatency = match.toLowerCase().includes('latency');
        const isTokens = match.toLowerCase().includes('tokens');
        items.push({
          key: match,
          label: def?.label ?? match,
          value: domainMetrics[match],
          unit: def?.unit ?? (isLatency ? 'ms' : isTokens ? 'tokens' : 'percent'),
          tooltip: def?.tooltip ?? '',
          higherIsBetter: def?.higherIsBetter ?? (!isLatency && !isTokens),
        });
      }
    }

    return items;
  }, [domainMetrics]);

  return (
    <Card>
      <CardHeader title="Overview" hasSeparator icon={<IconPlayerPlay size={20} />} />
      <CardContent>
        <div className="eval-run-overview__scorecard-row">
          <RunIdentityField name={run.name} />
          {run.results?.coverage?.completedPct !== undefined && (
            <ScorecardField
              value={`${Number(run.results.coverage.completedPct).toFixed(2)}%`}
              label="Coverage completeness"
              tooltip="Share of test cases that completed successfully."
              status={coverageStatus(run.results.coverage.completedPct)}
            />
          )}
          {headlineMetrics.slice(0, 5).map((m) => (
            <ScorecardField
              key={m.key}
              value={formatValue(m.value, m.unit)}
              label={m.label}
              tooltip={m.tooltip || undefined}
              status={metricStatus(m.value, m.unit, m.higherIsBetter)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main export: render all metric sections for a run
// ---------------------------------------------------------------------------

type EvalRunMetricSectionsProps = {
  domainMetrics: Record<string, number>;
  gateOutcome?: { passed: boolean; failedGates: string[] } | null;
};

/**
 * Renders grouped metric section cards + gate results card.
 * Drop this into any layout that shows run results details.
 */
function EvalRunMetricSections({
  domainMetrics,
  gateOutcome,
}: EvalRunMetricSectionsProps): ReactElement {
  const bucketed = useMemo(() => bucketMetrics(domainMetrics), [domainMetrics]);

  // "Other metrics" intentionally does NOT show the raw unmapped backend keys
  // (e.g. safety.*, perf.e2e_ms_p50, cost.* percentile/sum variants) — those are
  // noise. It shows only the headline "Mean AI judge score", derived as the
  // average of the AI-judge dimension values (already 0–100).
  const otherMetrics = useMemo<BucketedMetric[]>(() => {
    const judge = bucketed.groups.get('ai-judge') ?? [];
    if (judge.length === 0) return [];
    const mean = judge.reduce((sum, m) => sum + m.value, 0) / judge.length;
    return [
      {
        key: 'mean-ai-judge',
        label: 'Mean AI judge score',
        value: mean,
        unit: 'percent',
        tooltip: 'Average AI judge score across all enabled dimensions and completed test cases.',
        higherIsBetter: true,
      },
    ];
  }, [bucketed]);

  return (
    <div className="eval-run-metric-sections">
      {METRIC_GROUPS.map((group) => {
        // RAG quality always lists all three metrics (Groundedness, Retrieval
        // precision, Retrieval recall), with "—" for any the backend omits — but
        // the whole section is hidden when every RAG value is absent or 0.
        if (group.id === 'rag-quality') {
          const ragMetrics = expectedGroupMetrics('rag-quality', domainMetrics);
          const allEmptyOrZero = ragMetrics.every(
            (m) => Number.isNaN(m.value) || m.value === 0,
          );
          if (allEmptyOrZero) return null;
          return (
            <MetricGroupCard key={group.id} groupId={group.id} metrics={ragMetrics} />
          );
        }

        const metrics = bucketed.groups.get(group.id);
        if (!metrics || metrics.length === 0) return null;
        return (
          <MetricGroupCard key={group.id} groupId={group.id} metrics={metrics} />
        );
      })}

      {otherMetrics.length > 0 && (
        <LeftoversCard metrics={otherMetrics} />
      )}

      {gateOutcome && (
        <GateOutcomeCard passed={gateOutcome.passed} failedGates={gateOutcome.failedGates} />
      )}
    </div>
  );
}

export { EvalRunMetricSections };

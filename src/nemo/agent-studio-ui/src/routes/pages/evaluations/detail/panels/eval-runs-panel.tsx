import { useMemo, useState, type ReactElement } from 'react';
import {
  IconDotsVertical,
  // Baseline disabled for this phase - re-enable when needed
  // IconInfoCircle,
} from '@tabler/icons-react';
import type { ColumnDef } from '@tanstack/react-table';

import { BaseTable } from '@/ui-lib/base-components/baseTableMcpBxp';
import type { BaseTableOptions, BaseElement } from '@/ui-lib/base-components/baseTableMcpBxp';
import { Button } from '@/ui-lib/base-components/button/button';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui-lib/base-components/dropdown-menu/dropdown-menu';
import { Typography } from '@/ui-lib/base-components/typography/typography';
// Baseline disabled for this phase - re-enable useSetBaselineMutation when needed
import { useListRunsQuery, useGetRunQuery, useTriggerRunMutation } from '@/routes/pages/evaluations/api/eval-api.slice';
import { useListAgentsQuery } from '@/routes/pages/agents/api/agents-config-api.slice';
import { toast } from '@/ui-lib/base-components/toast/toast';
import type { EvaluationBaselineStatus, EvaluationRun } from '@/routes/pages/evaluations/api/eval.types';
import { extractDomainMetrics } from '@/routes/pages/evaluations/api/eval.types';
import { EvalStatusCell } from '@/components/evaluations/columns/cells/eval-status-cell';
import { EvalRunDetailsDialog } from '@/components/evaluations/run-details-dialog/eval-run-details-dialog';
import { JUDGE_DIMENSIONS } from '@/components/evaluations/configure-dialogs/judge-config-dialog';

import './eval-runs-panel.scss';

type EvalRunsPanelProps = {
  templateId: string;
};

const STRATEGY_DISPLAY: Record<string, string> = {
  both: 'Deterministic with AI judge',
  deterministic: 'Deterministic',
  llm_judge: 'AI judge only',
};

/* Baseline disabled for this phase - re-enable when needed
// Human-readable label for the baseline status enum value.
const BASELINE_LABEL: Record<EvaluationBaselineStatus, string> = {
  current_baseline: 'Current baseline',
  above_baseline: 'Above baseline',
  below_baseline: 'Below baseline',
  not_set: '—',
};
*/

/** Resolve underscore dimension keys to human-readable labels. */
function resolveDimensionLabels(keys: string[]): string[] {
  return keys.map((k) => JUDGE_DIMENSIONS.find((d) => d.id === k)?.title ?? k);
}

/** Flattened shape the table renders — mapped from EvaluationRun. */
type RunRow = BaseElement & {
  runId: string;
  name: string;
  status: EvaluationRun['status'];
  baselineStatus: EvaluationBaselineStatus;
  meanJudgeScore: string;
  agentName: string;
  strategy: string;
  judgeModel: string;
  judgeDimensions: string;
  createdAt: string;
};

function runToRow(run: EvaluationRun, resolveAgentName: (agentId: string) => string): RunRow {
  const snapshot = run.templateSnapshot;

  // Mean AI judge score from run results (if available). The persisted
  // wire shape stores per-dimension headline maps; flatten via the
  // adapter before scanning for a "Mean AI judge" key.
  const domainMetrics = extractDomainMetrics(run.results);
  const meanKey = Object.keys(domainMetrics).find(
    (k) => k.trim().toLowerCase() === 'mean ai judge' || k.trim().toLowerCase() === 'mean ai judge score',
  );
  const meanJudgeScore = meanKey !== undefined ? `${Math.round(domainMetrics[meanKey])}%` : '—';

  // AI judge model
  const judgeModels = snapshot?.evaluators?.aiJudge?.models ?? [];
  const judgeModel = judgeModels[0] ?? '—';

  // AI judge dimensions — resolve keys to labels, show first 3 + "+N"
  const rawDims = snapshot?.evaluators?.aiJudge?.dimensions ?? [];
  const dimLabels = resolveDimensionLabels(rawDims);
  const judgeDimensions = dimLabels.length === 0
    ? '—'
    : dimLabels.slice(0, 3).join(', ') + (dimLabels.length > 3 ? ` +${dimLabels.length - 3}` : '');

  const rawStrategy = snapshot?.evaluators?.strategy ?? '';

  // The run snapshot only stores agentId; resolve to the human-readable name.
  const agentId = snapshot?.agent?.agentId ?? '';

  return {
    id: run.runId,
    runId: run.runId,
    name: run.name,
    status: run.status,
    baselineStatus: run.baselineStatus,
    meanJudgeScore,
    agentName: agentId ? resolveAgentName(agentId) : '—',
    strategy: STRATEGY_DISPLAY[rawStrategy] ?? (rawStrategy || '—'),
    judgeModel,
    judgeDimensions,
    createdAt: run.trigger?.triggeredAt ?? '—',
  };
}

function EvalRunsPanel({ templateId }: EvalRunsPanelProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [runDialogRunId, setRunDialogRunId] = useState<string | null>(null);
  const { data: runDialogRun } = useGetRunQuery(
    { projectId, runId: runDialogRunId ?? '' },
    { skip: !projectId || !runDialogRunId },
  );
  // Baseline disabled for this phase - re-enable when needed
  // const [setBaseline] = useSetBaselineMutation();
  const [triggerRun] = useTriggerRunMutation();

  const { data: runsData } = useListRunsQuery(
    { projectId, templateId },
    { skip: !projectId || !templateId },
  );

  // Agent records hold the human-readable name; run snapshots only store the id.
  const { data: agents = [] } = useListAgentsQuery(
    { projectId },
    { skip: !projectId },
  );
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const tableData: RunRow[] = useMemo(
    () => (runsData?.data ?? []).map(
      (run) => runToRow(run, (agentId) => agentNameById.get(agentId) ?? agentId),
    ),
    [runsData, agentNameById],
  );

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: 'Runs',
        showSearch: true,
      },
    }),
    [],
  );

  const columns: ColumnDef<RunRow>[] = useMemo(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        size: 200,
        minSize: 150,
        cell: ({ row }) => (
          <button
            type="button"
            className="eval-runs-panel__name-link"
            onClick={() => setRunDialogRunId(row.original.runId)}
            title={row.original.name}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        size: 110,
        minSize: 90,
        cell: ({ row }) => <EvalStatusCell status={row.original.status} />,
      },
      /* Baseline disabled for this phase - re-enable when needed
      {
        accessorKey: 'baselineStatus',
        header: 'Baseline status',
        size: 140,
        minSize: 120,
        cell: ({ row }) => {
          const label = BASELINE_LABEL[row.original.baselineStatus];
          return (
            <span className="eval-runs-panel__baseline-cell">
              {row.original.baselineStatus !== 'not_set' && (
                <IconInfoCircle size={14} color="var(--text-button-primary)" />
              )}
              <Typography Component="span" fontSize="fs14" boldness="regular">
                {label}
              </Typography>
            </span>
          );
        },
      },
      */
      {
        accessorKey: 'meanJudgeScore',
        header: 'Mean AI judge score',
        size: 120,
        minSize: 100,
        cell: ({ row }) => (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color={row.original.meanJudgeScore === '—' ? 'var(--text-secondary)' : undefined}
          >
            {row.original.meanJudgeScore}
          </Typography>
        ),
      },
      {
        accessorKey: 'agentName',
        header: 'Associated agent',
        size: 140,
        minSize: 100,
        cell: ({ row }) => (
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)" isEllipsis>
            {row.original.agentName}
          </Typography>
        ),
      },
      {
        accessorKey: 'strategy',
        header: 'Strategy',
        size: 130,
        minSize: 100,
        cell: ({ row }) => (
          <Typography Component="span" fontSize="fs14" boldness="regular" isEllipsis>
            {row.original.strategy}
          </Typography>
        ),
      },
      {
        accessorKey: 'judgeModel',
        header: 'AI judge model',
        size: 110,
        minSize: 90,
        cell: ({ row }) => (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color={row.original.judgeModel === '—' ? 'var(--text-secondary)' : undefined}
            isEllipsis
          >
            {row.original.judgeModel}
          </Typography>
        ),
      },
      {
        accessorKey: 'judgeDimensions',
        header: 'AI judge dimensions',
        size: 180,
        minSize: 130,
        cell: ({ row }) => (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color="var(--text-secondary)"
            isEllipsis
          >
            {row.original.judgeDimensions}
          </Typography>
        ),
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        size: 140,
        minSize: 110,
        cell: ({ row }) => (
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" isEllipsis>
            {row.original.createdAt}
          </Typography>
        ),
      },
      // Results column: View button (completed runs only) + three-dot menu
      {
        id: 'results',
        header: 'Results',
        size: 150,
        minSize: 140,
        enableResizing: false,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="eval-runs-panel__results-cell">
            {(row.original.status === 'success' || row.original.status === 'completed') && (
              <Button
                className="eval-runs-panel__view-btn"
                variant="outline"
                size="small"
                label="View"
                onClick={() => setRunDialogRunId(row.original.runId)}
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="icon"
                    size="small"
                    icon={<IconDotsVertical size={16} />}
                    aria-label={`Actions for ${row.original.name}`}
                  />
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={async () => {
                    if (!projectId) return;

                    try {
                      await triggerRun({ projectId, templateId, options: {} }).unwrap();
                      toast.success('Run queued successfully.');
                    } catch {
                      toast.error('Failed to start run.');
                    }
                  }}
                >
                  Run again
                </DropdownMenuItem>
                {/* Baseline disabled for this phase - re-enable when needed
                {row.original.baselineStatus === 'current_baseline' ? (
                  <DropdownMenuItem
                    onClick={() => toast.success('Clear baseline — coming soon.')}
                  >
                    Clear baseline
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={async () => {
                      try {
                        await setBaseline(row.original.runId).unwrap();
                        toast.success('Baseline updated successfully.');
                      } catch {
                        toast.error('Failed to set baseline.');
                      }
                    }}
                  >
                    Set as baseline
                  </DropdownMenuItem>
                )}
                */}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [setRunDialogRunId, projectId, triggerRun, templateId],
  );

  return (
    <div className="eval-runs-panel">
      <BaseTable<RunRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
      />

      {runDialogRun && (
        <EvalRunDetailsDialog
          open={!!runDialogRunId}
          onOpenChange={() => setRunDialogRunId(null)}
          run={runDialogRun}
        />
      )}
    </div>
  );
}

export { EvalRunsPanel };

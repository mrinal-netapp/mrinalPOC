import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent, type ReactElement } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { IconCopy } from '@tabler/icons-react';

import { useGetProjectQuery } from '@/api/project-api.slice';
import { parseProjectStorageRoot } from '@/api/project-storage';
import { getObjectText } from '@/api/s3-upload';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { useListRunsQuery } from '@/routes/pages/evaluations/api/eval-api.slice';
import { parseCasesFile } from '@/routes/pages/evaluations/api/cases-file';
import {
  buildEvalRunStorageKeys,
  EMPTY_VALUE,
  joinCasesWithArtifacts,
  parseEvaluationResultsFile,
  type JoinedEvalTestCase,
} from '@/routes/pages/evaluations/api/eval-test-case-rows';
import { slugifyEvalName } from '@/routes/pages/evaluations/api/eval-mappers';
import type { EvaluationRun } from '@/routes/pages/evaluations/api/eval.types';
import { BaseTable } from '@/ui-lib/base-components/baseTableMcpBxp';
import type { BaseElement, BaseTableOptions } from '@/ui-lib/base-components/baseTableMcpBxp';
import { Button } from '@/ui-lib/base-components/button/button';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/ui-lib/base-components/dialog/dialog';
import { Spinner } from '@/ui-lib/base-components/spinner/spinner';
import { toast } from '@/ui-lib/base-components/toast/toast';
import { Typography } from '@/ui-lib/base-components/typography/typography';

import './eval-test-cases-panel.scss';

type EvalTestCasesPanelProps = {
  templateId: string;
  evalName: string;
};

type TestCaseRow = BaseElement & JoinedEvalTestCase;

type RunArtifactsState = {
  rows: JoinedEvalTestCase[];
  casesMissing: boolean;
  resultsMissing: boolean;
};

const EMPTY_ARTIFACTS: RunArtifactsState = {
  rows: [],
  casesMissing: false,
  resultsMissing: false,
};

function runDisplayName(run: EvaluationRun): string {
  return run.name || run.runId;
}

function strategyDisplay(run: EvaluationRun | undefined): string {
  const strategy = run?.templateSnapshot?.evaluators?.strategy;
  if (strategy === 'both') return 'Deterministic with AI judge';
  if (strategy === 'deterministic') return 'Deterministic';
  if (strategy === 'llm_judge') return 'AI judge only';
  return strategy || EMPTY_VALUE;
}

function listDisplay(items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return EMPTY_VALUE;
  }
  return items.slice(0, 4).join(', ') + (items.length > 4 ? `, +${items.length - 4}` : '');
}

function TextCell({
  value,
  preview = false,
  copyLabel,
}: {
  value: string;
  preview?: boolean;
  copyLabel?: string;
}): ReactElement {
  const showCopy = preview && value !== EMPTY_VALUE && copyLabel;

  const handleCopy = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard is not available in this browser.');
      return;
    }
    void navigator.clipboard.writeText(value)
      .then(() => {
        toast.success('Copied to clipboard');
      })
      .catch(() => {
        toast.error('Could not copy to clipboard.');
      });
  };

  const text = (
    <Typography
      Component="span"
      fontSize="fs14"
      boldness="regular"
      color={value === EMPTY_VALUE ? 'var(--text-secondary)' : undefined}
      className={preview && value !== EMPTY_VALUE ? 'eval-test-cases-panel__text-preview' : undefined}
      isEllipsis
      title={value}
      data-preview={value}
    >
      {value}
    </Typography>
  );

  if (!showCopy) {
    return text;
  }

  return (
    <div className="eval-test-cases-panel__copyable-cell">
      {text}
      <Button
        type="button"
        variant="icon"
        size="small"
        icon={<IconCopy size={16} />}
        className="eval-test-cases-panel__copy-btn"
        aria-label={`Copy ${copyLabel}`}
        onClick={handleCopy}
      />
    </div>
  );
}

function ResultDetailsDialog({
  row,
  onOpenChange,
}: {
  row: TestCaseRow | null;
  onOpenChange: (open: boolean) => void;
}): ReactElement | null {
  if (!row) {
    return null;
  }

  const fields = [
    ['Query', row.query],
    ['Expected', row.expected],
    ['Actual', row.actual],
    ['Status', row.resultStatus],
    ['Mean AI judge score', row.meanJudgeScore],
    ['Helpfulness', row.helpfulness],
    ['Correctness', row.correctness],
    ['Average latency', row.averageLatency],
    ['Total tokens', row.totalTokens],
  ];

  return (
    <Dialog open onOpenChange={onOpenChange} size="lg">
      <DialogPopup className="eval-test-cases-panel__dialog">
        <DialogHeader>
          <DialogTitle>{row.caseId}</DialogTitle>
        </DialogHeader>

        <div className="eval-test-cases-panel__dialog-body">
          {fields.map(([label, value]) => (
            <div key={label} className="eval-test-cases-panel__dialog-row">
              <Typography Component="dt" fontSize="fs14" boldness="semibold">
                {label}
              </Typography>
              <Typography Component="dd" fontSize="fs14" boldness="regular">
                {value}
              </Typography>
            </div>
          ))}

          <div className="eval-test-cases-panel__dialog-row">
            <Typography Component="dt" fontSize="fs14" boldness="semibold">
              Source result record
            </Typography>
            <pre className="eval-test-cases-panel__dialog-json">
              {JSON.stringify(row.artifact ?? null, null, 2)}
            </pre>
          </div>
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

function EvalTestCasesPanel({ templateId, evalName }: EvalTestCasesPanelProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [resultDialogRow, setResultDialogRow] = useState<TestCaseRow | null>(null);
  const [artifactsState, setArtifactsState] = useState<RunArtifactsState>(EMPTY_ARTIFACTS);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [artifactsError, setArtifactsError] = useState(false);

  const { data: project } = useGetProjectQuery(projectId, { skip: !projectId });
  const storageRoot = useMemo(
    () => parseProjectStorageRoot(project?.home_dir),
    [project?.home_dir],
  );

  const { data: runsData, isLoading: isLoadingRuns, isError: isRunsError } = useListRunsQuery(
    { projectId, templateId },
    { skip: !projectId || !templateId },
  );
  const runs = useMemo(() => runsData?.data ?? [], [runsData]);
  const selectableRuns = useMemo(
    () => {
      const completed = runs.filter((run) => run.status !== 'running' && run.status !== 'queued');
      return completed.length > 0 ? completed : runs;
    },
    [runs],
  );
  const effectiveSelectedRunId = selectableRuns.some((run) => run.runId === selectedRunId)
    ? selectedRunId
    : selectableRuns[0]?.runId ?? '';
  const selectedRun = useMemo(
    () => selectableRuns.find((run) => run.runId === effectiveSelectedRunId),
    [selectableRuns, effectiveSelectedRunId],
  );
  const evalId = useMemo(
    () => slugifyEvalName(selectedRun?.templateSnapshot?.evalName ?? evalName),
    [selectedRun?.templateSnapshot?.evalName, evalName],
  );

  useEffect(() => {
    if (!storageRoot || !effectiveSelectedRunId) {
      setArtifactsState(EMPTY_ARTIFACTS);
      setArtifactsError(false);
      setIsLoadingArtifacts(false);
      return undefined;
    }

    const controller = new AbortController();
    const { casesKey, resultsKey } = buildEvalRunStorageKeys(
      storageRoot.pathPrefix,
      evalId,
      effectiveSelectedRunId,
    );

    setIsLoadingArtifacts(true);
    setArtifactsError(false);

    void (async () => {
      try {
        const [casesText, resultsText] = await Promise.all([
          getObjectText(storageRoot.bucketName, casesKey, controller.signal),
          getObjectText(storageRoot.bucketName, resultsKey, controller.signal),
        ]);

        if (controller.signal.aborted) {
          return;
        }

        const casesMissing = casesText === null;
        const resultsMissing = resultsText === null;
        const cases = casesText ? parseCasesFile(casesText) : [];
        const artifacts = resultsText ? parseEvaluationResultsFile(resultsText).perCaseArtifacts : [];

        setArtifactsState({
          rows: joinCasesWithArtifacts(cases, artifacts),
          casesMissing,
          resultsMissing,
        });
      } catch {
        if (!controller.signal.aborted) {
          setArtifactsState(EMPTY_ARTIFACTS);
          setArtifactsError(true);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingArtifacts(false);
        }
      }
    })();

    return () => controller.abort();
  }, [storageRoot, evalId, effectiveSelectedRunId]);

  const tableData = useMemo<TestCaseRow[]>(
    () => artifactsState.rows.map((row) => ({
      ...row,
      id: row.caseId,
    })),
    [artifactsState.rows],
  );

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: 'Test cases',
        showSearch: true,
      },
    }),
    [],
  );

  const columns: ColumnDef<TestCaseRow>[] = useMemo(
    () => [
      {
        accessorKey: 'caseId',
        header: 'ID',
        size: 120,
        minSize: 90,
        cell: ({ row }) => (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            className="eval-test-cases-panel__case-id"
            title={row.original.caseId}
          >
            {row.original.caseId}
          </Typography>
        ),
      },
      {
        accessorKey: 'query',
        header: 'Query',
        size: 360,
        minSize: 220,
        cell: ({ row }) => <TextCell value={row.original.query} preview copyLabel="Query" />,
      },
      {
        accessorKey: 'expected',
        header: 'Expected',
        size: 360,
        minSize: 220,
        cell: ({ row }) => <TextCell value={row.original.expected} preview copyLabel="Expected" />,
      },
      {
        accessorKey: 'actual',
        header: 'Actual',
        size: 360,
        minSize: 220,
        cell: ({ row }) => <TextCell value={row.original.actual} preview copyLabel="Actual" />,
      },
      {
        accessorKey: 'meanJudgeScore',
        header: 'Mean AI judge score',
        size: 160,
        minSize: 130,
        cell: ({ row }) => <TextCell value={row.original.meanJudgeScore} />,
      },
      {
        accessorKey: 'helpfulness',
        header: 'Helpfulness',
        size: 130,
        minSize: 110,
        cell: ({ row }) => <TextCell value={row.original.helpfulness} />,
      },
      {
        accessorKey: 'correctness',
        header: 'Correctness',
        size: 130,
        minSize: 110,
        cell: ({ row }) => <TextCell value={row.original.correctness} />,
      },
      {
        accessorKey: 'faithfulnessGroundedness',
        header: 'Faithfulness and groundedness',
        size: 220,
        minSize: 170,
        cell: ({ row }) => <TextCell value={row.original.faithfulnessGroundedness} />,
      },
      {
        accessorKey: 'groundedness',
        header: 'Groundedness',
        size: 140,
        minSize: 110,
        cell: ({ row }) => <TextCell value={row.original.groundedness} />,
      },
      {
        accessorKey: 'retrievalPrecision',
        header: 'Retrieval precision',
        size: 160,
        minSize: 130,
        cell: ({ row }) => <TextCell value={row.original.retrievalPrecision} />,
      },
      {
        accessorKey: 'retrievalRecall',
        header: 'Retrieval recall',
        size: 150,
        minSize: 120,
        cell: ({ row }) => <TextCell value={row.original.retrievalRecall} />,
      },
      {
        accessorKey: 'exactMatch',
        header: 'Exact match',
        size: 130,
        minSize: 100,
        cell: ({ row }) => <TextCell value={row.original.exactMatch} />,
      },
      {
        accessorKey: 'bleu',
        header: 'BLEU',
        size: 100,
        minSize: 80,
        cell: ({ row }) => <TextCell value={row.original.bleu} />,
      },
      {
        accessorKey: 'rougeL',
        header: 'ROUGE-L',
        size: 110,
        minSize: 90,
        cell: ({ row }) => <TextCell value={row.original.rougeL} />,
      },
      {
        accessorKey: 'tokenF1',
        header: 'Token F1',
        size: 110,
        minSize: 90,
        cell: ({ row }) => <TextCell value={row.original.tokenF1} />,
      },
      {
        accessorKey: 'averageLatency',
        header: 'Average latency',
        size: 150,
        minSize: 120,
        cell: ({ row }) => <TextCell value={row.original.averageLatency} />,
      },
      {
        accessorKey: 'p95Latency',
        header: 'P95 latency',
        size: 130,
        minSize: 100,
        cell: ({ row }) => <TextCell value={row.original.p95Latency} />,
      },
      {
        accessorKey: 'p99Latency',
        header: 'P99 latency',
        size: 130,
        minSize: 100,
        cell: ({ row }) => <TextCell value={row.original.p99Latency} />,
      },
      {
        accessorKey: 'averageTokens',
        header: 'Average tokens',
        size: 150,
        minSize: 120,
        cell: ({ row }) => <TextCell value={row.original.averageTokens} />,
      },
      {
        accessorKey: 'maximumTokens',
        header: 'Maximum tokens',
        size: 150,
        minSize: 120,
        cell: ({ row }) => <TextCell value={row.original.maximumTokens} />,
      },
      {
        accessorKey: 'totalTokens',
        header: 'Total tokens',
        size: 140,
        minSize: 110,
        cell: ({ row }) => <TextCell value={row.original.totalTokens} />,
      },
      {
        accessorKey: 'totalCost',
        header: 'Total cost',
        size: 120,
        minSize: 100,
        cell: ({ row }) => <TextCell value={row.original.totalCost} />,
      },
      {
        accessorKey: 'resultStatus',
        header: 'Results',
        size: 120,
        minSize: 100,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="outline"
            size="small"
            label="View"
            isDisabled={!row.original.hasResult}
            onClick={() => setResultDialogRow(row.original)}
          />
        ),
      },
    ],
    [],
  );

  if (isLoadingRuns || isLoadingArtifacts) {
    return (
      <div className="eval-test-cases-panel eval-test-cases-panel__state">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isRunsError) {
    return (
      <div className="eval-test-cases-panel eval-test-cases-panel__state">
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          Failed to load evaluation runs.
        </Typography>
      </div>
    );
  }

  if (artifactsError) {
    return (
      <div className="eval-test-cases-panel eval-test-cases-panel__state">
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          Failed to load test cases for this run.
        </Typography>
      </div>
    );
  }

  if (selectableRuns.length === 0) {
    return (
      <div className="eval-test-cases-panel eval-test-cases-panel__state">
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          No evaluation runs available yet.
        </Typography>
      </div>
    );
  }

  if (tableData.length === 0) {
    return (
      <div className="eval-test-cases-panel eval-test-cases-panel__state">
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          {artifactsState.casesMissing && artifactsState.resultsMissing
            ? 'No test cases or results for this run.'
            : 'No test cases configured for this evaluation.'}
        </Typography>
      </div>
    );
  }

  return (
    <div className="eval-test-cases-panel">
      <section className="eval-test-cases-panel__run-card" aria-label="Completed evaluation run">
        <div className="eval-test-cases-panel__run-card-header">
          <Typography Component="h3" fontSize="fs16" boldness="semibold">
            Completed evaluation run
          </Typography>
        </div>

        <div className="eval-test-cases-panel__run-card-body">
          <label className="eval-test-cases-panel__run-select-label" htmlFor="eval-test-case-run">
            <Typography Component="span" fontSize="fs14" boldness="semibold">
              Evaluation run
            </Typography>
          </label>
          <select
            id="eval-test-case-run"
            className="eval-test-cases-panel__run-select"
            value={effectiveSelectedRunId}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedRunId(event.target.value)}
          >
            {selectableRuns.map((run) => (
              <option key={run.runId} value={run.runId}>
                {runDisplayName(run)}
              </option>
            ))}
          </select>

          <dl className="eval-test-cases-panel__run-details">
            <div>
              <dt>Evaluation strategy</dt>
              <dd>{strategyDisplay(selectedRun)}</dd>
            </div>
            <div>
              <dt>AI judge model</dt>
              <dd>{selectedRun?.templateSnapshot?.evaluators?.aiJudge?.models?.[0] ?? EMPTY_VALUE}</dd>
            </div>
            <div>
              <dt>AI judge dimensions</dt>
              <dd>{listDisplay(selectedRun?.templateSnapshot?.evaluators?.aiJudge?.dimensions)}</dd>
            </div>
            <div>
              <dt>Detailed deterministic dimensions</dt>
              <dd>{listDisplay(selectedRun?.templateSnapshot?.evaluators?.deterministic?.metrics)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <BaseTable<TestCaseRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
      />
      <ResultDetailsDialog row={resultDialogRow} onOpenChange={(open) => !open && setResultDialogRow(null)} />
    </div>
  );
}

export { EvalTestCasesPanel };

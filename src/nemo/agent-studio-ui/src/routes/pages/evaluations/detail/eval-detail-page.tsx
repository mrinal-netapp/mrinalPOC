import { useCallback, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { IconChevronDown } from '@tabler/icons-react';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { evalSelector } from '@/store/selectors/eval.selector';
import { useDeleteEvaluationMutation, useGetEvaluationQuery, useListRunsQuery } from '@/routes/pages/evaluations/api/eval-api.slice';
import { useListAgentsQuery } from '@/routes/pages/agents/api/agents-config-api.slice';
import { Button } from '@/ui-lib/base-components/button/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui-lib/base-components/dropdown-menu/dropdown-menu';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { SummaryDetailsTemplate } from '@/components/summary-details-template/summary-details-template';
import type { SummaryField, TabPanel } from '@/components/summary-details-template/summary-details-template.types';
import { Spinner } from '@/ui-lib/base-components/spinner/spinner';
import { ROUTES } from '@/routes/routes.consts';
import { ConfirmDialog } from '@/components/dialog/confirm-dialog/confirm-dialog';
import { toast } from '@/ui-lib/base-components/toast/toast';
import { evalPaths } from '../evaluations.consts';
import { EvalOverviewPanel } from './panels/eval-overview-panel';
import { EvalRunOverviewPanel } from './panels/eval-run-overview-panel';
import { EvalRunsPanel } from './panels/eval-runs-panel';
import { EvalTestCasesPanel } from './panels/eval-test-cases-panel';
import { EvalStatusCell } from '@/components/evaluations/columns/cells/eval-status-cell';

import './eval-detail-page.scss';

function EvalDetailPage(): ReactElement {
  const navigate = useNavigate();
  const { templateId } = useParams<{ templateId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteEvaluation, { isLoading: isDeleting }] = useDeleteEvaluationMutation();

  // Fetch the full template for the panels (overview config + scoring details).
  const {
    data: template,
    isLoading,
    isError,
  } = useGetEvaluationQuery(
    { projectId, templateId: templateId ?? '' },
    { skip: !projectId || !templateId },
  );

  // Read supplementary list-item fields (agentName, latestRunStatus, strategyLabel,
  // runCount) from the list-query cache so we avoid a second round-trip.
  // Cache key is projectId plus optional filters — matches how EvalListContent calls the hook.
  // Read supplementary list-item fields from the list-query cache (populated when
  // the evaluations list page was visited) as a fast path — no second request.
  const listCache = useAppSelector(evalSelector.getEvalListSelector(projectId));
  const listItem = listCache.data?.data.find((item) => item.templateId === templateId);

  // Also load runs so the tab label shows the accurate count even when navigating
  // directly to the detail URL (bypassing the list page and its cache population).
  const { data: runsData } = useListRunsQuery(
    { projectId, templateId: templateId ?? '' },
    { skip: !projectId || !templateId },
  );

  // Agent records hold the human-readable name; the template only persists the id.
  const { data: agents = [] } = useListAgentsQuery(
    { projectId },
    { skip: !projectId },
  );

  const handleDelete = useCallback(async () => {
    if (!projectId || !templateId || !template) return;

    try {
      await deleteEvaluation({ projectId, templateId }).unwrap();
      toast.success(`"${template.evalName}" deleted successfully.`);
      navigate(`/${ROUTES.EVALUATIONS}`);
    } catch {
      toast.error(`Failed to delete "${template.evalName}".`);
    } finally {
      setIsDeleteDialogOpen(false);
    }
  }, [deleteEvaluation, navigate, projectId, template, templateId]);

  // ── Guards ──────────────────────────────────────────────────────────────────

  if (!templateId || isLoading) {
    return (
      <div className="eval-detail eval-detail__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="eval-detail">
        <Typography Component="h1" fontSize="fs20" boldness="semibold">
          Evaluation not found.
        </Typography>
        <Button
          variant="flat"
          size="medium"
          label="Back to Evaluations"
          onClick={() => navigate(evalPaths.root)}
        />
      </div>
    );
  }

  // ── Derived display values ────────────────────────────────────────────────

  // Show the human-readable agent name, resolved from the agents list by id.
  // Falls back to the id when the agent isn't in the list (loading/deleted).
  const agentId = template.agent?.agentId ?? '—';
  const agentDisplay = agents.find((a) => a.id === agentId)?.name ?? agentId;

  // Latest run status: prefer live runs data over the list cache so direct-URL
  // navigation always shows the correct status.
  const latestRunFromQuery = runsData?.data?.[0];
  const latestRunStatus =
    latestRunFromQuery?.status ?? listItem?.latestRunStatus ?? undefined;

  // Human-readable strategy label.
  const STRATEGY_DISPLAY: Record<string, string> = {
    both: 'Deterministic with AI judge',
    deterministic: 'Deterministic',
    llm_judge: 'AI judge only',
  };
  const rawStrategy = template.evaluators?.strategy ?? '';
  const strategyLabel = STRATEGY_DISPLAY[rawStrategy] ?? (rawStrategy || '—');

  // Prefer live run count from the runs query; fall back to list cache value.
  const runCount = runsData?.data?.length ?? listItem?.runCount ?? 0;

  const summaryFields: SummaryField[] = [
    { label: 'Name', value: template.evalName },
    {
      label: 'Latest run status',
      value: <EvalStatusCell status={latestRunStatus} />,
    },
    { label: 'Evaluation strategy', value: strategyLabel },
    {
      label: 'Associated agent',
      value: (
        <Typography fontSize="fs14" boldness="semibold" color="var(--text-button-primary)">
          {agentDisplay}
        </Typography>
      ),
    },
  ];

  const tabPanels: TabPanel[] = [
    {
      tab: { id: 'overview', label: 'Overview' },
      content: (
        <EvalOverviewPanel
          template={template}
          agentName={agentDisplay}
        />
      ),
    },
    {
      tab: { id: 'run-overview', label: 'Run overview' },
      content: <EvalRunOverviewPanel templateId={template.templateId} />,
    },
    {
      tab: { id: 'runs', label: `Runs (${runCount})` },
      content: <EvalRunsPanel templateId={template.templateId} />,
    },
    {
      tab: { id: 'test-cases', label: 'Evaluation test cases' },
      content: <EvalTestCasesPanel templateId={template.templateId} evalName={template.evalName} />,
    },
  ];

  return (
    <div className="eval-detail">
      <SummaryDetailsTemplate
        title="Evaluation details"
        breadcrumbs={[
          { label: 'Evaluations', href: `/${ROUTES.EVALUATIONS}` },
          { label: template.evalName, href: `/${ROUTES.EVALUATIONS}/${template.templateId}` },
        ]}
        actions={(
          <>
            <Button
              variant="outline"
              size="large"
              label="Edit"
              onClick={() => navigate(evalPaths.edit(template.templateId))}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="solid"
                    size="large"
                    label="Actions"
                    icon={<IconChevronDown size={16} />}
                  />
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onClick={() => setIsDeleteDialogOpen(true)}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        summaryFields={summaryFields}
        tabPanels={tabPanels}
      />

      <ConfirmDialog
        open={isDeleteDialogOpen}
        title="Delete evaluation"
        description={<>Are you sure you want to delete &quot;{template.evalName}&quot;? This action cannot be undone.</>}
        variant="danger"
        confirmLabel="Delete"
        loading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setIsDeleteDialogOpen(false)}
      />
    </div>
  );
}

export { EvalDetailPage };

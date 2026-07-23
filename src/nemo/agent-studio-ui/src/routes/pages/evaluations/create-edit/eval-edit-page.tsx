import { type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { useGetEvaluationQuery } from '@/routes/pages/evaluations/api/eval-api.slice';
import { Button } from '@/ui-lib/base-components/button/button';
import { Spinner } from '@/ui-lib/base-components/spinner/spinner';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { evalPaths } from '../evaluations.consts';
import { EvalForm } from './form/eval-form';

/**
 * Edit page for an evaluation template.
 *
 * Mirrors the dataset-edit-page.tsx thin-loader pattern:
 *   1. Read :templateId from URL params.
 *   2. Fetch via useGetEvaluationQuery (RTK Query against the real eval API).
 *   3. Guard: loading spinner, not-found on error, redirect guard.
 *   4. Render the shared EvalForm in edit mode pre-filled from the query data.
 *
 * key={templateId} ensures form state resets when navigating between evals.
 */
function EvalEditPage(): ReactElement {
  const navigate = useNavigate();
  const { templateId } = useParams<{ templateId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const {
    data: template,
    isLoading,
    isError,
  } = useGetEvaluationQuery(
    { projectId, templateId: templateId ?? '' },
    { skip: !projectId || !templateId },
  );

  if (!templateId || isLoading) {
    return (
      <div className="eval-edit-page__center">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="eval-edit-page__not-found">
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

  return (
    <EvalForm
      key={templateId}
      isEdit
      initialData={template}
    />
  );
}

export { EvalEditPage };

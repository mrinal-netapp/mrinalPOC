import type { ReactElement } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { useGetEvaluationQuery } from '@/routes/pages/evaluations/api/eval-api.slice';
import { Spinner } from '@/ui-lib/base-components/spinner/spinner';
import { Button } from '@/ui-lib/base-components/button/button';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { evalPaths } from '@/routes/pages/evaluations/evaluations.consts';
import { EvalForm } from './form/eval-form';

function EvalCreatePage(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const cloneFromId = searchParams.get('cloneFrom');
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const { data: cloneSource, isLoading, isError } = useGetEvaluationQuery(
    { projectId, templateId: cloneFromId ?? '' },
    { skip: !cloneFromId || !projectId },
  );

  if (cloneFromId && isLoading) {
    return <Spinner size="fitContent" />;
  }

  if (cloneFromId && (isError || !cloneSource)) {
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

  // Key by full location (pathname + search) so navigating from one
  // cloneFrom value to another unmounts and remounts EvalForm, preventing
  // stale prefill state from bleeding between clones.
  return <EvalForm key={location.pathname + location.search} cloneSource={cloneSource} />;
}

export { EvalCreatePage };

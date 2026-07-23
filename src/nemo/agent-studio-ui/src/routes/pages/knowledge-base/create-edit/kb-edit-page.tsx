import { useMemo, type ReactElement } from 'react';
import { useParams, Navigate } from 'react-router';

import { useGetKnowledgeBaseQuery, useGetKBAssignedDatasetQuery } from '@/api/kb-api.slice';
import { Spinner } from '@/ui-lib/base-components/spinner/spinner';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';

import { KBForm } from './form/kb-form';
import { kbPaths } from '../knowledge-base.consts';

import '../../data-management/dataset/create-edit/form/dataset-form.scss';

function KBEditPage(): ReactElement {
  const { kbId } = useParams<{ kbId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetKnowledgeBaseQuery(
    { projectId, kbId: kbId ?? '' },
    { skip: !kbId || !projectId },
  );
  const { data: assignedDatasetResponse } = useGetKBAssignedDatasetQuery(
    { projectId, kbId: kbId ?? '' },
    { skip: !kbId || !projectId || !data },
  );

  const enrichedData = useMemo(() => {
    if (!data) return undefined;
    if (!assignedDatasetResponse?.dataset?.name) return data;
    return {
      ...data,
      assigned_dataset: {
        ...data.assigned_dataset,
        ...assignedDatasetResponse.dataset,
      },
    };
  }, [data, assignedDatasetResponse]);

  if (!kbId) {
    return <Navigate to={kbPaths.root} replace />;
  }

  if (isLoading) {
    return (
      <div className="dset-form-page__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !enrichedData) {
    return (
      <div className="dset-form-page__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load knowledge base.
        </Typography>
      </div>
    );
  }

  return <KBForm key={kbId} isEdit initialData={enrichedData} />;
}

export { KBEditPage };

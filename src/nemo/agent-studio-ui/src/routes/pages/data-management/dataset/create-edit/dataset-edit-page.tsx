import type { ReactElement } from "react";
import { useParams, Navigate } from "react-router";

import { useGetDatasetQuery } from "@/api/dataset-api.slice";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { DatasetForm } from "./form/dataset-form";
import { dataManagementPaths } from "../../data-management.consts";

function DatasetEditPage(): ReactElement {
  const { dsetId } = useParams<{ dsetId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetDatasetQuery(
    { projectId, dsetId: dsetId ?? "" },
    { skip: !dsetId || !projectId },
  );

  if (!dsetId) {
    return <Navigate to={dataManagementPaths.datasets} replace />;
  }

  if (isLoading) {
    return (
      <div className="dset-form-page__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="dset-form-page__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load dataset.
        </Typography>
      </div>
    );
  }

  return <DatasetForm key={dsetId} isEdit initialData={data} />;
}

export { DatasetEditPage };

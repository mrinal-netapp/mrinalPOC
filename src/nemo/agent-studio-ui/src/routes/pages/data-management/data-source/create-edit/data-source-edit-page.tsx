import type { ReactElement } from "react";
import { useParams, Navigate } from "react-router";

import { useGetDataSourceQuery } from "@/api/data-source-api.slice";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { DataSourceForm } from "./form/data-source-form";
import { dataManagementPaths } from "../../data-management.consts";
import "./form/data-source-form.scss";

function DataSourceEditPage(): ReactElement {
  const { dsrcId } = useParams<{ dsrcId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetDataSourceQuery(
    { projectId, dsrcId: dsrcId ?? "" },
    { skip: !dsrcId || !projectId },
  );

  if (!dsrcId) {
    return <Navigate to={dataManagementPaths.dataSources} replace />;
  }

  if (isLoading) {
    return (
      <div className="ds-form-page__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="ds-form-page__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load data source.
        </Typography>
      </div>
    );
  }

  return <DataSourceForm key={dsrcId} isEdit initialData={data} />;
}

export { DataSourceEditPage };

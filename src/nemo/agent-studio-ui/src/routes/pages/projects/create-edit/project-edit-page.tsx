import type { ReactElement } from "react";
import { Navigate, useParams } from "react-router";

import { useGetProjectQuery } from "@/api/project-api.slice";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { projectsPaths } from "../projects.consts";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import { ProjectForm } from "./project-form";
import "./project-form.scss";

function ProjectEditPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading, isError } = useGetProjectQuery(projectId ?? "", { skip: !projectId });

  if (!projectId) {
    return <Navigate to={projectsPaths.root} replace />;
  }

  if (isLoading) {
    return (
      <div className="project-form-page__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="project-form-page__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          {PROJECT_FORM_STRINGS.LOAD_ERROR}
        </Typography>
      </div>
    );
  }

  return <ProjectForm key={projectId} isEdit initialData={data} />;
}

export { ProjectEditPage };

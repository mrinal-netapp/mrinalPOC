import type { ReactElement } from "react";

import { useGetProjectQuery } from "@/api/project-api.slice";
import { getProjectDescription } from "@/api/project.types";
import { ProjectIcon } from "@/components/projects/project-icon/project-icon";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ManageProjectsLink } from "./manage-projects-link";
import "./administration-overview.scss";

function AdministrationOverview(): ReactElement {
  const activeProjectId = useAppSelector(projectContextSelector.activeProjectId);
  const activeProjectName = useAppSelector(projectContextSelector.activeProjectName);
  const displayName = useAppSelector(projectContextSelector.displayName);

  const { data: project } = useGetProjectQuery(activeProjectId, {
    skip: !activeProjectId,
  });

  const projectName = project?.name ?? activeProjectName ?? displayName ?? "—";
  const projectDescription = project ? getProjectDescription(project.metadata) : "";
  const descriptionDisplay = projectDescription || "—";

  return (
    <Card className="administration-overview-card">
      <CardContent>
        <div className="administration-overview-card__body">
          <div className="administration-overview-card__name-column">
            <ProjectIcon size="md" />
            <Typography fontSize="fs14" boldness="semibold">
              {projectName}
            </Typography>
          </div>

          <Typography fontSize="fs14" className="administration-overview-card__description">
            {descriptionDisplay}
          </Typography>

          <ManageProjectsLink />
        </div>
      </CardContent>
    </Card>
  );
}

export { AdministrationOverview };

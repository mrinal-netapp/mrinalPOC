import type { ReactElement } from "react";

import { Button } from "@/ui-lib/base-components/button/button";
import { PROJECTS_LIST_STRINGS } from "../projects.consts";
import "./projects-empty-state.scss";

interface ProjectsEmptyStateProps {
  onCreateProject?: () => void;
}

function ProjectsEmptyState({ onCreateProject }: ProjectsEmptyStateProps): ReactElement {
  return (
    <div className="projects-empty-state">
      <p className="projects-empty-state__welcome">{PROJECTS_LIST_STRINGS.EMPTY_STATE_WELCOME}</p>
      <div className="projects-empty-state__card">
        <h2 className="projects-empty-state__title">{PROJECTS_LIST_STRINGS.EMPTY_STATE_TITLE}</h2>
        <p className="projects-empty-state__description">
          {PROJECTS_LIST_STRINGS.EMPTY_STATE_DESCRIPTION}
        </p>
        <Button
          variant="solid"
          size="medium"
          label={PROJECTS_LIST_STRINGS.EMPTY_STATE_CTA_LABEL}
          onClick={onCreateProject}
          isDisabled={!onCreateProject}
        />
      </div>
    </div>
  );
}

export { ProjectsEmptyState };

import type { ReactElement } from "react";

import { PROJECTS_LIST_STRINGS } from "../projects.consts";
import { ProjectsListContent } from "./projects-list-content";
import "./projects-list-page.scss";

function ProjectsListPage(): ReactElement {
  return (
    <div className="projects-list-page">
      <header className="projects-list-page__header">
        <h1 className="projects-list-page__title">{PROJECTS_LIST_STRINGS.PAGE_TITLE}</h1>
        <p className="projects-list-page__subtitle">{PROJECTS_LIST_STRINGS.PAGE_SUBTITLE}</p>
      </header>

      <div className="projects-list-page__content">
        <ProjectsListContent />
      </div>
    </div>
  );
}

export { ProjectsListPage };

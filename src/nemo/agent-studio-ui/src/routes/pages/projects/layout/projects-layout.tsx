import type { ReactElement } from "react";
import { Outlet } from "react-router";

import { useAppSelector } from "@/store";
import { layoutSelector } from "@/store/selectors/layout.selector";
import { ProjectsManagementSidebar } from "../components/projects-management-sidebar";
import "./projects-layout.scss";

function ProjectsLayout(): ReactElement {
  const isSidebarOpen = useAppSelector(layoutSelector.isSidebarOpen);

  return (
    <div className="projects-layout" data-testid="projects-layout">
      <ProjectsManagementSidebar open={isSidebarOpen} />
      <div className="projects-layout__content">
        <Outlet />
      </div>
    </div>
  );
}

export { ProjectsLayout };

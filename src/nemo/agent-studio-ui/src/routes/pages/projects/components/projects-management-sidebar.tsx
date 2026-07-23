import type { ReactElement } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/ui-lib/base-components/sidebar/sidebar";
import { ServiceContextTabs } from "@/components/service-context-tabs/service-context-tabs";
import { PROJECTS_MANAGEMENT_NAV_ITEMS } from "../projects.consts";

interface ProjectsManagementSidebarProps {
  open: boolean;
}

function isNavItemActive(path: string, pathname: string): boolean {
  const to = path.startsWith("/") ? path : `/${path}`;
  return pathname === to || pathname.startsWith(`${to}/`);
}

function ProjectsManagementSidebar({ open }: ProjectsManagementSidebarProps): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <Sidebar open={open} data-testid="projects-management-sidebar">
      <ServiceContextTabs />

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {PROJECTS_MANAGEMENT_NAV_ITEMS.map((item) => (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton
                  icon={item.icon}
                  label={item.label}
                  isActive={isNavItemActive(item.path, location.pathname)}
                  onButtonClick={() => navigate(item.path)}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

export { ProjectsManagementSidebar };

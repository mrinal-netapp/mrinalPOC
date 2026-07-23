import { createElement, type ReactNode } from "react";
import { IconSitemap } from "@tabler/icons-react";

import { ROUTES } from "@/routes/routes.consts";

export interface ProjectsManagementNavItem {
  label: string;
  path: string;
  icon: ReactNode;
}

export const PROJECTS_MANAGEMENT_NAV_ITEMS: ProjectsManagementNavItem[] = [
  { label: "Projects", path: `/${ROUTES.PROJECTS}`, icon: createElement(IconSitemap) },
];

export const PROJECTS_LIST_STRINGS = {
  PAGE_TITLE: "Project management",
  PAGE_SUBTITLE:
    "Independent workspaces for agents, knowledge bases, and team collaboration.",
  SEARCH_ARIA_LABEL: "Search projects",
  ADD_PROJECT_LABEL: "Add project",
  EMPTY_STATE_TITLE: "Create first project to get started",
  EMPTY_STATE_DESCRIPTION:
    "A project is an independent workspace where you can build agents, manage knowledge bases, and collaborate with your team. Each project has its own resources and access controls.",
  EMPTY_STATE_WELCOME: "Welcome to NetApp Agent Studio!",
  EMPTY_STATE_CTA_LABEL: "Create project",
} as const;

export const projectsPaths = {
  root: `/${ROUTES.PROJECTS}`,
  create: `/${ROUTES.PROJECTS}/${ROUTES.CREATE}`,
  edit: (projectId: string): string =>
    `/${ROUTES.PROJECTS}/${projectId}/${ROUTES.EDIT}`,
} as const;

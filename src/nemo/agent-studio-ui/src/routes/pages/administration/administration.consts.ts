import { ROUTES } from "@/routes/routes.consts";

export const ADMINISTRATION_TABS = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
] as const;

export type AdministrationTabId = (typeof ADMINISTRATION_TABS)[number]["id"];

export const ADMINISTRATION_STRINGS = {
  PAGE_TITLE: "Project details",
  PAGE_SUBTITLE: "View project information and manage team members.",
  PROJECTS_SECTION_LABEL: "Projects",
  MANAGE_PROJECTS_LABEL: "Manage projects",
} as const;

export const administrationPaths = {
  root: `/${ROUTES.ADMINISTRATION}`,
} as const;

export const PROJECT_SWITCHER_STRINGS = {
  TRIGGER_LABEL: "Project",
  PANEL_TITLE: "Projects",
  MANAGE_PROJECTS_LABEL: "Manage projects",
  SEARCH_PLACEHOLDER: "Search",
  SEARCH_ARIA_LABEL: "Search projects",
  SWITCH_LABEL: "Switch",
  CANCEL_LABEL: "Cancel",
  NO_PROJECTS: "No projects available",
  NO_RESULTS: "No matching projects",
  SELECT_PROJECT_ARIA: "Select a project",
  OPEN_PANEL_ARIA: (projectName: string) =>
    projectName
      ? `Switch project. Current project: ${projectName}`
      : "Switch project",
  UNNAMED_PROJECT: "Unnamed project",
} as const;

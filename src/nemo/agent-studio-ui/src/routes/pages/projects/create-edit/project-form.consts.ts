export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;

export const PROJECT_FORM_STRINGS = {
  CREATE_TITLE: "Add a project",
  EDIT_TITLE: "Edit a project",
  CREATE_INTRO:
    "A project is an independent workspace where you can build agents, manage knowledge bases, and collaborate with your team. Each project has its own resources and access controls.",
  DETAILS_SECTION_TITLE: "Project details",
  ACCESS_SECTION_TITLE: "Access",
  NAME_LABEL: "Project name",
  NAME_PLACEHOLDER: "Name of your project",
  DESCRIPTION_LABEL: "Description",
  DESCRIPTION_PLACEHOLDER: "Describe your project",
  DESCRIPTION_TOOLTIP: "Optional description stored in project metadata.",
  ADD_LABEL: "Add",
  SAVE_LABEL: "Save",
  CANCEL_LABEL: "Cancel",
  CREATE_SUCCESS: (name: string) => `Project "${name}" created successfully.`,
  UPDATE_SUCCESS: (name: string) => `Project "${name}" updated successfully.`,
  CREATE_ERROR: "Failed to create project. Please try again.",
  UPDATE_ERROR: "Failed to update project. Please try again.",
  LOAD_ERROR: "Failed to load project.",
  NAME_REQUIRED: "Project name is required",
} as const;

export const PROJECT_DELETE_STRINGS = {
  DIALOG_TITLE: "Delete",
  CONFIRM_LABEL: "Delete",
  CANCEL_LABEL: "Cancel",
  CONFIRM_DESCRIPTION_PREFIX: "Are you sure that you want to delete the project",
  CONFIRM_DESCRIPTION_SUFFIX: "?",
  UNDO_WARNING: "You cannot undo this action.",
  SUCCESS: (name: string) => `Project "${name}" deleted successfully.`,
  ERROR: (name: string) => `Failed to delete "${name}".`,
} as const;

export type ProjectFormValues = {
  name: string;
  description: string;
};

export const PROJECT_FORM_DEFAULT_VALUES: ProjectFormValues = {
  name: "",
  description: "",
};

export type SaveAgentMode = "draft" | "deploy";

export type SaveAgentValues = {
  name: string;
  description: string;
  labels: string[];
};

export const DEFAULT_SAVE_AGENT_VALUES: SaveAgentValues = {
  name: "",
  description: "",
  labels: [],
};

export const SAVE_AGENT_DIALOG_STRINGS = {
  TITLE_DRAFT: "Save agent as draft",
  TITLE_DEPLOY: "Save agent and deploy",
  DESCRIPTION:
    "Define agent identification details as the name, description, and labels.",
  NAME_LABEL: "Name",
  NAME_PLACEHOLDER: "$agent-name-0",
  NAME_REQUIRED_ERROR: "Name is required.",
  DESCRIPTION_LABEL: "Description",
  DESCRIPTION_PLACEHOLDER: "$description",
  LABELS_LABEL: "Labels",
  LABELS_TOOLTIP: "Apply labels to organize and search for agents.",
  LABELS_PLACEHOLDER: "Type a label and press Enter",
  LABELS_CLEAR_ALL_ARIA: "Clear all labels",
  PRIMARY_ACTION_DRAFT: "Save as draft",
  PRIMARY_ACTION_DEPLOY: "Save and deploy",
  CANCEL_ACTION: "Cancel",
  TRIGGER_SAVE_AS_DRAFT: "Save as draft",
  TRIGGER_SAVE_AND_DEPLOY: "Save and deploy",
  UNRESOLVED_DRAFT_WARNING_INTRO:
    "This draft includes unconfigured resources. Configure or remove them before saving and deploying:",
} as const;

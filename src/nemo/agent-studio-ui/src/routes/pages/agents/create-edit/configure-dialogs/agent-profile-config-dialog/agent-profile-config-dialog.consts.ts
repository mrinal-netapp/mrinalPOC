export type AgentProfileDraft = {
  goal: string;
  instructions: string;
  description?: string;
};

export const DEFAULT_AGENT_PROFILE_DRAFT: AgentProfileDraft = {
  goal: "",
  instructions: "",
  description: "",
};

export const AGENT_PROFILE_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure agent profile",
  SECTION_TITLE: "Agent profile",
  SECTION_DESCRIPTION: "Define the agent's goal and instructions.",
  SECTION_DESCRIPTION_TEMPLATE: "Define the agent's name, description, and instructions.",
  GOAL_LABEL: "Goal",
  NAME_LABEL: "Name",
  DESCRIPTION_LABEL: "Description",
  DESCRIPTION_PLACEHOLDER: "Describe what this agent does.",
  DESCRIPTION_TOOLTIP: "A short summary shown on the agent detail page.",
  GOAL_TOOLTIP: "The agent's purpose and intended outcome.",
  NAME_TOOLTIP: "The agent's display name.",
  INSTRUCTIONS_LABEL: "Instructions",
  INSTRUCTIONS_TOOLTIP:
    "Behavioral guidance, constraints, tone, and task rules for the agent.",
  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const;

import { useCallback, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import { IconBox, IconAlertTriangle, IconDots } from "@tabler/icons-react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Card } from "@/ui-lib/base-components/card/card";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";

import {
  AgentProfileConfigDialog,
  DEFAULT_AGENT_PROFILE_DRAFT,
  type AgentProfileDraft,
} from "../configure-dialogs/agent-profile-config-dialog";

import {
  DESCRIPTION_MAX_LENGTH,
  GOAL_MAX_LENGTH,
  GOAL_PLACEHOLDER,
  NAME_MAX_LENGTH,
  NAME_PLACEHOLDER,
} from "./agent-form.consts";
import {
  agentFormFieldPath,
  getFormValueAtPath,
  isTemplateInstanceFieldPrefix,
} from "./agent-form-field-path";
import { MANAGER_AGENT_FIELD_PREFIX } from "./template-agent.utils";

interface ProfileSectionProps {
  form: AnyReactFormApi;
  validationErrors?: {
    goal?: string;
    name?: string;
    instructions?: string;
  };
  fieldPrefix?: string;
  showSectionHeader?: boolean;
}

const PROFILE_SECTION_STRINGS = {
  TITLE: "Profile",
  DESCRIPTION_GOAL: "Define the agent's goal and instructions.",
  DESCRIPTION_NAME: "Define the agent's name, description, and instructions.",
  DESCRIPTION_NAME_MANAGER: "Define the agent's name and instructions.",
  CARD_TITLE: "Agent profile",
  CONFIGURE_LABEL: "Configure",
  STATUS_LABEL: "Status",
  STATUS_NOT_CONFIGURED: "Not configured",
  GOAL_LABEL: "Goal",
  NAME_LABEL: "Name",
  DESCRIPTION_LABEL: "Description",
  INSTRUCTIONS_LABEL: "Instructions",
} as const;

function ProfileSection({
  form,
  validationErrors,
  fieldPrefix,
  showSectionHeader = true,
}: ProfileSectionProps): ReactElement {
  const isTemplateInstance = isTemplateInstanceFieldPrefix(fieldPrefix);
  const isTemplateManager = fieldPrefix === MANAGER_AGENT_FIELD_PREFIX;
  const showMemberDescription = isTemplateInstance && !isTemplateManager;
  const primaryFieldKey = isTemplateInstance ? "name" : "goal";
  const primaryFieldPath = agentFormFieldPath(fieldPrefix, primaryFieldKey);
  const instructionsField = agentFormFieldPath(fieldPrefix, "instructions");
  const descriptionField = agentFormFieldPath(fieldPrefix, "description");
  const primaryValue = useStore(form.store, (s) =>
    getFormValueAtPath<string>(s.values, primaryFieldPath) ?? "",
  );
  const instructions = useStore(
    form.store,
    (s) => getFormValueAtPath<string>(s.values, instructionsField) ?? "",
  );
  const description = useStore(
    form.store,
    (s) => getFormValueAtPath<string>(s.values, descriptionField) ?? "",
  );

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // Draft is local so cancelling the dialog never leaks half-typed values
  // back into the form. Re-seeded from current form values each open.
  const [draft, setDraft] = useState<AgentProfileDraft>(DEFAULT_AGENT_PROFILE_DRAFT);

  const isConfigured =
    primaryValue.trim().length > 0
    || instructions.trim().length > 0
    || (showMemberDescription && description.trim().length > 0);
  const primaryLabel = isTemplateInstance
    ? PROFILE_SECTION_STRINGS.NAME_LABEL
    : PROFILE_SECTION_STRINGS.GOAL_LABEL;
  const primaryError = isTemplateInstance
    ? validationErrors?.name
    : validationErrors?.goal;

  const handleOpen = useCallback(() => {
    setDraft({
      goal: primaryValue,
      instructions,
      ...(showMemberDescription ? { description } : {}),
    });
    setIsDialogOpen(true);
  }, [description, instructions, primaryValue, showMemberDescription]);

  const handleClose = useCallback(() => {
    setIsDialogOpen(false);
  }, []);

  const handleDraftChange = useCallback((next: Partial<AgentProfileDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const handleSave = useCallback(() => {
    form.setFieldValue(primaryFieldPath, draft.goal);
    form.setFieldValue(instructionsField, draft.instructions);
    if (showMemberDescription) {
      form.setFieldValue(descriptionField, draft.description ?? "");
    }
    setIsDialogOpen(false);
  }, [draft, descriptionField, form, instructionsField, primaryFieldPath, showMemberDescription]);

  const handleClear = useCallback(() => {
    form.setFieldValue(primaryFieldPath, "");
    form.setFieldValue(instructionsField, "");
    if (showMemberDescription) {
      form.setFieldValue(descriptionField, "");
    }
  }, [descriptionField, form, instructionsField, primaryFieldPath, showMemberDescription]);

  return (
    <section className="agent-form__section">
      {showSectionHeader && (
        <div className="agent-form__section-header agent-form__section-header--stacked">
          <Typography
            Component="h2"
            fontSize="fs16"
            boldness="semibold"
            className="agent-form__section-title"
          >
            {PROFILE_SECTION_STRINGS.TITLE}
          </Typography>
          <Typography
            Component="p"
            fontSize="fs14"
            color="var(--text-secondary)"
            className="agent-form__section-description"
          >
            {isTemplateInstance
              ? isTemplateManager
                ? PROFILE_SECTION_STRINGS.DESCRIPTION_NAME_MANAGER
                : PROFILE_SECTION_STRINGS.DESCRIPTION_NAME
              : PROFILE_SECTION_STRINGS.DESCRIPTION_GOAL}
          </Typography>
        </div>
      )}

      <div className="agent-form__section-body">
        <Card>
          <div className="agent-form__feature-card-header">
            <div className="agent-form__feature-card-title-row">
              <span
                className="agent-form__feature-card-icon"
                aria-hidden="true"
              >
                <IconBox size={16} />
              </span>
              <Typography fontSize="fs14" boldness="semibold">
                {PROFILE_SECTION_STRINGS.CARD_TITLE}
              </Typography>
            </div>
            <div className="agent-form__resource-card-actions">
              <button
                type="button"
                className="agent-form__resource-link-button"
                onClick={handleOpen}
              >
                {PROFILE_SECTION_STRINGS.CONFIGURE_LABEL}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="agent-form__resource-card-menu-trigger"
                  aria-label="Agent profile options"
                >
                  <IconDots size={18} aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  className="agent-form__resource-card-menu-content"
                >
                  <DropdownMenuItem
                    onClick={handleClear}
                    className="agent-form__resource-card-menu-item"
                    disabled={!isConfigured}
                  >
                    <Typography Component="span" fontSize="fs14">Clear profile</Typography>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="agent-form__feature-card-body">
            {isConfigured ? (
              <>
                <Typography
                  fontSize="fs14"
                  className="agent-form__resource-row-label"
                >
                  {primaryLabel}
                </Typography>
                <Typography fontSize="fs14">
                  {primaryValue.trim().length > 0 ? primaryValue : "—"}
                </Typography>

                {showMemberDescription && (
                  <>
                    <Typography
                      fontSize="fs14"
                      className="agent-form__resource-row-label"
                    >
                      {PROFILE_SECTION_STRINGS.DESCRIPTION_LABEL}
                    </Typography>
                    <Typography fontSize="fs14">
                      {description.trim().length > 0 ? description : "—"}
                    </Typography>
                  </>
                )}

                <Typography
                  fontSize="fs14"
                  className="agent-form__resource-row-label"
                >
                  {PROFILE_SECTION_STRINGS.INSTRUCTIONS_LABEL}
                </Typography>
                <Typography fontSize="fs14">
                  {instructions.trim().length > 0 ? instructions : "—"}
                </Typography>
              </>
            ) : (
              <>
                <Typography
                  fontSize="fs14"
                  className="agent-form__resource-row-label"
                >
                  {PROFILE_SECTION_STRINGS.STATUS_LABEL}
                </Typography>
                <span className="agent-form__profile-status-warning">
                  <IconAlertTriangle size={16} aria-hidden="true" />
                  <Typography fontSize="fs14">
                    {PROFILE_SECTION_STRINGS.STATUS_NOT_CONFIGURED}
                  </Typography>
                </span>
              </>
            )}
          </div>
        </Card>
        {primaryError && (
          <Typography
            Component="p"
            fontSize="fs13"
            color="var(--notification-error)"
            className="agent-form__inline-error"
          >
            {primaryError}
          </Typography>
        )}
        {validationErrors?.instructions && (
          <Typography
            Component="p"
            fontSize="fs13"
            color="var(--notification-error)"
            className="agent-form__inline-error"
          >
            {validationErrors.instructions}
          </Typography>
        )}
      </div>

      <AgentProfileConfigDialog
        open={isDialogOpen}
        draft={draft}
        primaryFieldLabel={primaryLabel}
        primaryFieldPlaceholder={
          isTemplateInstance ? NAME_PLACEHOLDER : GOAL_PLACEHOLDER
        }
        primaryFieldTooltip={
          isTemplateInstance
            ? "The agent's display name."
            : "The agent's purpose and intended outcome."
        }
        primaryFieldMaxLength={isTemplateInstance ? NAME_MAX_LENGTH : GOAL_MAX_LENGTH}
        sectionDescription={
          isTemplateInstance
            ? isTemplateManager
              ? PROFILE_SECTION_STRINGS.DESCRIPTION_NAME_MANAGER
              : PROFILE_SECTION_STRINGS.DESCRIPTION_NAME
            : PROFILE_SECTION_STRINGS.DESCRIPTION_GOAL
        }
        showDescription={showMemberDescription}
        descriptionMaxLength={DESCRIPTION_MAX_LENGTH}
        onClose={handleClose}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />
    </section>
  );
}

export { ProfileSection };
export type { ProfileSectionProps };

import { useCallback, useEffect, useRef, type ReactElement } from "react";

import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";

import type { AgentTemplateAgentInstanceValues } from "../../form/agent-form.consts";
import { getFormValueAtPath } from "../../form/agent-form-field-path";
import { ConfigurationSection } from "../../form/configuration-section";
import { ModelSection } from "../../form/model-section";
import { ProfileSection } from "../../form/profile-section";
import { TemplateAgentRequirementsSection } from "../../form/template-agent-requirements-section";
import type { AgentTemplateAgentDefinition } from "../../form/agent-templates.consts";
import type { TemplateAgentFieldErrors } from "../../form/template-agent.utils";

import { TEMPLATE_AGENT_CONFIG_STRINGS } from "./template-agent-config-dialog.consts";

import "./template-agent-config-dialog.scss";

type TemplateAgentConfigDialogProps = {
  open: boolean;
  form: AnyReactFormApi;
  fieldPrefix: string;
  agentDefinition: AgentTemplateAgentDefinition;
  recommendedModel?: string;
  validationErrors?: TemplateAgentFieldErrors;
  /** When the template examples/instructions side pane is open, shift the dialog left. */
  withSidePane?: boolean;
  /** Hide the KB / toolset requirements section (used by the manager agent). */
  hideResources?: boolean;
  /** Overrides the dialog subtitle (defaults to the agent definition name). */
  subtitle?: string;
  onClose: () => void;
  onSave: () => void;
};

function cloneAgentInstance(
  value: AgentTemplateAgentInstanceValues | undefined,
): AgentTemplateAgentInstanceValues | null {
  if (!value) return null;
  return structuredClone(value);
}

function TemplateAgentConfigDialog({
  open,
  form,
  fieldPrefix,
  agentDefinition,
  recommendedModel,
  validationErrors,
  withSidePane = false,
  hideResources = false,
  subtitle,
  onClose,
  onSave,
}: TemplateAgentConfigDialogProps): ReactElement {
  const snapshotRef = useRef<AgentTemplateAgentInstanceValues | null>(null);

  useEffect(() => {
    if (open) {
      snapshotRef.current = cloneAgentInstance(
        getFormValueAtPath<AgentTemplateAgentInstanceValues>(form.state.values, fieldPrefix),
      );
    }
  }, [open, fieldPrefix, form]);

  const handleCancel = useCallback((): void => {
    if (snapshotRef.current) {
      form.setFieldValue(fieldPrefix, snapshotRef.current);
    }
    onClose();
  }, [fieldPrefix, form, onClose]);

  const handleSave = useCallback((): void => {
    onSave();
    onClose();
  }, [onClose, onSave]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel();
      }}
      size="lg"
    >
      <DialogPopup
        showCloseButton={false}
        className={
          withSidePane ? "template-agent-config-dialog-popup--with-sidepane" : undefined
        }
      >
        <Card className="template-agent-config-dialog">
          <CardHeader
            title={TEMPLATE_AGENT_CONFIG_STRINGS.DIALOG_TITLE}
            subtitle={subtitle ?? agentDefinition.name}
            hasSeparator
          />

          <CardContent className="template-agent-config-dialog__card-content">
            <div className="template-agent-config-dialog__content">
              <ModelSection
                form={form}
                fieldPrefix={fieldPrefix}
                recommendedModel={recommendedModel}
                primaryModelError={validationErrors?.primaryModel}
                showPrimaryModelRequired
                showModelParams={!hideResources}
              />
              <ProfileSection
                form={form}
                fieldPrefix={fieldPrefix}
                validationErrors={{
                  name: validationErrors?.name,
                  instructions: validationErrors?.instructions,
                }}
              />
              {!hideResources && (
                <TemplateAgentRequirementsSection
                  form={form}
                  fieldPrefix={fieldPrefix}
                  requirements={agentDefinition.requirements}
                  knowledgeBasesError={validationErrors?.knowledgeBases}
                  toolsetsError={validationErrors?.toolsets}
                />
              )}
              {/* Manager feature cards are not persisted on team create — member agents keep ConfigurationSection */}
              {/* <ConfigurationSection form={form} fieldPrefix={fieldPrefix} /> */}
              {!hideResources && (
                <ConfigurationSection form={form} fieldPrefix={fieldPrefix} />
              )}
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: TEMPLATE_AGENT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: TEMPLATE_AGENT_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
                onClick: handleCancel,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

export { TemplateAgentConfigDialog };
export type { TemplateAgentConfigDialogProps };

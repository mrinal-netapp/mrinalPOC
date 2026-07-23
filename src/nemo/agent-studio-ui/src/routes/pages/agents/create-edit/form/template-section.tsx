import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";

import { TemplateSelectionDialog } from "../configure-dialogs/template-selection-dialog";
import type { TemplateSelectionDialogProps } from "../configure-dialogs/template-selection-dialog";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { AGENT_ORCHESTRATION_OPTIONS, buildEmptyTemplateAgentInstance } from "./agent-form.consts";
import {
  AGENT_TEMPLATE_CATALOG,
  type AgentTemplateDefinition,
} from "./agent-templates.consts";
import {
  buildAgentInstancesFromTemplate,
  buildManagerInstanceFromTemplate,
  orchestrationRequiresInlineManager,
  templateOrchestrationToFormValue,
} from "./template-agent.utils";

interface TemplateSectionProps {
  form: AnyReactFormApi;
  /** Override the catalog of templates the dialog presents. Defaults to AGENT_TEMPLATE_CATALOG. */
  templates?: AgentTemplateDefinition[];
  /** Forwarded to the selection dialog so it can preview template examples/instructions. */
  onOpenDetails: TemplateSelectionDialogProps["onOpenDetails"];
}

function TemplateSection({
  form,
  templates = AGENT_TEMPLATE_CATALOG,
  onOpenDetails,
}: TemplateSectionProps): ReactElement {
  const selectedTemplate: AgentTemplateDefinition | null = useStore(
    form.store,
    (s: { values: { template: { selectedTemplate: AgentTemplateDefinition | null } } }) =>
      s.values.template.selectedTemplate,
  );
  const orchestrationPattern = useStore(
    form.store,
    (s: { values: { template: { orchestrationPattern: string } } }) =>
      s.values.template.orchestrationPattern,
  );

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // Draft selection lives in local state so cancelling the dialog never
  // mutates the persisted form value.
  const [draftId, setDraftId] = useState<string | null>(null);
  const previousOrchestrationRef = useRef<{ templateId: string | null; pattern: string }>({
    templateId: null,
    pattern: "",
  });

  useEffect(() => {
    const previous = previousOrchestrationRef.current;
    const templateId = selectedTemplate?.id ?? null;
    const templateChanged = previous.templateId !== templateId;

    if (!selectedTemplate || templateChanged) {
      previousOrchestrationRef.current = { templateId, pattern: orchestrationPattern };
      return;
    }

    const defaultPattern = templateOrchestrationToFormValue(selectedTemplate.orchestrationPattern);
    const enteredManagerPolicy =
      !orchestrationRequiresInlineManager(previous.pattern) &&
      orchestrationRequiresInlineManager(orchestrationPattern);

    // A manager supplied by a Coordinate/Route template remains available when
    // users switch policies. Sequential/Concurrent templates have no manager
    // defaults, so entering Coordinate/Route starts with a blank configuration.
    if (!orchestrationRequiresInlineManager(defaultPattern) && enteredManagerPolicy) {
      form.setFieldValue("template.managerInstance", buildEmptyTemplateAgentInstance());
    }

    previousOrchestrationRef.current = { templateId, pattern: orchestrationPattern };
  }, [form, orchestrationPattern, selectedTemplate]);

  const handleOpen = useCallback((): void => {
    setDraftId(selectedTemplate?.id ?? null);
    setIsDialogOpen(true);
  }, [selectedTemplate]);

  const handleClose = useCallback((): void => {
    setIsDialogOpen(false);
  }, []);

  const handleSelectionChange = useCallback((id: string): void => {
    setDraftId(id);
  }, []);

  const handleSave = useCallback((): void => {
    const picked = templates.find((t) => t.id === draftId);
    if (picked) {
      const pattern = templateOrchestrationToFormValue(picked.orchestrationPattern);
      form.setFieldValue("template.selectedTemplate", picked);
      form.setFieldValue("template.agentInstances", buildAgentInstancesFromTemplate(picked));
      form.setFieldValue(
        "template.managerInstance",
        orchestrationRequiresInlineManager(pattern)
          ? buildManagerInstanceFromTemplate(picked)
          : buildEmptyTemplateAgentInstance(),
      );
      form.setFieldValue("template.orchestrationPattern", pattern);
    }
    setIsDialogOpen(false);
  }, [draftId, form, templates]);

  return (
    <>
      <section className="agent-form__section">
        <div className="agent-form__section-header">
          <Typography
            Component="h2"
            fontSize="fs16"
            boldness="semibold"
            className="agent-form__section-title"
          >
            Template
          </Typography>
        </div>

        <div className="agent-form__section-body">
          {selectedTemplate && (
            <div className="agent-form__resource-body agent-form__template-summary">
              <Typography fontSize="fs14" className="agent-form__resource-row-label">
                Name
              </Typography>
              <Typography fontSize="fs14">{selectedTemplate.name}</Typography>

              <Typography fontSize="fs14" className="agent-form__resource-row-label">
                Configuration
              </Typography>
              <Typography fontSize="fs14">Team</Typography>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="medium"
            label={selectedTemplate ? "Change template" : "Select"}
            className="agent-form__add-resource"
            onClick={handleOpen}
          />
        </div>
      </section>

      {selectedTemplate && (
        <section className="agent-form__section agent-form__section--no-divider">
          <div className="agent-form__section-header">
            <Typography
              Component="h2"
              fontSize="fs16"
              boldness="semibold"
              className="agent-form__section-title"
            >
              Configuration
            </Typography>
          </div>

          <div className="agent-form__section-body">
            <div className="agent-form__field">
              <SelectDropdownField
                form={form}
                name="template.orchestrationPattern"
                label="Orchestration pattern"
                items={AGENT_ORCHESTRATION_OPTIONS}
                placeholder="Select orchestration pattern"
                size="fill"
              />
            </div>
          </div>
        </section>
      )}

      <TemplateSelectionDialog
        open={isDialogOpen}
        templates={templates}
        selectedTemplateId={draftId}
        onClose={handleClose}
        onSelectionChange={handleSelectionChange}
        onOpenDetails={onOpenDetails}
        onSave={handleSave}
      />
    </>
  );
}

export { TemplateSection };
export type { TemplateSectionProps };

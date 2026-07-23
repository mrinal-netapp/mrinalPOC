import { useCallback, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import { IconInfoCircle } from "@tabler/icons-react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
} from "./agent-templates.consts";
import type { AgentTemplateAgentInstanceValues } from "./agent-form.consts";
import { TemplateAgentCard } from "./template-agent-card";
import { TeamAgentsSection } from "./team-agents-section";
import { TeamTeamsSection } from "./team-teams-section";
import { TerminationStrategyCollapsible } from "./team-config-section";
import {
  MANAGER_AGENT_FIELD_PREFIX,
  orchestrationRequiresInlineManager,
  templateAgentFieldPrefix,
  type TemplateAgentFieldErrors,
} from "./template-agent.utils";

interface TemplateAgentsSectionProps {
  form: AnyReactFormApi;
  withSidePane?: boolean;
  validationErrorsByAgent?: Record<number, TemplateAgentFieldErrors>;
  managerValidationErrors?: TemplateAgentFieldErrors;
}

function TemplateAgentsSection({
  form,
  withSidePane = false,
  validationErrorsByAgent,
  managerValidationErrors,
}: TemplateAgentsSectionProps): ReactElement | null {
  const selectedTemplate = useStore(
    form.store,
    (s: { values: { template: { selectedTemplate: AgentTemplateDefinition | null } } }) =>
      s.values.template.selectedTemplate,
  );
  const orchestrationPattern = useStore(
    form.store,
    (s: { values: { template: { orchestrationPattern: string } } }) =>
      s.values.template.orchestrationPattern,
  );
  const requiresManager = orchestrationRequiresInlineManager(orchestrationPattern);

  // Removes a single agent from the template: drops it from both the template
  // catalog copy and the per-agent instances so rendering, validation, and the
  // save flow stay index-aligned.
  const handleRemoveAgent = useCallback(
    (index: number): void => {
      const template = form.state.values.template
        .selectedTemplate as AgentTemplateDefinition | null;
      if (!template) return;
      const agents = template.agents.filter((_, i) => i !== index);
      const instances = (
        form.state.values.template.agentInstances as AgentTemplateAgentInstanceValues[]
      ).filter((_, i) => i !== index);
      form.setFieldValue("template.selectedTemplate", { ...template, agents });
      form.setFieldValue("template.agentInstances", instances);
    },
    [form],
  );

  if (!selectedTemplate) {
    return null;
  }

  // The manager agent is driven by the template-level fields (name, role,
  // instructions). It reuses the agent card/dialog with empty requirements so
  // no KBs / toolsets are shown.
  const managerDefinition: AgentTemplateAgentDefinition = {
    name: selectedTemplate.name,
    role: selectedTemplate.role,
    systemPrompt: selectedTemplate.instructions,
    modelId: "",
    requirements: { knowledgeBases: [], mcpServers: [] },
  };

  return (
    <>
      {requiresManager && (
        <section className="agent-form__section">
          <div className="agent-form__section-body">
            <TemplateAgentCard
              form={form}
              fieldPrefix={MANAGER_AGENT_FIELD_PREFIX}
              agentDefinition={managerDefinition}
              recommendedModel={selectedTemplate.model}
              validationErrors={managerValidationErrors}
              withSidePane={withSidePane}
              headerLabel="Manager agent"
              hideResources
            />
            {orchestrationPattern === "coordinate" && (
              <TerminationStrategyCollapsible form={form} />
            )}
          </div>
          <div className="agent-form__template-info-note">
            <IconInfoCircle size={16} aria-hidden="true" />
            <Typography fontSize="fs13" color="var(--text-secondary)">
              At least one single agent or team agent must be added.
            </Typography>
          </div>
        </section>
      )}

      <section className="agent-form__section">
        <div className="agent-form__section-header">
          <Typography
            Component="h2"
            fontSize="fs16"
            boldness="semibold"
            className="agent-form__section-title"
          >
            Single agents
          </Typography>
        </div>

        <div className="agent-form__section-body agent-form__template-agent-list">
          {selectedTemplate.agents.map((agentDefinition, index) => (
            <TemplateAgentCard
              key={`${selectedTemplate.id}-agent-${index}`}
              form={form}
              fieldPrefix={templateAgentFieldPrefix(index)}
              agentDefinition={agentDefinition}
              recommendedModel={selectedTemplate.model}
              validationErrors={validationErrorsByAgent?.[index]}
              withSidePane={withSidePane}
              headerLabel="Single agent"
              subtitle="Optional"
              onRemove={() => handleRemoveAgent(index)}
            />
          ))}
        </div>

        <TeamAgentsSection form={form} showHeader={false} />
      </section>

      <section className="agent-form__section">
        <div className="agent-form__section-header">
          <Typography
            Component="h2"
            fontSize="fs16"
            boldness="semibold"
            className="agent-form__section-title"
          >
            Team agents
          </Typography>
        </div>

        <TeamTeamsSection form={form} showHeader={false} />
      </section>
    </>
  );
}

export { TemplateAgentsSection };
export type { TemplateAgentsSectionProps };

import {
  agentNamePatternError,
  DEFAULT_ENABLED_FEATURES,
  DEFAULT_FEATURE_CONFIG,
  DEFAULT_MODEL_PARAMS,
  sanitizeAgentName,
  type AgentFormValues,
  type AgentKBStatus,
  type AgentTemplateAgentInstanceValues,
} from "./agent-form.consts";
import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
  AgentTemplateOrchestrationPattern,
  AgentTemplateResourceRequirement,
} from "./agent-templates.consts";
import type {
  AgentRequirements,
  AgentResourceRequirement,
  AgentTeamOrchestrationPolicy,
} from "@/routes/pages/agents/api/agents-config.types";

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Maps catalog display values to the form/API orchestration policy value. */
export function templateOrchestrationToFormValue(
  pattern: AgentTemplateOrchestrationPattern,
): AgentTeamOrchestrationPolicy {
  return pattern.toLowerCase() as AgentTeamOrchestrationPolicy;
}

export function orchestrationRequiresInlineManager(pattern: string | undefined): boolean {
  return pattern === "coordinate" || pattern === "route";
}

/**
 * Predefined templates already give each member agent a distinct, meaningful
 * name (e.g. "Storage savings reporter"), so the default agent name is just
 * that label run through {@link sanitizeAgentName}; no disambiguating
 * suffix is added. If the user re-applies the same template and a name
 * collides with an existing agent, the backend surfaces a clear "already
 * exists" error at save time, same as for a manually typed duplicate name.
 */
export function buildAgentInstanceFromTemplate(
  agent: AgentTemplateAgentDefinition,
  templateInstructions: string,
): AgentTemplateAgentInstanceValues {
  return {
    primaryModel: "",
    primaryModelParams: { ...DEFAULT_MODEL_PARAMS },
    fallbackModel: "",
    fallbackModelParams: { ...DEFAULT_MODEL_PARAMS },
    name: sanitizeAgentName(agent.name),
    description: "",
    instructions: agent.systemPrompt.trim() || templateInstructions,
    knowledgeBases: [],
    toolsets: [],
    enabledFeatures: [...DEFAULT_ENABLED_FEATURES],
    featureConfig: { ...DEFAULT_FEATURE_CONFIG },
    satisfiedKbRequirementIds: [],
    satisfiedMcpRequirementIds: [],
    kbRequirementAttachments: {},
    mcpRequirementAttachments: {},
    removedKbRequirementIds: [],
    removedMcpRequirementIds: [],
  };
}

export function buildAgentInstancesFromTemplate(
  template: AgentTemplateDefinition,
): AgentTemplateAgentInstanceValues[] {
  return template.agents.map((agent) =>
    buildAgentInstanceFromTemplate(agent, template.instructions),
  );
}

/**
 * Seeds the manager agent config from the template-level fields. The manager
 * has no KBs / toolsets; `name` is the manager display name and `instructions`
 * the system prompt. The model starts empty so the user picks one (the
 * template's recommended model is surfaced as a hint).
 */
export function buildManagerInstanceFromTemplate(
  template: AgentTemplateDefinition,
): AgentTemplateAgentInstanceValues {
  return {
    primaryModel: "",
    primaryModelParams: { ...DEFAULT_MODEL_PARAMS },
    fallbackModel: "",
    fallbackModelParams: { ...DEFAULT_MODEL_PARAMS },
    name: sanitizeAgentName(template.name),
    description: "",
    instructions: template.instructions,
    knowledgeBases: [],
    toolsets: [],
    enabledFeatures: [...DEFAULT_ENABLED_FEATURES],
    featureConfig: { ...DEFAULT_FEATURE_CONFIG },
    satisfiedKbRequirementIds: [],
    satisfiedMcpRequirementIds: [],
    kbRequirementAttachments: {},
    mcpRequirementAttachments: {},
    removedKbRequirementIds: [],
    removedMcpRequirementIds: [],
  };
}

/** The manager is configured once model, name, and instructions are set. */
export function isTemplateManagerConfigured(
  instance: AgentTemplateAgentInstanceValues | undefined,
): boolean {
  if (!instance) return false;
  return Boolean(
    trimText(instance.primaryModel) &&
      trimText(instance.name) &&
      trimText(instance.instructions),
  );
}

/** Collects manager validation errors for the save flow. */
export function collectTemplateManagerSaveErrors(
  instance: AgentTemplateAgentInstanceValues | undefined,
  mode: "draft" | "deploy",
): TemplateAgentFieldErrors {
  const errors: TemplateAgentFieldErrors = {};
  if (!trimText(instance?.primaryModel)) {
    errors.primaryModel = "Configure a primary model to save the manager agent";
  }
  if (!trimText(instance?.name)) {
    errors.name =
      mode === "deploy"
        ? "Configure the manager name to deploy the agent"
        : "Configure the manager name to save the agent as draft";
  } else {
    const patternError = agentNamePatternError(instance?.name ?? "");
    if (patternError) errors.name = patternError;
  }
  if (!trimText(instance?.instructions)) {
    errors.instructions =
      mode === "deploy"
        ? "Configure the manager instructions to deploy the agent"
        : "Configure the manager instructions to save the agent as draft";
  }
  return errors;
}

/** A KB requirement is "configured" once a real KB has been attached to it. */
export function isKbRequirementConfigured(
  requirementId: string,
  instance: AgentTemplateAgentInstanceValues,
): boolean {
  return instance.satisfiedKbRequirementIds?.includes(requirementId) ?? false;
}

/** A toolset requirement is "configured" once a real toolset is attached to it. */
export function isMcpRequirementConfigured(
  requirementId: string,
  instance: AgentTemplateAgentInstanceValues,
): boolean {
  return instance.satisfiedMcpRequirementIds?.includes(requirementId) ?? false;
}

/** Template KB requirements still active on this agent (not removed by the user). */
export function activeKbRequirements(
  requirements: AgentTemplateAgentDefinition["requirements"],
  instance: AgentTemplateAgentInstanceValues,
): AgentTemplateResourceRequirement[] {
  const removed = new Set(instance.removedKbRequirementIds ?? []);
  return requirements.knowledgeBases.filter((req) => !removed.has(req.id));
}

/** Template toolset requirements still active on this agent (not removed). */
export function activeMcpRequirements(
  requirements: AgentTemplateAgentDefinition["requirements"],
  instance: AgentTemplateAgentInstanceValues,
): AgentTemplateResourceRequirement[] {
  const removed = new Set(instance.removedMcpRequirementIds ?? []);
  return requirements.mcpServers.filter((req) => !removed.has(req.id));
}

export function areRequiredKnowledgeBasesAttached(
  requirements: AgentTemplateAgentDefinition["requirements"],
  instance: AgentTemplateAgentInstanceValues,
): boolean {
  // Per-requirement: every active required KB requirement must be configured
  // (or removed from the template, which drops it from the active set).
  return activeKbRequirements(requirements, instance)
    .filter((req) => req.required)
    .every((req) => isKbRequirementConfigured(req.id, instance));
}

export function areRequiredToolsetsAttached(
  requirements: AgentTemplateAgentDefinition["requirements"],
  instance: AgentTemplateAgentInstanceValues,
): boolean {
  return activeMcpRequirements(requirements, instance)
    .filter((req) => req.required)
    .every((req) => isMcpRequirementConfigured(req.id, instance));
}

/**
 * True only when every template agent has all of its required KB and toolset
 * requirements attached (or removed). Used to grey out the template "Save and
 * deploy" button early, matching the single-agent flow, instead of letting
 * the user click and only then surfacing the per-requirement errors at submit.
 */
export function areTemplateRequiredDependenciesAttached(
  template: AgentTemplateDefinition,
  instances: AgentTemplateAgentInstanceValues[],
): boolean {
  return template.agents.every((agentDef, index) => {
    const instance = instances[index];
    if (!instance) return true;
    return (
      areRequiredKnowledgeBasesAttached(agentDef.requirements, instance) &&
      areRequiredToolsetsAttached(agentDef.requirements, instance)
    );
  });
}

function toResourceRequirement(
  requirement: AgentTemplateResourceRequirement,
): AgentResourceRequirement {
  return {
    id: requirement.id,
    label: requirement.label,
    description: requirement.description,
    required: requirement.required,
  };
}

/**
 * Builds the `requirements` placeholder payload for a member agent. Configured
 * requirements are persisted as real KB / toolset attachments (via the form's
 * knowledgeBaseIds / mcpServerIds); any active requirement the user has NOT
 * configured is sent as a placeholder so the declared need is persisted:
 * required ones block deploy server-side, optional ones are informational
 * ("skipped"). Returns undefined when nothing is unresolved.
 */
export function buildAgentRequirementsPayload(
  agentDef: AgentTemplateAgentDefinition,
  instance: AgentTemplateAgentInstanceValues,
): AgentRequirements | undefined {
  const knowledgeBases = activeKbRequirements(agentDef.requirements, instance)
    .filter((req) => !isKbRequirementConfigured(req.id, instance))
    .map(toResourceRequirement);
  const mcpServers = activeMcpRequirements(agentDef.requirements, instance)
    .filter((req) => !isMcpRequirementConfigured(req.id, instance))
    .map(toResourceRequirement);

  if (knowledgeBases.length === 0 && mcpServers.length === 0) {
    return undefined;
  }

  return {
    ...(knowledgeBases.length > 0 && { knowledgeBases }),
    ...(mcpServers.length > 0 && { mcpServers }),
  };
}

/** Unconfigured OPTIONAL dependencies that will be skipped on deploy. */
export type SkippedDependency = { kind: "Knowledge base" | "Toolset"; label: string };

/**
 * Collects the optional template requirements that remain unconfigured across
 * all member agents; these are surfaced in the "Save and deploy" confirmation
 * so the user acknowledges they will be skipped.
 */
export function collectSkippedOptionalDependencies(
  template: AgentTemplateDefinition,
  instances: AgentTemplateAgentInstanceValues[],
): SkippedDependency[] {
  const skipped: SkippedDependency[] = [];
  template.agents.forEach((agentDef, index) => {
    const instance = instances[index];
    if (!instance) return;
    activeKbRequirements(agentDef.requirements, instance)
      .filter((req) => !req.required && !isKbRequirementConfigured(req.id, instance))
      .forEach((req) => skipped.push({ kind: "Knowledge base", label: req.label }));
    activeMcpRequirements(agentDef.requirements, instance)
      .filter((req) => !req.required && !isMcpRequirementConfigured(req.id, instance))
      .forEach((req) => skipped.push({ kind: "Toolset", label: req.label }));
  });
  return skipped;
}

export function isTemplateAgentConfigured(
  agentDef: AgentTemplateAgentDefinition,
  instance: AgentTemplateAgentInstanceValues | undefined,
): boolean {
  if (!instance) return false;
  if (
    !trimText(instance.primaryModel) ||
    !trimText(instance.name) ||
    !trimText(instance.instructions)
  ) {
    return false;
  }
  return (
    areRequiredKnowledgeBasesAttached(agentDef.requirements, instance) &&
    areRequiredToolsetsAttached(agentDef.requirements, instance)
  );
}

export function deriveTemplateAgentSummary(
  agentDef: AgentTemplateAgentDefinition,
  instance: AgentTemplateAgentInstanceValues | undefined,
): {
  name: string;
  status: AgentKBStatus;
  deployment: string;
  role: string;
} {
  return {
    name: instance?.name.trim() || agentDef.name,
    status: isTemplateAgentConfigured(agentDef, instance) ? "healthy" : "degraded",
    deployment: "Not deployed",
    role: agentDef.role?.trim() || "",
  };
}

export function templateAgentFieldPrefix(index: number): string {
  return `template.agentInstances[${index}]`;
}

/** Field path for the manager agent instance. */
export const MANAGER_AGENT_FIELD_PREFIX = "template.managerInstance";

export type TemplateAgentFieldErrors = {
  primaryModel?: string;
  name?: string;
  instructions?: string;
  knowledgeBases?: string;
  toolsets?: string;
};

/** Clears resolved field errors as the user completes each template agent card. */
export function validateTemplateAgentInstances(
  template: AgentTemplateDefinition,
  instances: AgentTemplateAgentInstanceValues[],
  previous: Record<number, TemplateAgentFieldErrors>,
): Record<number, TemplateAgentFieldErrors> {
  const next: Record<number, TemplateAgentFieldErrors> = { ...previous };

  template.agents.forEach((agentDef, index) => {
    const instance = instances[index];
    if (!instance) {
      delete next[index];
      return;
    }

    const agentErrors: TemplateAgentFieldErrors = { ...(next[index] ?? {}) };

    if (trimText(instance.primaryModel)) {
      delete agentErrors.primaryModel;
    }
    if (trimText(instance.name)) {
      delete agentErrors.name;
    }
    if (trimText(instance.instructions)) {
      delete agentErrors.instructions;
    }

    if (areRequiredKnowledgeBasesAttached(agentDef.requirements, instance)) {
      delete agentErrors.knowledgeBases;
    }

    if (areRequiredToolsetsAttached(agentDef.requirements, instance)) {
      delete agentErrors.toolsets;
    }

    if (Object.keys(agentErrors).length === 0) {
      delete next[index];
    } else {
      next[index] = agentErrors;
    }
  });

  return next;
}

export function collectTemplateAgentSaveErrors(
  template: AgentTemplateDefinition,
  instances: AgentTemplateAgentInstanceValues[],
  mode: "draft" | "deploy",
): Record<number, TemplateAgentFieldErrors> {
  const errors: Record<number, TemplateAgentFieldErrors> = {};

  template.agents.forEach((agentDef, index) => {
    const instance = instances[index];
    if (!instance) return;

    const agentErrors: TemplateAgentFieldErrors = {};

    if (!trimText(instance.primaryModel)) {
      agentErrors.primaryModel = "Configure a primary model to save the agent as draft";
    }

    if (!trimText(instance.name)) {
      agentErrors.name =
        mode === "deploy"
          ? "Configure the name to deploy the agent"
          : "Configure the name to save the agent as draft";
    } else {
      const patternError = agentNamePatternError(instance.name);
      if (patternError) agentErrors.name = patternError;
    }

    if (!trimText(instance.instructions)) {
      agentErrors.instructions =
        mode === "deploy"
          ? "Configure the instructions to deploy the agents"
          : "Configure the instructions to save the agent as draft";
    }

    if (mode === "deploy") {
      if (!areRequiredKnowledgeBasesAttached(agentDef.requirements, instance)) {
        agentErrors.knowledgeBases =
          "Add the required Knowledge Bases to deploy the agent";
      }

      if (!areRequiredToolsetsAttached(agentDef.requirements, instance)) {
        agentErrors.toolsets =
          "Add the required Toolsets to deploy the agent";
      }
    }

    if (Object.keys(agentErrors).length > 0) {
      errors[index] = agentErrors;
    }
  });

  return errors;
}

/** Copies the first template agent instance into top-level single-agent fields for save. */
export function mergeFirstTemplateAgentIntoFormValues(
  formValues: AgentFormValues,
): AgentFormValues {
  const first = formValues.template.agentInstances[0];
  if (!first) return formValues;

  return {
    ...formValues,
    primaryModel: first.primaryModel,
    primaryModelParams: first.primaryModelParams,
    fallbackModel: first.fallbackModel,
    fallbackModelParams: first.fallbackModelParams,
    goal: first.name,
    instructions: first.instructions,
    knowledgeBases: first.knowledgeBases,
    toolsets: first.toolsets,
    enabledFeatures: first.enabledFeatures,
    featureConfig: first.featureConfig,
  };
}

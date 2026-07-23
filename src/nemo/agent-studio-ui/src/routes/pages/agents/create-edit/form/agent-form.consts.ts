import type { AgentResourceRequirement, AgentTeamOrchestrationPolicy } from "@/routes/pages/agents/api/agents-config.types";
import { MESSAGE_RETENTION_METHOD_LABEL } from "../configure-dialogs/configure-dialogs.consts";
import type { MessageRetentionMethod } from "../configure-dialogs/configure-dialogs.types";
import type { AgentTemplateDefinition } from "./agent-templates.consts";

export type { AgentResourceRequirement };

export type AgentConfiguration = "single" | "team" | "from_template";

export type AgentKBStatus = "healthy" | "degraded" | "unhealthy";

/** RAG settings for a single knowledge base, mirroring the per-KB `ragConfig` API map values. */
export interface AgentAttachedKBRagConfig {
  topKChunks: number;
  rerankingEnabled: boolean;
  similarityThresholdEnabled: boolean;
  similarity: number;
}

export interface AgentAttachedKB {
  id: string;
  name: string;
  status: AgentKBStatus;
  tier: string;
  remaining: string;
  fileUsage: string;
  /** Per-KB RAG settings. Undefined for KBs restored without config (legacy payloads). */
  ragConfig?: AgentAttachedKBRagConfig;
}

export interface AgentAttachedToolset {
  id: string;
  name: string;
  status: AgentKBStatus;
  account: string;
  authMethod: string;
  tools: string[];
}

/**
 * A single agent or team referenced by the team-agent configuration.
 * Used in the Manager / Agents / Teams cards on the multi-agent variant.
 */
export interface AgentSubEntity {
  id: string;
  name: string;
  status: AgentKBStatus;
  deployment: string;
  labels: string[];
}

export type AgentFeatureKey =
  | "output_response"
  | "structured_output"
  | "file_output"
  | "conversation_memory"
  | "safety_guardrails"
  | "automatic_retries"
  | "api_rate_limiting";

export interface AgentModelParams {
  temperature: number;
  topP: number;
  /** Top-K sampling. 0 means "leave to the provider" — omitted from the request. */
  topK: number;
  responseLength: number;
}

export interface AgentConfigurationFeature {
  piiMaskerEnabled: boolean;
  apiKeyTokenScannerEnabled: boolean;
  secretDetectionEnabled: boolean;
  /**
   * How conversation history is retained. Maps to the new
   * `memoryContext.type` wire enum:
   *   "sliding_window" → "window"
   *   "summarized"     → "summary_buffer"
   */
  messageRetentionMethod: MessageRetentionMethod;
  /**
   * Default 10. Sent verbatim as `memoryContext.message_window_limit`
   * when `messageRetentionMethod === 'sliding_window'` — the field is no
   * longer gated by a separate "override" toggle. The UI default matches
   * the backend default range; whatever the user types is what gets sent.
   */
  messageHistoryLimit: number;
  /** Out of scope in the current memory-context wire — kept in the draft only. */
  sessionHistoryLimit: number;
  /**
   * Default 2000. Sent verbatim as `memoryContext.summary_token_limit`
   * when `messageRetentionMethod === 'summarized'`. Same gateless model
   * as `messageHistoryLimit` above.
   */
  summaryTokenLimit: number;
  maxRetries: number;
  /** Output-response example text — sent as `outputResponse.example_response`. */
  outputResponseExample: string;
  /**
   * Structured-output response format — sent as
   * `structuredOutput.responseFormat`. Selects whether the box holds a JSON
   * schema (`json_object`) or free-form text guidelines (`text`).
   */
  responseFormat: "text" | "json_object";
  /**
   * Structured-output box content (raw text) — sent as
   * `structuredOutput.outputSchema`. A JSON schema string when
   * `responseFormat === 'json_object'`, else free-form text guidelines.
   */
  structuredOutputSchema: string;
  /** Rate-limit ceiling — sent as `rateLimiting.max_requests_per_minute`. */
  maxRequestsPerMinute: number;
}

export interface AgentTeamValues {
  orchestrationPattern: string;
  /** Inline manager name — sent as `manager.name`. Required by the backend when no agent_id reference is provided. Used when orchestrationPattern is "coordinate" (Magentic planner) or "route" (triage router). */
  managerName: string;
  /** Inline manager model UUID — sent as `manager.modelId`. Used when orchestrationPattern is "coordinate" or "route". */
  managerModel: string;
  /** Manager instructions — sent verbatim as `manager.systemPrompt`. Used when orchestrationPattern is "coordinate" or "route". */
  managerInstructions: string;
  /**
   * Termination-strategy kind. Today only "maximum_iterations" is offered, but
   * the field is modelled as a string so the picker can grow (keyword/timeout)
   * without a form-shape migration. Only consumed when orchestrationPattern is
   * "coordinate" (→ MAF magentic planner). */
  terminationStrategyType: TeamTerminationStrategyType;
  /** Cap on planner iterations — sent as `terminationStrategy.maximum_iterations`. Coordinate-only. */
  maxIterations: number;
  agentIds: string[];
  teamIds: string[];
}

export interface AgentTemplateValues {
  selectedTemplate: AgentTemplateDefinition | null;
  /** Per-agent form state seeded from the selected template catalog entry. */
  agentInstances: AgentTemplateAgentInstanceValues[];
  /**
   * Manager agent config seeded from the template-level fields (name, role,
   * instructions, model). Reuses the agent-instance shape, but KBs / toolsets
   * are unused — the manager has no resources.
   */
  managerInstance: AgentTemplateAgentInstanceValues;
  /** Editable orchestration pattern (API policy value), seeded from the template. */
  orchestrationPattern: AgentTeamOrchestrationPolicy | "";
}

/** Mirrors single-agent fields for one template-defined agent. */
export interface AgentTemplateAgentInstanceValues {
  primaryModel: string;
  primaryModelParams: AgentModelParams;
  fallbackModel: string;
  fallbackModelParams: AgentModelParams;
  /** Display name for the agent/manager; maps to API `name` on template create. */
  name: string;
  /** Optional member-agent description; maps to API `description` on template create. */
  description: string;
  instructions: string;
  knowledgeBases: AgentAttachedKB[];
  toolsets: AgentAttachedToolset[];
  enabledFeatures: AgentFeatureKey[];
  featureConfig: AgentConfigurationFeature;
  /** Requirement ids fulfilled via the template Add flow (may differ from attached id). */
  satisfiedKbRequirementIds: string[];
  satisfiedMcpRequirementIds: string[];
  /** Maps template requirement id → attached knowledge base id. */
  kbRequirementAttachments: Record<string, string>;
  /** Maps template requirement id → attached toolset id. */
  mcpRequirementAttachments: Record<string, string>;
  /** Template KB requirement ids the user removed from this agent. */
  removedKbRequirementIds: string[];
  /** Template toolset requirement ids the user removed from this agent. */
  removedMcpRequirementIds: string[];
}

export interface AgentFormValues {
  // Setup
  configuration: AgentConfiguration;

  // Model (used by `single` only). Values are config-service model UUIDs
  // (the agent's `modelId`), sourced from `GET /models` via the picker.
  // Empty string means "no selection yet".
  primaryModel: string;
  primaryModelParams: AgentModelParams;
  /** Single fallback model UUID (empty when none selected). */
  fallbackModel: string;
  fallbackModelParams: AgentModelParams;

  // Profile (used by `single` and `from_template`)
  goal: string;
  instructions: string;
  /** Persona label from the API or template catalog; not shown in Profile UI today. */
  role: string;

  // Knowledge bases / toolsets (`single` and `from_template`)
  knowledgeBases: AgentAttachedKB[];
  toolsets: AgentAttachedToolset[];

  // Feature configuration cards (`single` only)
  enabledFeatures: AgentFeatureKey[];
  featureConfig: AgentConfigurationFeature;

  // Team-agent state (`team` only)
  team: AgentTeamValues;

  // Template state (`from_template` only)
  template: AgentTemplateValues;

  /**
   * Incomplete KB / MCP entries from the API `requirements` column.
   * A KB/MCP here has been added to the agent but still needs configuration.
   * Items with `required: true` block deployment.
   */
  requirements: {
    knowledgeBases: AgentResourceRequirement[];
    mcpServers: AgentResourceRequirement[];
  };
}

export const GOAL_MAX_LENGTH = 100;
export const NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;
export const INSTRUCTIONS_MAX_LENGTH = 5000;

/**
 * Allowed characters + length for an agent / team-manager name. Mirrors the
 * backend validator ``^[a-zA-Z0-9_-]{1,64}$`` (agent-service-maf
 * ``agent_builder._validate_agent_name``): letters, numbers, hyphens, and
 * underscores only — NO spaces — max 64 chars. Names that violate this crash
 * multi-agent orchestration at build time (e.g. a router named "Triage Agent"),
 * so we surface it in the form before save. The backend also sanitizes as a
 * fallback, but the UI rejects up front for clear feedback.
 */
export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const AGENT_NAME_MAX_LENGTH = 64;
export const AGENT_NAME_PATTERN_ERROR =
  "Use only letters, numbers, hyphens (-) or underscores (_) — no spaces (max 64 characters).";

/**
 * Validate an agent/manager name against {@link AGENT_NAME_PATTERN}.
 *
 * Returns the pattern error message for a non-empty invalid name, or
 * ``undefined`` when the name is valid OR empty — emptiness is a separate
 * "required" concern handled by the caller, so this only guards the character
 * set / length.
 *
 * The **raw** value is validated (not a trimmed copy): the backend regex
 * ``^[a-zA-Z0-9_-]{1,64}$`` rejects spaces, so leading/trailing whitespace must
 * fail here too. Trimming before the test would give a false pass on names like
 * ``"Agent-1 "`` that the backend then rejects. Whitespace-*only* input is still
 * treated as empty (deferred to the caller's required check) so the user sees
 * "required", not "invalid characters", for a blank field.
 */
export function agentNamePatternError(name: string): string | undefined {
  if (!name.trim()) return undefined;
  if (name.length > AGENT_NAME_MAX_LENGTH || !AGENT_NAME_PATTERN.test(name)) {
    return AGENT_NAME_PATTERN_ERROR;
  }
  return undefined;
}

/**
 * Coerce an arbitrary label into a valid agent name (see {@link AGENT_NAME_PATTERN}).
 *
 * Mirrors the backend ``agent_builder._sanitize_agent_name``: runs of disallowed
 * characters (spaces, punctuation) collapse to a single hyphen, leading/trailing
 * hyphens are trimmed, the result is capped at {@link AGENT_NAME_MAX_LENGTH}, and
 * an empty result falls back to *fallback*. Used to seed template default names
 * (e.g. a template titled "Research Team" → "Research-Team") so generated names
 * satisfy the validator up front rather than tripping it at save.
 */
export function sanitizeAgentName(name: string, fallback = "Agent"): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, AGENT_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  return cleaned || fallback;
}

export const GOAL_PLACEHOLDER = "Describe the agent's goal and purpose.";
export const NAME_PLACEHOLDER = "Enter the agent name.";
export const DESCRIPTION_PLACEHOLDER = "Describe what this agent does.";
export const INSTRUCTIONS_PLACEHOLDER = "Describe the agent's tone, constraints, and instructions.";

export const DEFAULT_MODEL_PARAMS: AgentModelParams = {
  temperature: 0.7,
  topP: 1.0,
  topK: 0,
  responseLength: 1024,
};

/** Termination-strategy kinds offered in the Coordinate team UI. */
export type TeamTerminationStrategyType = "maximum_iterations";

/**
 * Termination-strategy picker options. Coordinate (Magentic) currently exposes
 * only "Maximum iteration"; the list is kept so adding keyword/timeout later is
 * a one-line change rather than a new control.
 */
export const TEAM_TERMINATION_STRATEGY_OPTIONS: {
  key: string;
  value: TeamTerminationStrategyType;
  label: string;
}[] = [{ key: "maximum_iterations", value: "maximum_iterations", label: "Maximum iteration" }];

/** Default planner-iteration cap for a Coordinate team. */
export const DEFAULT_TEAM_MAX_ITERATIONS = 6;
/** Lower / upper bounds for the Coordinate team max-iterations slider. */
export const TEAM_MAX_ITERATIONS_MIN = 1;
export const TEAM_MAX_ITERATIONS_MAX = 20;

export const DEFAULT_FEATURE_CONFIG: AgentConfigurationFeature = {
  piiMaskerEnabled: false,
  apiKeyTokenScannerEnabled: false,
  secretDetectionEnabled: false,
  messageRetentionMethod: "sliding_window",
  messageHistoryLimit: 10,
  sessionHistoryLimit: 3,
  summaryTokenLimit: 2000,
  maxRetries: 3,
  outputResponseExample: "",
  responseFormat: "json_object",
  structuredOutputSchema: "",
  maxRequestsPerMinute: 60,
};

export const DEFAULT_ENABLED_FEATURES: AgentFeatureKey[] = ["conversation_memory"];
// Applies to new-agent create flow via buildAgentDefaultValues(). Edit hydration
// uses mapAgentToFormValues(), which preserves the agent's saved enabledFeatures.

export const AGENT_CONFIGURATION_OPTIONS: {
  key: string;
  value: AgentConfiguration;
  label: string;
}[] = [
  { key: "single", value: "single", label: "Single agent" },
  { key: "team", value: "team", label: "Team agent" },
  { key: "from_template", value: "from_template", label: "Import from template" },
];

// Values are typed to AgentTeamOrchestrationPolicy so the picker can only
// ever offer policies the API accepts — a compile error fires if the server
// contract drifts from this list.
export const AGENT_ORCHESTRATION_OPTIONS: {
  key: string;
  value: AgentTeamOrchestrationPolicy;
  label: string;
}[] = [
  { key: "sequential", value: "sequential", label: "Sequential" },
  { key: "coordinate", value: "coordinate", label: "Coordinate" },
  { key: "concurrent", value: "concurrent", label: "Concurrent" },
  { key: "route", value: "route", label: "Route" },
];

export interface AgentFeatureMeta {
  key: AgentFeatureKey;
  title: string;
  /** Toggle copy: "Enable" while disabled; "Configure" once enabled. */
  actionWhenEnabled: "Configure" | "Enable";
}

/** A single label/value row rendered inside a feature card body. */
export interface FeatureRow {
  label: string;
  value: string | number;
}

/**
 * Builds the body rows shown inside a feature card for a given feature. Pure so
 * it can be shared by the create/edit Configuration section (editable cards) and
 * the agent details Configurations tab (read-only cards) without drift.
 */
export function buildFeatureBody(
  key: AgentFeatureKey,
  enabled: boolean,
  config: AgentConfigurationFeature,
): FeatureRow[] {
  switch (key) {
    case "conversation_memory": {
      // The card reflects the picked retention method and shows whichever
      // limit applies. Whatever value the user typed is what gets sent;
      // there's no longer a separate "override" toggle gating emission,
      // so the displayed value is always the saved value.
      const rows: FeatureRow[] = [
        { label: "Status", value: enabled ? "Enabled" : "Disabled" },
        {
          label: "Retention method",
          value: MESSAGE_RETENTION_METHOD_LABEL[config.messageRetentionMethod],
        },
      ];
      if (config.messageRetentionMethod === "sliding_window") {
        rows.push({
          label: "Message history limit",
          value: config.messageHistoryLimit,
        });
      } else {
        rows.push({
          label: "Summary token limit",
          value: config.summaryTokenLimit,
        });
      }
      return rows;
    }
    case "safety_guardrails":
      return [
        {
          label: "Personally Identifiable Information (PII)",
          value: config.piiMaskerEnabled ? "Enabled" : "Disabled",
        },
        {
          label: "API Key & Token Scanner",
          value: config.apiKeyTokenScannerEnabled ? "Enabled" : "Disabled",
        },
        {
          label: "Advanced Secret Detection",
          value: config.secretDetectionEnabled ? "Enabled" : "Disabled",
        },
      ];
    case "automatic_retries":
      return [
        { label: "Status", value: enabled ? "Enabled" : "Disabled" },
        { label: "Maximum retries", value: config.maxRetries },
      ];
    case "api_rate_limiting":
      return [
        { label: "Status", value: enabled ? "Enabled" : "Disabled" },
        { label: "Max requests per minute", value: config.maxRequestsPerMinute },
      ];
    default:
      return [{ label: "Status", value: enabled ? "Enabled" : "Disabled" }];
  }
}

/**
 * Returns a copy of `config` with the fields owned by `key` reset to their
 * defaults. Used when a feature card's master toggle is switched off so a
 * disabled feature can't leak stale values into the saved payload. Field
 * ownership mirrors `syncFeatureConfigOnSave` in the Configuration section.
 */
export function resetFeatureConfig(
  key: AgentFeatureKey,
  config: AgentConfigurationFeature,
): AgentConfigurationFeature {
  switch (key) {
    case "structured_output":
      return {
        ...config,
        responseFormat: DEFAULT_FEATURE_CONFIG.responseFormat,
        structuredOutputSchema: DEFAULT_FEATURE_CONFIG.structuredOutputSchema,
      };
    case "conversation_memory":
      return {
        ...config,
        messageRetentionMethod: DEFAULT_FEATURE_CONFIG.messageRetentionMethod,
        messageHistoryLimit: DEFAULT_FEATURE_CONFIG.messageHistoryLimit,
        sessionHistoryLimit: DEFAULT_FEATURE_CONFIG.sessionHistoryLimit,
      };
    case "safety_guardrails":
      return {
        ...config,
        piiMaskerEnabled: DEFAULT_FEATURE_CONFIG.piiMaskerEnabled,
        apiKeyTokenScannerEnabled: DEFAULT_FEATURE_CONFIG.apiKeyTokenScannerEnabled,
        secretDetectionEnabled: DEFAULT_FEATURE_CONFIG.secretDetectionEnabled,
      };
    case "automatic_retries":
      return { ...config, maxRetries: DEFAULT_FEATURE_CONFIG.maxRetries };
    case "api_rate_limiting":
      return { ...config, maxRequestsPerMinute: DEFAULT_FEATURE_CONFIG.maxRequestsPerMinute };
    default:
      return config;
  }
}

export const AGENT_FEATURE_LIST: AgentFeatureMeta[] = [
  // Structured output requires a valid JSON schema, so it should always open
  // the configure dialog first instead of toggling on directly.
  { key: "structured_output", title: "Structured output", actionWhenEnabled: "Configure" },
  { key: "conversation_memory", title: "Conversation memory and context", actionWhenEnabled: "Enable" },
  { key: "safety_guardrails", title: "Safety and guardrails", actionWhenEnabled: "Enable" },
  { key: "automatic_retries", title: "Automatic retries", actionWhenEnabled: "Enable" },
  { key: "api_rate_limiting", title: "API rate limiting", actionWhenEnabled: "Enable" },
];

/** A blank template agent instance (used for defaults and the manager seed). */
export function buildEmptyTemplateAgentInstance(): AgentTemplateAgentInstanceValues {
  return {
    primaryModel: "",
    primaryModelParams: { ...DEFAULT_MODEL_PARAMS },
    fallbackModel: "",
    fallbackModelParams: { ...DEFAULT_MODEL_PARAMS },
    name: "",
    description: "",
    instructions: "",
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

export function buildAgentDefaultValues(): AgentFormValues {
  return {
    configuration: "single",
    primaryModel: "",
    primaryModelParams: { ...DEFAULT_MODEL_PARAMS },
    fallbackModel: "",
    fallbackModelParams: { ...DEFAULT_MODEL_PARAMS },
    goal: "",
    instructions: "",
    role: "",
    knowledgeBases: [],
    toolsets: [],
    enabledFeatures: [...DEFAULT_ENABLED_FEATURES],
    featureConfig: { ...DEFAULT_FEATURE_CONFIG },
    team: {
      orchestrationPattern: "",
      managerName: "",
      managerModel: "",
      managerInstructions: "",
      terminationStrategyType: "maximum_iterations",
      maxIterations: DEFAULT_TEAM_MAX_ITERATIONS,
      agentIds: [],
      teamIds: [],
    },
    template: {
      selectedTemplate: null,
      agentInstances: [],
      managerInstance: buildEmptyTemplateAgentInstance(),
      orchestrationPattern: "",
    },
    requirements: {
      knowledgeBases: [],
      mcpServers: [],
    },
  };
}

import type {
  Agent,
  AgentAssociatedResources,
  AgentGuardrailsConfig,
  AgentMCPServerOverride,
  AgentMemoryContext,
  AgentRagConfig,
  AgentTeam,
  AgentTeamAssociatedResources,
  AgentTeamManager,
  AgentTeamMember,
  AgentTeamOrchestrationPolicy,
  CreateAgentRequest,
  CreateAgentTeamRequest,
  EntityRef,
  GuardrailToggle,
  MessageRetentionPolicy,
  ModelSummary,
  TerminationStrategy,
} from "@/routes/pages/agents/api/agents-config.types";

import type {
  AssociatedResource,
  SingleAgent,
  TeamAgent,
} from "../agents.types";
import type {
  AgentDetail,
  AgentKind,
  AgentProfile,
} from "../agent-detail-page/agent-detail-page.types";
import type {
  AgentAttachedKBRagConfig,
  AgentAttachedToolset,
  AgentConfigurationFeature,
  AgentFeatureKey,
  AgentFormValues,
  AgentKBStatus,
  AgentTemplateAgentInstanceValues,
} from "../create-edit/form/agent-form.consts";
import {
  buildAgentDefaultValues,
  DEFAULT_FEATURE_CONFIG,
  DEFAULT_MODEL_PARAMS,
  DEFAULT_TEAM_MAX_ITERATIONS,
} from "../create-edit/form/agent-form.consts";
import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
} from "../create-edit/form/agent-templates.consts";
import {
  buildAgentRequirementsPayload,
  orchestrationRequiresInlineManager,
} from "../create-edit/form/template-agent.utils";
import { hasBlockingRequirements } from "./agent-requirements.utils";
import { getStructuredOutputSaveError } from "./json-schema-validation";
import type { SaveAgentValues } from "../create-edit/configure-dialogs/save-agent-dialog";
import type { MessageRetentionMethod } from "../create-edit/configure-dialogs/configure-dialogs.types";

// ─── Model resolution ───────────────────────────────────────────────────────
//
// The list / detail responses now ship an `agent.model` summary alongside
// `agent.modelId` (PR #33 enrichment). We prefer the resolved name so the
// Models column reads as "GPT-4 Turbo" instead of "mdl-abc12345". When the
// enrichment is missing (older payloads, or the model row was deleted out
// from under the agent) we fall back to the id so the cell stays informative.

function pickModelLabel(model: ModelSummary | null | undefined, fallbackId?: string | null): string | null {
  if (model) {
    return model.displayName ?? model.name ?? model.id;
  }
  if (fallbackId) return fallbackId;
  return null;
}

function pickAgentModels(agent: Agent): string[] {
  const primary = pickModelLabel(agent.model, agent.modelId);
  if (primary !== null) return [primary];
  if (agent.modelClass) return [agent.modelClass];
  return [];
}

function pickTeamModels(team: AgentTeam): string[] {
  // The `/agent-teams` enrichment resolves the manager's model into
  // `manager.model` (just like `agent.model` on single agents), so prefer the
  // resolved name. Fall back to the raw `modelId`, then `modelClass`, so the
  // cell stays informative on reference-only managers or older payloads.
  const primary = pickModelLabel(team.manager?.model, team.manager?.modelId);
  if (primary !== null) return [primary];
  if (team.manager?.modelClass) return [team.manager.modelClass];
  return [];
}

// ─── Associated resources ───────────────────────────────────────────────────
//
// Prefer the API-resolved `{id, name}` pairs. When the enrichment is missing
// (older payloads), fall back to the bare ids so the row stays clickable —
// the FE label degrades from the resource's name to its id, but never
// disappears.

function fromEntityRefsKB(refs: readonly EntityRef[]): AssociatedResource[] {
  return refs.map((r) => ({ id: r.id, name: r.name, kind: "knowledge-base" }));
}

function fromEntityRefsAgent(refs: readonly EntityRef[]): AssociatedResource[] {
  return refs.map((r) => ({ id: r.id, name: r.name, kind: "agent" }));
}

function fromEntityRefsTeam(refs: readonly EntityRef[]): AssociatedResource[] {
  return refs.map((r) => ({ id: r.id, name: r.name, kind: "agent-team" }));
}

// The enrichment block is always present on fresh payloads as
// `{ knowledgeBases: [], agentTeams: [] }`, so an empty `knowledgeBases`
// array is NOT the same as "enrichment missing" — it means the server
// couldn't resolve any KB names (ids in another project/service, or deleted
// rows). Only treat a non-empty resolved list as authoritative; otherwise
// fall back to the raw `knowledgeBaseIds` so the cell still renders the ids
// instead of collapsing to "—".
function knowledgeBaseAssociations(
  enriched: AgentAssociatedResources | undefined,
  fallbackIds: readonly string[] | undefined,
): AssociatedResource[] {
  if (enriched?.knowledgeBases && enriched.knowledgeBases.length > 0) {
    return fromEntityRefsKB(enriched.knowledgeBases);
  }
  return (fallbackIds ?? []).map((id) => ({ id, name: id, kind: "knowledge-base" }));
}

// The agent read shape carries MCP toolsets only as bare `mcpServerIds` (the
// list enrichment resolves KB + team names but not MCP server names), so the
// caller passes a resolver built from `GET /mcp-servers`. When it's absent or
// can't resolve a name, we fall back to the id so the toolset still renders.
function mcpServerAssociations(
  mcpServerIds: readonly string[] | undefined,
  resolveName?: (id: string) => string | undefined,
): AssociatedResource[] {
  return (mcpServerIds ?? []).map((id) => ({
    id,
    name: resolveName?.(id) ?? id,
    kind: "mcp-server",
  }));
}

// A single agent's "associated resources" are the KBs it consumes, the MCP
// toolsets attached to it, and the teams it belongs to. The list-row column
// surfaces all three; any can be empty.
function singleAgentAssociations(
  agent: Agent,
  resolveMcpServerName?: (id: string) => string | undefined,
): AssociatedResource[] {
  return [
    ...knowledgeBaseAssociations(agent.associatedResources, agent.knowledgeBaseIds),
    ...mcpServerAssociations(agent.mcpServerIds, resolveMcpServerName),
    ...fromEntityRefsTeam(agent.associatedResources?.agentTeams ?? []),
  ];
}

// A team's members are single agents (`agents`) and/or nested team agents
// (`agentTeams`). Surface both. As with the single-agent enrichment, the block
// is always present, so an all-empty enrichment means "unresolved" — fall back
// to the raw `members[]` ids (kinded by `memberType`) so the cell still renders.
function memberAssociations(
  enriched: AgentTeamAssociatedResources | undefined,
  fallbackMembers: readonly AgentTeamMember[],
): AssociatedResource[] {
  const hasResolvedMembers =
    (enriched?.agents?.length ?? 0) > 0 || (enriched?.agentTeams?.length ?? 0) > 0;
  if (hasResolvedMembers) {
    return [
      ...fromEntityRefsAgent(enriched?.agents ?? []),
      ...fromEntityRefsTeam(enriched?.agentTeams ?? []),
    ];
  }
  return fallbackMembers.map((m) => ({
    id: m.memberId,
    name: m.memberId,
    kind: m.memberType === "team" ? "agent-team" : "agent",
  }));
}

// ─── List-row + detail mappers ──────────────────────────────────────────────

function toSingleAgent(
  agent: Agent,
  resolveMcpServerName?: (id: string) => string | undefined,
): SingleAgent {
  return {
    id: agent.id,
    name: agent.name,
    // Both lifecycle fields now ship on the payload (PR #33). They are
    // non-null on every fresh row (NOT NULL with defaults in the DB
    // migration); the legacy `?? 'Healthy'` / `?? 'draft'` guards are a
    // belt-and-braces for any payload that was serialized before the
    // migration ran.
    status: agent.status ?? "Healthy",
    models: pickAgentModels(agent),
    associatedResources: singleAgentAssociations(agent, resolveMcpServerName),
    lastUpdated: agent.updatedAt,
    deploymentStatus: agent.deploymentStatus ?? "draft",
    hasBlockingRequirements: hasBlockingRequirements(agent.requirements),
  };
}

function toTeamAgent(team: AgentTeam): TeamAgent {
  return {
    id: team.id,
    name: team.name,
    status: team.status ?? "Healthy",
    models: pickTeamModels(team),
    associatedAgents: memberAssociations(team.associatedResources, team.members),
    lastUpdated: team.updatedAt,
    deploymentStatus: team.deploymentStatus ?? "draft",
  };
}

function buildSingleAgentDetail(agent: Agent): AgentDetail {
  const profile: AgentProfile = {
    role: agent.role,
    // PR #33 introduces `goal` as a dedicated first-class field — prefer
    // it over the legacy `outcomeDescription` (which the OpenAPI now marks
    // as deprecated) but fall back to it for rows written before the
    // migration.
    goal: agent.goal ?? agent.outcomeDescription ?? "",
    instructions: agent.systemPrompt ? [agent.systemPrompt] : [],
  };

  // Mirror the create/edit Configuration section so the details page can show
  // the same feature cards read-only.
  const configuration = extractAgentFeatureConfig(agent);

  return {
    id: agent.id,
    name: agent.name,
    status: agent.status ?? "Healthy",
    deploymentStatus: agent.deploymentStatus ?? "draft",
    models: pickAgentModels(agent),
    type: "Single-agent" satisfies AgentKind,
    description: agent.description ?? "",
    labels: agent.labels ?? [],
    lastUpdatedISO: agent.updatedAt,
    createdISO: agent.createdAt,
    profile,
    // Metrics are not present in the agent config-service payload (no
    // `activeUsers` / `conversations` / `successRatePercent` field). The
    // overview metrics row is gated behind `SHOW_AGENT_METRICS_ROW` so
    // these zeroes are visible only when that flag is on.
    // TODO(api): wire to an upstream telemetry/runtime endpoint.
    metrics: { activeUsers: 0, conversations: 0, successRatePercent: 0 },
    related: {
      toolsets: agent.mcpServerIds?.length ?? 0,
      configurations: configuration.enabledFeatures.length,
      assignedKnowledgeBases:
        agent.associatedResources?.knowledgeBases.length ??
        agent.knowledgeBaseIds?.length ??
        0,
    },
    configuration,
    hasBlockingRequirements: hasBlockingRequirements(agent.requirements),
  };
}

function buildTeamAgentDetail(team: AgentTeam): AgentDetail {
  const profile: AgentProfile = {
    role: team.manager?.role ?? "",
    goal: "",
    instructions: team.manager?.systemPrompt ? [team.manager.systemPrompt] : [],
  };

  return {
    id: team.id,
    name: team.name,
    status: team.status ?? "Healthy",
    deploymentStatus: team.deploymentStatus ?? "draft",
    models: pickTeamModels(team),
    type: "Team-agent" satisfies AgentKind,
    description: team.description ?? "",
    labels: team.labels ?? [],
    lastUpdatedISO: team.updatedAt,
    createdISO: team.createdAt,
    profile,
    metrics: { activeUsers: 0, conversations: 0, successRatePercent: 0 },
    related: {
      toolsets: 0,
      configurations: 0,
      assignedKnowledgeBases: team.sharedKnowledgeBaseIds?.length ?? 0,
    },
  };
}

// Team ids follow the `agr-<8 lowercase alphanumeric>` pattern; agent ids
// are `ag-<8>`. Used by the detail page to pick the right query.
function isTeamAgentId(id: string): boolean {
  return id.startsWith("agr-");
}

// ─── Feature card builders ───────────────────────────────────────────────────
//
// Translates the flat featureConfig booleans / numbers into the structured
// card shapes the API expects. Each helper is pure so it can be unit-tested
// independently.

type GuardrailName = "pii_masker" | "content_filter" | "secret_leakage";

const HARDCODED_GUARDRAIL_IDS: Record<GuardrailName, { input: string; output: string }> = {
  pii_masker: {
    input: "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d",
    output: "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148",
  },
  content_filter: {
    input: "7d2e1a9c-4f63-4b8e-9a1d-2c7f5e8b0d36",
    output: "0f8d3b62-7e51-4a9c-b2d4-6e1a8c503f9b",
  },
  secret_leakage: {
    input: "e91b6f4a-3c08-4d2b-bf7e-5a9c1d4e8027",
    output: "92c4e87a-5b16-4f03-8d9e-1a7c2b6f4d50",
  },
};

// Builds the new top-level `guardrails` contract. Each enabled guardrail is
// sent to BOTH input_guardrails and output_guardrails with hardcoded
// stage-specific ids. When guardrails are enabled we always send
// `fail_open: false` and `log_blocked_requests: true`.
function buildGuardrails(
  cfg: AgentConfigurationFeature,
): AgentGuardrailsConfig {
  const enabledGuardrails: GuardrailName[] = [];

  if (cfg.piiMaskerEnabled) enabledGuardrails.push("pii_masker");
  if (cfg.apiKeyTokenScannerEnabled) enabledGuardrails.push("content_filter");
  if (cfg.secretDetectionEnabled) enabledGuardrails.push("secret_leakage");

  return {
    enabled: true,
    fail_open: false,
    log_blocked_requests: true,
    input_guardrails: enabledGuardrails.map((name) => ({
      guardrail_id: HARDCODED_GUARDRAIL_IDS[name].input,
      name,
      enabled: true,
    })),
    output_guardrails: enabledGuardrails.map((name) => ({
      guardrail_id: HARDCODED_GUARDRAIL_IDS[name].output,
      name,
      enabled: true,
    })),
  };
}

// Reads the saved `guardrails` contract back into a single boolean toggle. A
// guardrail counts as enabled when it appears (enabled) in either the input or
// output list — the create mapper always writes both, but we check both arrays
// defensively so a payload that only populated one side still round-trips.
function guardrailEnabled(agent: Agent, name: string): boolean {
  const matches = (rules: GuardrailToggle[] | undefined): boolean =>
    rules?.some((r) => r.name === name && r.enabled) ?? false;
  return (
    matches(agent.guardrails?.input_guardrails) ||
    matches(agent.guardrails?.output_guardrails)
  );
}

// The dialog's retention "method" and the API's retention "policy" use
// different spellings for the same concepts, so translate explicitly in both
// directions:
//   sliding_window ↔ sliding_window (drop oldest messages)
//   summarized     ↔ summarize      (rolling summary of older messages)
//   full           ↔ none           (keep the full history, no truncation)
const RETENTION_POLICY_TO_METHOD: Record<MessageRetentionPolicy, MessageRetentionMethod> = {
  sliding_window: 'sliding_window',
  summarize: 'summarized',
  // `'none'` (legacy "Full history") is no longer surfaced as a method
  // in the UI; map it back to the default sliding window when reading
  // an existing agent record.
  none: 'sliding_window',
};

function fromRetentionPolicy(policy: MessageRetentionPolicy | undefined): MessageRetentionMethod {
  return policy ? (RETENTION_POLICY_TO_METHOD[policy] ?? 'sliding_window') : 'sliding_window';
}

/**
 * Build the new unified `memoryContext` wire shape from the agent form's
 * feature config.
 *
 *   Form `messageRetentionMethod` → wire `memoryContext.type`:
 *     "sliding_window" → "window"        → emits `message_window_limit`
 *     "summarized"     → "summary_buffer" → emits `summary_token_limit`
 *
 * No "override" toggle gates the limit fields any more — the writer
 * always emits the value that matches the selected retention method,
 * so the user's typed value is the saved value and round-trips back to
 * the same input on edit.
 *
 * `session_history_limit` is intentionally not sent — it's out of scope
 * in the locked memory-context schema (deferred for a follow-up).
 *
 * Legacy `memoryType` + `memoryConfig` are derived server-side by
 * config-service's `deriveLegacyFromContext` for agent-service
 * back-compat, so the UI no longer dual-writes them.
 */
function buildMemoryContextFromForm(
  cfg: Pick<
    AgentConfigurationFeature,
    'messageRetentionMethod' | 'messageHistoryLimit' | 'summaryTokenLimit'
  >,
  enabled: boolean,
): AgentMemoryContext {
  const type: AgentMemoryContext['type'] =
    cfg.messageRetentionMethod === 'summarized' ? 'summary_buffer' : 'window';
  const payload: AgentMemoryContext = { enabled, type };

  // No "override" toggle — the value the user typed in the dialog is
  // what gets sent. The UI input ranges (`MESSAGE_HISTORY_LIMIT_RANGE`,
  // `SUMMARY_TOKEN_LIMIT_RANGE`) match the validator's accepted ranges
  // so the field is always within bounds when this writer runs.
  if (cfg.messageRetentionMethod === 'sliding_window' && cfg.messageHistoryLimit > 0) {
    payload.message_window_limit = cfg.messageHistoryLimit;
  }
  if (cfg.messageRetentionMethod === 'summarized' && cfg.summaryTokenLimit > 0) {
    payload.summary_token_limit = cfg.summaryTokenLimit;
  }

  return payload;
}

/**
 * Builds the `mcpServerConfig` map (keyed by MCP server id) from the attached
 * toolsets. Each attached toolset's selected tool names become that server's
 * `allowedTools` allow-list, scoping which tools the agent may call. The API
 * requires a `permissions` array on each override; we have no per-server
 * permission concept in the form yet, so we send an empty list (inherit).
 *
 * An attached toolset with no selected tools omits `allowedTools`, which makes
 * the agent inherit the server's full tool set.
 */
function buildMcpServerConfig(
  toolsets: readonly AgentAttachedToolset[],
): Record<string, AgentMCPServerOverride> {
  const config: Record<string, AgentMCPServerOverride> = {};
  for (const toolset of toolsets) {
    config[toolset.id] = {
      permissions: [],
      ...(toolset.tools.length > 0 && { allowedTools: toolset.tools }),
    };
  }
  return config;
}

// ─── Form ↔ API mappers ──────────────────────────────────────────────────────
//
// These live here (shared utils) because they cross the boundary between the
// API contract and the form's internal value types. Both the create-page
// (for edit pre-population) and the form's save handler (for submission) use
// them; co-locating them in a single form file would force a cross-feature
// import in the other direction.

/**
 * Maps the form's internal values plus the identity captured in the
 * SaveAgentDialog (name, description, labels) into the shape expected by
 * `POST /agents` and `PUT /agents/:id`.
 *
 * Team configuration is handled separately by a dedicated team-agent API that
 * is not yet wired; callers should guard on `formValues.configuration` before
 * calling this function.
 */
function mapFormToCreateRequest(
  formValues: AgentFormValues,
  identity: SaveAgentValues,
): CreateAgentRequest {
  const hasFeature = (key: AgentFormValues['enabledFeatures'][number]) =>
    formValues.enabledFeatures.includes(key);

  const structuredOutputEnabled = hasFeature('structured_output');
  const structuredOutputRaw = formValues.featureConfig.structuredOutputSchema;
  const structuredOutputFormat = formValues.featureConfig.responseFormat;
  if (structuredOutputEnabled) {
    const structuredOutputError = getStructuredOutputSaveError(
      structuredOutputRaw,
      structuredOutputFormat,
    );
    if (structuredOutputError) {
      throw new Error(structuredOutputError);
    }
  }
  return {
    name: identity.name,
    ...(identity.description && { description: identity.description }),
    role: formValues.role.trim() || "assistant",
    ...(formValues.goal && { goal: formValues.goal }),
    systemPrompt: formValues.instructions,
    // `primaryModel` is a config-service model UUID from the picker. Omit it
    // when unset so we never send an empty string to the UUID column (the
    // form blocks submit until a model is chosen).
    ...(formValues.primaryModel && { modelId: formValues.primaryModel }),
    temperature: formValues.primaryModelParams.temperature,
    topP: formValues.primaryModelParams.topP,
    // Top-K is optional; 0 means "leave to the provider", so omit it then.
    ...(formValues.primaryModelParams.topK > 0 && { topK: formValues.primaryModelParams.topK }),
    maxTokens: formValues.primaryModelParams.responseLength,
    // Fallback model — a single backup tried when the primary fails. Sent as a
    // one-element `fallbackModelIds` because that's the API's shape.
    ...(formValues.fallbackModel && {
      fallbackModelIds: [formValues.fallbackModel],
      fallbackModelParams: {
        temperature: formValues.fallbackModelParams.temperature,
        top_p: formValues.fallbackModelParams.topP,
        ...(formValues.fallbackModelParams.topK > 0 && {
          top_k: formValues.fallbackModelParams.topK,
        }),
        token_limit: formValues.fallbackModelParams.responseLength,
      },
    }),
    // Always send KB + MCP bindings so removing the final attached knowledge
    // base or toolset explicitly clears persisted backend associations instead
    // of being treated as "field unchanged" by partial update semantics.
    knowledgeBaseIds: formValues.knowledgeBases.map((kb) => kb.id),
    ragConfig: Object.fromEntries(
      formValues.knowledgeBases.map((kb) => {
        const cfg = kb.ragConfig;
        const entry: AgentRagConfig = {
          topK: cfg?.topKChunks ?? 5,
          similarityThreshold: cfg?.similarity ?? 0.5,
          searchMode: 'hybrid',
          rerankingEnabled: cfg?.rerankingEnabled ?? true,
          similarityThresholdEnabled: cfg?.similarityThresholdEnabled ?? true,
        };
        return [kb.id, entry];
      }),
    ),
    mcpServerIds: formValues.toolsets.map((t) => t.id),
    mcpServerConfig: buildMcpServerConfig(formValues.toolsets),
    // Feature cards
    ...(hasFeature('output_response') && {
      outputResponse: {
        enabled: true,
        ...(formValues.featureConfig.outputResponseExample.trim() && {
          example_response: formValues.featureConfig.outputResponseExample,
        }),
      },
    }),
    // Always send structuredOutput so disabling it on edit explicitly clears
    // the previously-saved value (partial-update would otherwise leave it
    // stale). When enabled, carry the format + raw box string as outputSchema.
    structuredOutput: hasFeature('structured_output')
      ? {
          enabled: true,
          responseFormat: structuredOutputFormat,
          outputSchema: structuredOutputRaw,
        }
      : { enabled: false },
    // Always send memory/retries/rate-limiting blocks so toggling a card off
    // persists `enabled=false` instead of leaving stale backend state.
    // New unified MemoryContext wire shape (post Stages 1-4):
    //   "sliding_window" → type: "window",         message_window_limit
    //   "summarized"     → type: "summary_buffer", summary_token_limit
    // Legacy `memoryType` + `memoryConfig` are derived server-side.
    memoryContext: buildMemoryContextFromForm(
      formValues.featureConfig,
      hasFeature('conversation_memory'),
    ),
    ...(hasFeature('safety_guardrails') && {
      guardrails: buildGuardrails(formValues.featureConfig),
    }),
    retries: {
      enabled: hasFeature('automatic_retries'),
      max_retries: formValues.featureConfig.maxRetries,
    },
    rateLimiting: {
      enabled: hasFeature('api_rate_limiting'),
      max_requests_per_minute: formValues.featureConfig.maxRequestsPerMinute,
    },
    ...(identity.labels.length > 0 && { labels: identity.labels }),
    // Always send both arrays so removing the final unconfigured KB/MCP clears
    // the backend JSONB field instead of leaving stale requirements behind.
    requirements: {
      knowledgeBases: formValues.requirements.knowledgeBases,
      mcpServers: formValues.requirements.mcpServers,
    },
  };
}

const TEAM_ORCHESTRATION_POLICIES: readonly AgentTeamOrchestrationPolicy[] = [
  "coordinate",
  "sequential",
  "concurrent",
  "route",
  "collaborate",
];

/**
 * Maps the Instructions UI field onto the backend's ``manager.systemPrompt``.
 * Trimmed; the empty string is returned when the user left the field blank so
 * the caller can decide to omit ``systemPrompt`` from the payload.
 */
function buildManagerSystemPrompt(instructions: string): string {
  return instructions.trim();
}

/**
 * Maps the team-agent form values plus the SaveAgentDialog identity into the
 * shape expected by `POST /agent-teams` and `PUT /agent-teams/:id`.
 *
 * - `team.agentIds` / `team.teamIds` become the required `members[]` (the
 *   server rejects an empty members list — callers should guard before save).
 * - When `orchestrationPattern` is "coordinate" (→ MAF magentic) or "route"
 *   (→ MAF triage), the inline manager config (`managerModel`,
 *   `managerInstructions`) is sent as `manager: { modelId, systemPrompt }`.
 *   `systemPrompt` is the trimmed Instructions value. A manager is omitted
 *   entirely for any other pattern or when no model is selected.
 * - `team.orchestrationPattern` maps to `orchestrationPolicy` only when it is
 *   one of the server-supported policies, otherwise it is omitted so the
 *   server falls back to its default.
 */
function buildTeamMembers(
  agentIds: readonly string[],
  teamIds: readonly string[],
): AgentTeamMember[] {
  return [
    ...agentIds.map((memberId) => ({ memberType: "agent" as const, memberId })),
    ...teamIds.map((memberId) => ({ memberType: "team" as const, memberId })),
  ];
}

function resolveOrchestrationPolicy(
  pattern: string,
): AgentTeamOrchestrationPolicy | undefined {
  return TEAM_ORCHESTRATION_POLICIES.find((policy) => policy === pattern);
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Builds the team `terminationStrategy` payload from the Coordinate form fields.
 * Only "maximum_iterations" is offered today; the strategy type is threaded
 * through so a future keyword/timeout option needs no caller change here. The
 * iteration cap falls back to the form default when unset/non-positive.
 */
function buildTeamTerminationStrategy(
  strategyType: string,
  maxIterations: number,
): TerminationStrategy | undefined {
  if (strategyType !== "maximum_iterations") return undefined;
  const iterations =
    Number.isFinite(maxIterations) && maxIterations > 0
      ? Math.round(maxIterations)
      : DEFAULT_TEAM_MAX_ITERATIONS;
  return { type: "maximum_iterations", maximum_iterations: iterations };
}

type MapTeamRequestOptions = {
  /** On PUT, merge with the loaded manager JSONB so fields the form does not edit survive. */
  existingManager?: AgentTeamManager | null;
};

/** GET enrichment only — never sent on create/update. */
function omitReadOnlyManagerFields(manager: AgentTeamManager): AgentTeamManager {
  const rest = { ...manager };
  delete rest.model;
  return rest;
}

/** Reference managers round-trip as `{ agent_id }` only. */
function preserveExistingTeamManager(existingManager: AgentTeamManager): AgentTeamManager {
  const agentId = existingManager.agent_id?.trim();
  if (agentId) {
    return { agent_id: agentId };
  }
  return omitReadOnlyManagerFields(existingManager);
}

/**
 * Inline edit merge: carry persisted inline fields (role, temperature, …) but
 * never `agent_id` — mixing reference + inline keys is an invalid manager shape.
 */
function mergeInlineTeamManager(
  managerFromForm: AgentTeamManager,
  existingManager: AgentTeamManager,
): AgentTeamManager {
  const existingPersisted = { ...existingManager };
  delete existingPersisted.agent_id;
  delete existingPersisted.model;
  return { ...existingPersisted, ...managerFromForm };
}

function buildTeamManagerConfig(
  managerFromForm: AgentTeamManager | undefined,
  existingManager: AgentTeamManager | null | undefined,
  requiresManager: boolean,
): AgentTeamManager | undefined {
  if (managerFromForm) {
    return existingManager
      ? mergeInlineTeamManager(managerFromForm, existingManager)
      : managerFromForm;
  }
  if (existingManager && requiresManager) {
    return preserveExistingTeamManager(existingManager);
  }
  return undefined;
}

function mapFormToCreateTeamRequest(
  formValues: AgentFormValues,
  identity: SaveAgentValues,
  options?: MapTeamRequestOptions,
): CreateAgentTeamRequest {
  const { team } = formValues;
  const hasFeature = (key: AgentFeatureKey): boolean =>
    formValues.enabledFeatures.includes(key);

  const members = buildTeamMembers(team.agentIds, team.teamIds);
  const orchestrationPolicy = resolveOrchestrationPolicy(team.orchestrationPattern);

  // ``coordinate`` (→ MAF magentic) and ``route`` (→ MAF triage) both consume
  // the inline manager block: magentic uses it as the autonomous planner,
  // triage uses it as the start-agent / router. Other policies (sequential,
  // concurrent, collaborate) ignore the block, so we omit it to keep the
  // payload tight.
  const requiresManager =
    orchestrationPolicy === "coordinate" || orchestrationPolicy === "route";
  const managerName = trimText(team.managerName);
  const managerModelId = trimText(team.managerModel);
  const managerSystemPrompt = buildManagerSystemPrompt(team.managerInstructions);
  // Backend requires `name` for inline managers (no agent_id reference).
  const managerFromForm =
    requiresManager && managerModelId
      ? {
          ...(managerName && { name: managerName }),
          modelId: managerModelId,
          ...(managerSystemPrompt && { systemPrompt: managerSystemPrompt }),
        }
      : undefined;
  const managerConfig = buildTeamManagerConfig(
    managerFromForm,
    options?.existingManager,
    requiresManager,
  );

  // Termination strategy is Coordinate-only (the Magentic planner needs an
  // iteration ceiling). Other policies terminate structurally, so we omit it.
  const terminationStrategy =
    orchestrationPolicy === "coordinate"
      ? buildTeamTerminationStrategy(team.terminationStrategyType, team.maxIterations)
      : undefined;

  // Team-level memoryContext mirrors the agent mapper. The team's runtime
  // (MAF on team-invoke) reads team.memoryContext; member agents'
  // memory blocks are intentionally not merged per the locked precedence.
  // config-service derives legacy memoryType + memoryConfig from this
  // server-side, so the UI only sends the new unified shape.
  const memoryContext = buildMemoryContextFromForm(
    formValues.featureConfig,
    hasFeature("conversation_memory"),
  );

  return {
    name: identity.name,
    ...(identity.description && { description: identity.description }),
    ...(orchestrationPolicy && { orchestrationPolicy }),
    ...(managerConfig && { manager: managerConfig }),
    ...(terminationStrategy && { terminationStrategy }),
    members,
    memoryContext,
    ...(identity.labels.length > 0 && { labels: identity.labels }),
  };
}

/**
 * Builds the inline team manager from the configured manager instance plus the
 * template-level fields (name, role). The server requires
 * `name` + `systemPrompt` + (`modelId` | `modelClass`) for an inline manager,
 * so we only return one once those are present; otherwise the `manager` key is
 * omitted so we never send a manager the server will reject.
 */
function buildTemplateManager(
  instance: AgentTemplateAgentInstanceValues | undefined,
  template: AgentTemplateDefinition | null | undefined,
  identity: SaveAgentValues,
): AgentTeamManager | undefined {
  if (!instance) return undefined;

  const name = trimText(instance.name) || trimText(template?.name) || trimText(identity.name);
  const systemPrompt = trimText(instance.instructions);
  const modelId = trimText(instance.primaryModel);

  if (!name || !systemPrompt || !modelId) return undefined;

  return {
    name,
    ...(trimText(template?.role) && { role: trimText(template?.role) }),
    systemPrompt,
    modelId,
    // GAP-M1: omit manager params — runtime uses defaults when absent
    // temperature: instance.primaryModelParams.temperature,
    // maxTokens: instance.primaryModelParams.responseLength,
  };
}

/**
 * Maps a single template agent instance (+ its catalog definition) into the
 * `POST /agents` body. Each member agent is created first; its returned id then
 * becomes a team member. KBs / toolsets / features come from the per-agent
 * configuration dialog; `role` comes from the catalog definition.
 */
function mapTemplateAgentInstanceToCreateRequest(
  instance: AgentTemplateAgentInstanceValues,
  agentDef: AgentTemplateAgentDefinition,
  identity: Pick<SaveAgentValues, "labels">,
): CreateAgentRequest {
  const name = instance.name.trim() || agentDef.name;

  const merged: AgentFormValues = {
    ...buildAgentDefaultValues(),
    configuration: "single",
    primaryModel: instance.primaryModel,
    primaryModelParams: instance.primaryModelParams,
    fallbackModel: instance.fallbackModel,
    fallbackModelParams: instance.fallbackModelParams,
    goal: name,
    instructions: instance.instructions,
    knowledgeBases: instance.knowledgeBases,
    toolsets: instance.toolsets,
    enabledFeatures: instance.enabledFeatures,
    featureConfig: instance.featureConfig,
  };

  const request = mapFormToCreateRequest(
    merged,
    {
      name,
      description: instance.description?.trim() ?? "",
      labels: identity.labels,
    },
  );
  // Unsatisfied template KB / toolset requirements are persisted as placeholder
  // `requirements` so a draft can be saved before they are bound; required ones
  // block deploy server-side until resolved.
  const requirements = buildAgentRequirementsPayload(agentDef, instance);
  return {
    ...request,
    role: agentDef.role?.trim() || request.role,
    ...(requirements && { requirements }),
  };
}

/**
 * Maps the `from_template` form values plus the SaveAgentDialog identity into
 * the shape expected by `POST /agent-teams`.
 *
 * Template creation produces an *agent team*:
 * - Member agents (`template.agentInstances[]`) are created first via
 *   `POST /agents`; their returned ids are passed in `memberAgentIds` and
 *   become the team `members[]` (alongside any agents/teams the user added in
 *   the "Select agents" box).
 * - `manager` is built inline from the configured manager agent
 *   (`template.managerInstance`) plus the template name/role.
 * - `orchestrationPolicy` comes from the editable orchestration dropdown.
 *
 * KBs / toolsets live on the individual member agents, so they are NOT mapped
 * to team-level shared resources here.
 */
function mapTemplateToCreateTeamRequest(
  formValues: AgentFormValues,
  identity: SaveAgentValues,
  memberAgentIds: readonly string[] = [],
): CreateAgentTeamRequest {
  const { team, template } = formValues;

  const members = buildTeamMembers([...memberAgentIds, ...team.agentIds], team.teamIds);
  const orchestrationPolicy = resolveOrchestrationPolicy(template.orchestrationPattern);
  const manager = orchestrationRequiresInlineManager(orchestrationPolicy)
    ? buildTemplateManager(
        template.managerInstance,
        template.selectedTemplate,
        identity,
      )
    : undefined;

  const terminationStrategy =
    orchestrationPolicy === "coordinate"
      ? buildTeamTerminationStrategy(team.terminationStrategyType, team.maxIterations)
      : undefined;

  return {
    name: identity.name,
    ...(identity.description && { description: identity.description }),
    ...(orchestrationPolicy && { orchestrationPolicy }),
    ...(manager && { manager }),
    ...(terminationStrategy && { terminationStrategy }),
    members,
    ...(identity.labels.length > 0 && { labels: identity.labels }),
  };
}

/**
 * Maps an `Agent` API response back into `Partial<AgentFormValues>` so the
 * edit page can pre-populate the form without a separate fetch layer.
 *
 * Enriched fields (e.g. `agent.model`) are ignored intentionally — the form
 * works with IDs (modelId, knowledgeBaseIds) not resolved summaries.
 */
/**
 * Derives the enabled feature toggles and the flat `featureConfig` values from
 * an agent's saved card payloads (`memoryContext`, `guardrails`, `retries`,
 * etc.). Shared by `mapAgentToFormValues` (editable cards on the create/edit
 * page) and `buildSingleAgentDetail` (read-only cards on the details page) so
 * both surfaces interpret the same payload identically.
 */
function extractAgentFeatureConfig(agent: Agent): {
  enabledFeatures: AgentFeatureKey[];
  featureConfig: AgentConfigurationFeature;
} {
  const enabledFeatures: AgentFeatureKey[] = [];
  if (agent.outputResponse?.enabled) enabledFeatures.push('output_response');
  if (agent.structuredOutput?.enabled) enabledFeatures.push('structured_output');
  if (agent.memoryContext?.enabled) enabledFeatures.push('conversation_memory');
  if (agent.guardrails &&
      ((agent.guardrails.input_guardrails?.length ?? 0) > 0 ||
       (agent.guardrails.output_guardrails?.length ?? 0) > 0)) {
    enabledFeatures.push('safety_guardrails');
  }
  if (agent.retries?.enabled) enabledFeatures.push('automatic_retries');
  if (agent.rateLimiting?.enabled) enabledFeatures.push('api_rate_limiting');

  // Read either shape of `memoryContext` for back-compat:
  //   - New: { type: 'window'|'summary_buffer', message_window_limit, summary_token_limit }
  //   - Legacy: { message_retention_policy, message_history_limit, session_history_limit }
  // Stage 4's backend normalization means new saves write the new shape;
  // existing rows may still be the legacy shape until re-saved.
  const memCtx = (agent.memoryContext ?? {}) as Record<string, unknown>;
  const newType = typeof memCtx.type === 'string' ? (memCtx.type as string) : undefined;
  const newWindowLimit =
    typeof memCtx.message_window_limit === 'number' ? memCtx.message_window_limit : undefined;
  const newSummaryLimit =
    typeof memCtx.summary_token_limit === 'number' ? memCtx.summary_token_limit : undefined;

  const messageRetentionMethod: MessageRetentionMethod = newType === 'summary' || newType === 'summary_buffer'
    ? 'summarized'
    : newType === 'window' || newType === 'none'
      ? 'sliding_window'
      : fromRetentionPolicy(agent.memoryContext?.message_retention_policy);

  const featureConfig: AgentConfigurationFeature = {
    ...DEFAULT_FEATURE_CONFIG,
    messageRetentionMethod,
    // No "override" toggle — the form just stores whatever the backend
    // persisted (or the default when the field is absent). The dialog
    // input is unconditional, so this value round-trips straight through.
    messageHistoryLimit:
      newWindowLimit ??
      agent.memoryContext?.message_history_limit ??
      DEFAULT_FEATURE_CONFIG.messageHistoryLimit,
    sessionHistoryLimit:
      agent.memoryContext?.session_history_limit ?? DEFAULT_FEATURE_CONFIG.sessionHistoryLimit,
    summaryTokenLimit: newSummaryLimit ?? DEFAULT_FEATURE_CONFIG.summaryTokenLimit,
    maxRetries: agent.retries?.max_retries ?? DEFAULT_FEATURE_CONFIG.maxRetries,
    piiMaskerEnabled: guardrailEnabled(agent, 'pii_masker'),
    apiKeyTokenScannerEnabled: guardrailEnabled(agent, 'content_filter'),
    secretDetectionEnabled: guardrailEnabled(agent, 'secret_leakage'),
    outputResponseExample:
      agent.outputResponse?.example_response ?? DEFAULT_FEATURE_CONFIG.outputResponseExample,
    responseFormat: agent.structuredOutput?.responseFormat ?? DEFAULT_FEATURE_CONFIG.responseFormat,
    structuredOutputSchema:
      agent.structuredOutput?.outputSchema ??
      (agent.structuredOutput?.json_schema
        ? JSON.stringify(agent.structuredOutput.json_schema, null, 2)
        : DEFAULT_FEATURE_CONFIG.structuredOutputSchema),
    maxRequestsPerMinute:
      agent.rateLimiting?.max_requests_per_minute ?? DEFAULT_FEATURE_CONFIG.maxRequestsPerMinute,
  };

  return { enabledFeatures, featureConfig };
}

function mapAgentToFormValues(agent: Agent): Partial<AgentFormValues> {
  // `modelId` is a config-service model UUID. Pass it through verbatim; the
  // picker resolves it to a label once the project models load.
  const primaryModel = agent.modelId ?? "";

  // Restore the feature toggles + values from the saved card states.
  const { enabledFeatures, featureConfig } = extractAgentFeatureConfig(agent);

  const fallbackModel = agent.fallbackModelIds?.[0] ?? "";

  return {
    configuration: "single",
    primaryModel,
    primaryModelParams: {
      temperature: agent.temperature ?? DEFAULT_MODEL_PARAMS.temperature,
      topP: agent.topP ?? DEFAULT_MODEL_PARAMS.topP,
      topK: agent.topK ?? DEFAULT_MODEL_PARAMS.topK,
      responseLength: agent.maxTokens ?? DEFAULT_MODEL_PARAMS.responseLength,
    },
    ...(fallbackModel && {
      fallbackModel,
      fallbackModelParams: {
        temperature: agent.fallbackModelParams?.temperature ?? DEFAULT_MODEL_PARAMS.temperature,
        topP: agent.fallbackModelParams?.top_p ?? DEFAULT_MODEL_PARAMS.topP,
        topK: agent.fallbackModelParams?.top_k ?? DEFAULT_MODEL_PARAMS.topK,
        responseLength: agent.fallbackModelParams?.token_limit ?? DEFAULT_MODEL_PARAMS.responseLength,
      },
    }),
    goal: agent.goal ?? agent.outcomeDescription ?? "",
    instructions: agent.systemPrompt ?? "",
    role: agent.role ?? "",
    knowledgeBases: (agent.knowledgeBaseIds ?? []).map((id) => {
      const kbRag = agent.ragConfig?.[id];
      const restoredRagConfig: AgentAttachedKBRagConfig | undefined = kbRag
        ? {
            topKChunks: kbRag.topK,
            rerankingEnabled: kbRag.rerankingEnabled ?? true,
            similarityThresholdEnabled: kbRag.similarityThresholdEnabled ?? true,
            similarity: kbRag.similarityThreshold,
          }
        : undefined;
      return {
        id,
        name: id,
        status: "healthy" as AgentKBStatus,
        tier: "",
        remaining: "",
        fileUsage: kbRag ? `Top K: ${kbRag.topK}` : "",
        ragConfig: restoredRagConfig,
      };
    }),
    toolsets: (agent.mcpServerIds ?? []).map((id) => ({
      id,
      name: id,
      status: "healthy" as AgentKBStatus,
      account: "",
      authMethod: "",
      // Restore the per-server tool allow-list saved in `mcpServerConfig`.
      // Absent config (older payloads, or "inherit all") restores no
      // explicit selection.
      tools: agent.mcpServerConfig?.[id]?.allowedTools ?? [],
    })),
    enabledFeatures,
    featureConfig,
    requirements: {
      knowledgeBases: agent.requirements?.knowledgeBases ?? [],
      mcpServers: agent.requirements?.mcpServers ?? [],
    },
  };
}

/**
 * Maps an `AgentTeam` API response back into `Partial<AgentFormValues>` so the
 * edit page can pre-populate the form without a separate fetch layer.
 *
 * Manager inline config (`modelId`, `systemPrompt`) is restored from the API
 * response into `managerModel` / `managerInstructions`. A reference-only
 * manager (agent_id only, no inline config) leaves all fields empty.
 */
function mapTeamToFormValues(team: AgentTeam): Partial<AgentFormValues> {
  const agentIds = team.members
    .filter((m) => m.memberType === "agent")
    .map((m) => m.memberId);
  const teamIds = team.members
    .filter((m) => m.memberType === "team")
    .map((m) => m.memberId);

  // Restore the iteration cap from a maximum_iterations strategy; any other
  // (or absent) strategy leaves the default so the Coordinate slider is sane.
  const maxIterations =
    team.terminationStrategy?.type === "maximum_iterations"
      ? team.terminationStrategy.maximum_iterations
      : DEFAULT_TEAM_MAX_ITERATIONS;

  // Restore the memory card. Same dual-shape reader as the agent path:
  // prefer the new MemoryContext fields (`type`, `message_window_limit`,
  // `summary_token_limit`); fall back to the legacy AgentMemoryContext
  // fields (`message_retention_policy`, `message_history_limit`) for
  // teams that haven't been re-saved since Stage 4 shipped.
  const memCtx = (team.memoryContext ?? {}) as Record<string, unknown>;
  const newType = typeof memCtx.type === "string" ? (memCtx.type as string) : undefined;
  const newWindowLimit =
    typeof memCtx.message_window_limit === "number" ? memCtx.message_window_limit : undefined;
  const newSummaryLimit =
    typeof memCtx.summary_token_limit === "number" ? memCtx.summary_token_limit : undefined;

  const enabledFeatures: AgentFeatureKey[] = [];
  if (team.memoryContext?.enabled) enabledFeatures.push("conversation_memory");

  const messageRetentionMethod: MessageRetentionMethod =
    newType === "summary" || newType === "summary_buffer"
      ? "summarized"
      : newType === "window" || newType === "none"
        ? "sliding_window"
        : fromRetentionPolicy(team.memoryContext?.message_retention_policy);

  const featureConfig: AgentConfigurationFeature = {
    ...DEFAULT_FEATURE_CONFIG,
    messageRetentionMethod,
    // No "override" toggle (parallel to mapAgentToFeatureConfig): the
    // stored value round-trips straight to the form input.
    messageHistoryLimit:
      newWindowLimit ??
      team.memoryContext?.message_history_limit ??
      DEFAULT_FEATURE_CONFIG.messageHistoryLimit,
    sessionHistoryLimit:
      team.memoryContext?.session_history_limit ?? DEFAULT_FEATURE_CONFIG.sessionHistoryLimit,
    summaryTokenLimit: newSummaryLimit ?? DEFAULT_FEATURE_CONFIG.summaryTokenLimit,
  };

  return {
    configuration: "team",
    enabledFeatures,
    featureConfig,
    team: {
      orchestrationPattern: team.orchestrationPolicy ?? "",
      managerName: team.manager?.name ?? "",
      managerModel: team.manager?.modelId ?? "",
      managerInstructions: team.manager?.systemPrompt ?? "",
      terminationStrategyType: "maximum_iterations",
      maxIterations,
      agentIds,
      teamIds,
    },
  };
}

export {
  buildSingleAgentDetail,
  buildTeamAgentDetail,
  isTeamAgentId,
  mapAgentToFormValues,
  mapFormToCreateRequest,
  mapFormToCreateTeamRequest,
  mapTemplateAgentInstanceToCreateRequest,
  mapTemplateToCreateTeamRequest,
  mapTeamToFormValues,
  toSingleAgent,
  toTeamAgent,
};

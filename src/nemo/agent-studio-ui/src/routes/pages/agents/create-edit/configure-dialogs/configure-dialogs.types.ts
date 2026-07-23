// Shared types for every "Configure X" dialog in this folder.
// Per-dialog props types are declared inline in their `.tsx` file
// (matches the add-tool / edit-tool convention).

type ToolsetHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown"

type ToolsetTool = {
  id: string
  name: string
  description: string
}

/**
 * A toolset option offered in the dropdown. The dialog reads `status`,
 * `labels`, and `tools` from the chosen option to render the meta strip
 * and populate the tools table. Replace the mocked catalog in
 * `configure-dialogs.consts.ts` with the real list once the backend
 * /toolsets endpoint is wired up.
 */
type ToolsetOption = {
  id: string
  name: string
  /** Server-level description (from the MCP servers list), shown in the meta. */
  description?: string
  status: ToolsetHealthStatus
  /** Auth type from the MCP server config, displayed in the card's Authentication type row. */
  authType?: string
  labels: string[]
  tools: ToolsetTool[]
  /**
   * The server's tool allow-list (raw `allowedTools` from the MCP server
   * record). `undefined` means the server imposes no restriction (every live
   * tool is allowed); an array means only those tool names are permitted. The
   * picker intersects the live tool catalog with this so an agent can only
   * select tools the server actually allows.
   */
  allowedToolNames?: string[]
}

/** Saved toolset-configuration shape lifted up to the parent on save. */
type ToolsetConfig = {
  toolsetId: string
  selectedToolIds: string[]
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

type KnowledgeBaseAvailability = "available" | "indexing" | "unavailable" | "unknown"

/**
 * A knowledge base option offered in the dropdown. The dialog reads
 * `status` and `labels` from the chosen option to render the meta strip.
 */
type KnowledgeBaseOption = {
  id: string
  name: string
  status: KnowledgeBaseAvailability
  labels: string[]
}

/**
 * Saved knowledge-base configuration. `similarity` is only meaningful
 * when `similarityThresholdEnabled` is true; the parent should ignore it
 * otherwise.
 */
type KnowledgeBaseConfig = {
  knowledgeBaseId: string
  topKChunks: number
  rerankingEnabled: boolean
  similarityThresholdEnabled: boolean
  similarity: number
}

// ---------------------------------------------------------------------------
// Output response
// ---------------------------------------------------------------------------

/**
 * Saved output-response configuration. `exampleResponse` is kept in the
 * draft even when `enabled` is false so re-enabling the toggle restores
 * the user's last-typed example; consumers should only treat the example
 * as meaningful when `enabled === true`.
 */
type OutputResponseConfig = {
  enabled: boolean
  exampleResponse: string
}

// ---------------------------------------------------------------------------
// Structured output (JSON schema)
// ---------------------------------------------------------------------------

/** Response format for structured output. */
type StructuredOutputResponseFormat = "text" | "json_object"

/**
 * Saved structured-output configuration. `responseFormat` selects whether
 * `schema` holds a JSON schema (`json_object`) or free-form text guidelines
 * (`text`). `schema` is the raw text the user typed — keeping it as a string
 * (rather than parsing eagerly) lets the dialog preserve formatting, trailing
 * whitespace, and partially-typed content while the user is editing. For
 * `json_object` the dialog guarantees the string parses as valid JSON before
 * allowing Save; for `text` it only requires non-empty content.
 */
type StructuredOutputConfig = {
  enabled: boolean
  responseFormat: StructuredOutputResponseFormat
  schema: string
}

// ---------------------------------------------------------------------------
// Conversation memory and context
// ---------------------------------------------------------------------------

/**
 * UI-facing strategies for trimming long chat histories. Two options
 * exposed in the dialog:
 *
 *   - `sliding_window` → backend `memoryContext.type = 'window'`
 *   - `summarized`     → backend `memoryContext.type = 'summary_buffer'`
 *
 * (The legacy `'full'` option has been removed — it was a production
 * footgun because long sessions always overflow the model's context.)
 */
type MessageRetentionMethod = "sliding_window" | "summarized"

/**
 * Saved conversation-memory configuration. The dialog shows whichever
 * limit field matches the selected retention method directly — no
 * separate "override" toggle. Whatever value the user enters is the
 * value that gets sent on save.
 *
 * Field semantics:
 *   - `messageHistoryLimit` — sent as `memoryContext.message_window_limit`
 *     when `retentionMethod === 'sliding_window'`.
 *   - `summaryTokenLimit`   — sent as `memoryContext.summary_token_limit`
 *     when `retentionMethod === 'summarized'`.
 *   - `sessionHistoryLimit` — out of scope in the current memory-context
 *     wire; kept in the draft only for parity with older saves.
 */
type ConversationMemoryConfig = {
  retentionMethod: MessageRetentionMethod
  messageHistoryLimit: number
  sessionHistoryLimit: number
  summaryTokenLimit: number
}

// ---------------------------------------------------------------------------
// Safety and guardrails
// ---------------------------------------------------------------------------

/**
 * Saved safety/guardrails configuration. Each field maps to a single
 * toggle in the dialog; all three are independent and ship to the
 * backend together. No conditional fields here — this is intentionally
 * a flat "feature flags" shape.
 */
type SafetyGuardrailsConfig = {
  piiMaskerEnabled: boolean
  apiKeyTokenScannerEnabled: boolean
  secretDetectionEnabled: boolean
}

// ---------------------------------------------------------------------------
// Automatic retries
// ---------------------------------------------------------------------------

/**
 * Saved automatic-retries configuration. `maxRetries` is preserved in
 * the draft even when `enabled` is false so flipping the toggle back on
 * restores the prior value; consumers should only treat the field as
 * meaningful when `enabled === true`.
 */
type AutomaticRetriesConfig = {
  enabled: boolean
  maxRetries: number
}

// ---------------------------------------------------------------------------
// Agent rate limiting
// ---------------------------------------------------------------------------

/**
 * Saved rate-limiting configuration. Same off-preserves-value contract
 * as AutomaticRetriesConfig — see comment above.
 */
type AgentRateLimitingConfig = {
  enabled: boolean
  maxRequestsPerMinute: number
}

export type {
  ToolsetHealthStatus,
  ToolsetTool,
  ToolsetOption,
  ToolsetConfig,
  KnowledgeBaseAvailability,
  KnowledgeBaseOption,
  KnowledgeBaseConfig,
  OutputResponseConfig,
  StructuredOutputResponseFormat,
  StructuredOutputConfig,
  MessageRetentionMethod,
  ConversationMemoryConfig,
  SafetyGuardrailsConfig,
  AutomaticRetriesConfig,
  AgentRateLimitingConfig,
}

import type {
  AgentRateLimitingConfig,
  AutomaticRetriesConfig,
  ConversationMemoryConfig,
  KnowledgeBaseAvailability,
  KnowledgeBaseConfig,
  MessageRetentionMethod,
  OutputResponseConfig,
  SafetyGuardrailsConfig,
  StructuredOutputConfig,
  ToolsetConfig,
  ToolsetHealthStatus,
} from "./configure-dialogs.types"

// TODO(i18n): externalize once the i18n bundle is wired up.
const TOOLSET_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure toolset details",

  TOOLSET_SECTION_TITLE: "Toolset details",
  TOOLSET_SECTION_SUBTITLE:
    "Select a toolset and its tools to perform specific tasks for the agent.",

  TOOLSET_LABEL: "Toolset",
  TOOLSET_PLACEHOLDER: "$toolset-name",

  STATUS_LABEL: "Status",
  LABELS_LABEL: "Labels",
  DESCRIPTION_LABEL: "Description",

  TOOLS_SECTION_TITLE: "Tools",
  TOOLS_SECTION_SUBTITLE: "Select tools to perform specific tasks for the agent.",

  TOOLS_SELECTION_COUNT_TEMPLATE: "{selected} out of {total} tools are selected.",
  TOOLS_TABLE_TITLE_TEMPLATE: "Tools ({count})",

  TOOLS_COLUMN_NAME: "Name",
  TOOLS_COLUMN_DESCRIPTION: "Description",
  TOOLS_SEARCH_PLACEHOLDER: "Search tools",
  TOOLS_SEARCH_ARIA_LABEL: "Search tools",
  TOOLS_SELECT_ALL_ARIA_LABEL: "Select all tools",
  TOOLS_SELECT_ROW_ARIA_LABEL_TEMPLATE: "Select tool {name}",

  TOOLSET_REQUIRED_ERROR: "Toolset is required",
  NO_TOOLS_SELECTED_ERROR: "Select at least one tool",
  NO_TOOLS_AVAILABLE_MESSAGE: "This toolset exposes no tools.",
  NO_TOOLS_MATCH_SEARCH_MESSAGE: "No tools match your search.",
  SELECT_TOOLSET_FIRST_MESSAGE: "Select a toolset to see its available tools.",
  TOOLS_LOADING_MESSAGE: "Loading tools…",
  TOOLS_ERROR_MESSAGE:
    "Couldn't load this toolset's live tools. Showing its allowed tools instead.",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

const TOOLSET_STATUS_LABEL: Record<ToolsetHealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
}

const DEFAULT_TOOLSET_CONFIG: ToolsetConfig = {
  toolsetId: "",
  selectedToolIds: [],
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

// TODO(i18n): externalize once the i18n bundle is wired up.
const KNOWLEDGE_BASE_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure knowledge base",

  KB_SECTION_TITLE: "Knowledge base details",
  KB_SECTION_SUBTITLE: "Select a knowledge base for context of the agent.",

  KB_LABEL: "Knowledge base",
  KB_PLACEHOLDER: "$kb-name",

  STATUS_LABEL: "Status",
  LABELS_LABEL: "Labels",

  VERSION_LABEL: "Version",
  VERSION_PLACEHOLDER: "Select a version",

  TOP_K_TITLE: "Top K chunks",
  TOP_K_DESCRIPTION:
    'Determines the "breadth" of the search. Higher values provide more context but may dilute the answer.',

  RERANKING_TITLE: "Reranking",
  RERANKING_DESCRIPTION: "Improve relevance with reranking model.",
  RERANKING_TOGGLE_LABEL: "Enable reranking",

  SIMILARITY_THRESHOLD_TITLE: "Similarity threshold",
  SIMILARITY_THRESHOLD_DESCRIPTION:
    "Determine when a file version is considered changed. New versions that meet this similarity score are re-indexed.",
  SIMILARITY_THRESHOLD_TOGGLE_LABEL: "Enable similarity threshold",
  SIMILARITY_LABEL: "Similarity",

  KB_REQUIRED_ERROR: "Knowledge base is required",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

const KNOWLEDGE_BASE_STATUS_LABEL: Record<KnowledgeBaseAvailability, string> = {
  available: "Available",
  indexing: "Indexing",
  unavailable: "Unavailable",
  unknown: "Unknown",
}

const TOP_K_RANGE = { min: 1, max: 20, step: 1 } as const
const SIMILARITY_RANGE = { min: 0, max: 1, step: 0.05 } as const

const DEFAULT_KNOWLEDGE_BASE_CONFIG: KnowledgeBaseConfig = {
  knowledgeBaseId: "",
  topKChunks: 5,
  rerankingEnabled: true,
  similarityThresholdEnabled: true,
  similarity: 0.5,
}

// ---------------------------------------------------------------------------
// Output response
// ---------------------------------------------------------------------------

// TODO(i18n): externalize once the i18n bundle is wired up.
const OUTPUT_RESPONSE_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure output response",
  DESCRIPTION:
    "Set the agent's response style by entering plain text examples of the format you expect.",

  TOGGLE_LABEL: "Enable output response",

  EXAMPLE_LABEL: "Example response",
  EXAMPLE_PLACEHOLDER:
    "$description$description$description$description$description$description$description",
  EXAMPLE_REQUIRED_ERROR:
    "Add at least one example response, or disable the toggle.",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

const OUTPUT_RESPONSE_MAX_LENGTH = 500

const DEFAULT_OUTPUT_RESPONSE_CONFIG: OutputResponseConfig = {
  enabled: true,
  exampleResponse: "",
}

// ---------------------------------------------------------------------------
// Structured output (JSON schema)
// ---------------------------------------------------------------------------

// Compact, generic example schema shown as the textarea placeholder.
// Deliberately small so it doesn't approach the char limit; the design
// mockup ships a longer sample but that's illustrative, not the real
// default.
const STRUCTURED_OUTPUT_PLACEHOLDER = `{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "details": { "type": "string" }
  },
  "required": ["summary"]
}`

// TODO(i18n): externalize once the i18n bundle is wired up.
const STRUCTURED_OUTPUT_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure structured output",
  DESCRIPTION:
    "Select a response format and define either a JSON schema or plain-text output guidelines.",
  RESPONSE_FORMAT_LABEL: "Response format",
  RESPONSE_FORMAT_TEXT_OPTION: "Text",
  RESPONSE_FORMAT_JSON_OBJECT_OPTION: "JSON object",
  SCHEMA_LABEL: "Structured output (JSON SCHEMA)",
  TEXT_LABEL: "Response guidelines",
  SCHEMA_PLACEHOLDER: STRUCTURED_OUTPUT_PLACEHOLDER,
  TEXT_PLACEHOLDER: "Describe the response format in plain text.",
  SCHEMA_REQUIRED_ERROR: "JSON schema is required.",
  SCHEMA_INVALID_ERROR: "Schema must be a valid JSON Schema object.",
  TEXT_REQUIRED_ERROR: "Response guidelines are required.",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

// Matches the "0/500" counter shown in the design mockup. Bump this if
// real-world schemas routinely exceed the cap — most JSON Schemas easily
// exceed 500 chars, so this is likely to grow once real usage data lands.
const STRUCTURED_OUTPUT_MAX_LENGTH = 5000

const DEFAULT_STRUCTURED_OUTPUT_CONFIG: StructuredOutputConfig = {
  enabled: true,
  responseFormat: "json_object",
  schema: "",
}

// ---------------------------------------------------------------------------
// Conversation memory and context
// ---------------------------------------------------------------------------

// TODO(i18n): externalize once the i18n bundle is wired up.
// The "Manage" spelling is correct; the design mockup ships a typo
// ("Mangage") which we deliberately fix on the way in.
const CONVERSATION_MEMORY_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure conversation memory and context",
  DESCRIPTION:
    "Manage how past messages are retained for more relevant responses during long sessions.",

  RETENTION_METHOD_LABEL: "Message retention method",
  MESSAGE_HISTORY_TOGGLE_LABEL: "Override message history limit",
  MESSAGE_HISTORY_LIMIT_LABEL: "Message history limit",

  SESSION_MEMORY_TOGGLE_LABEL: "Enable session memory limit",
  SESSION_HISTORY_LIMIT_LABEL: "Session history limit",

  SUMMARY_TOKEN_LIMIT_TOGGLE_LABEL: "Override summary token limit",
  SUMMARY_TOKEN_LIMIT_LABEL: "Summary token limit",

  MESSAGE_HISTORY_REQUIRED_ERROR:
    "Enter a message history limit between 1 and 200.",
  SESSION_HISTORY_REQUIRED_ERROR:
    "Enter a session history limit between 1 and 100.",
  SUMMARY_TOKEN_LIMIT_REQUIRED_ERROR:
    "Enter a summary token limit between 64 and 50000.",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

const MESSAGE_RETENTION_METHOD_LABEL: Record<MessageRetentionMethod, string> = {
  sliding_window: "Sliding window",
  summarized: "Summarization",
}

/**
 * Inline helper copy shown next to the info icon below the
 * message-history input. Picked from this map by the currently-selected
 * retention method — gives the user a quick description of what their
 * choice actually does.
 */
const MESSAGE_RETENTION_METHOD_HELPER_TEXT: Record<MessageRetentionMethod, string> = {
  sliding_window:
    "Keeps the most recent N messages and drops the rest as the conversation grows.",
  summarized:
    "Older messages are condensed into a running summary while recent messages are kept verbatim.",
}

// Bounds mirror the config-service validator (agentValidator.ts):
// message_history_limit isInt({ min: 0, max: 200 }),
// session_history_limit isInt({ min: 0, max: 100 }),
// summary_token_limit   isInt({ min: 0, max: 50_000 }). Keep these in sync
// or the backend rejects the save with a 400.
const MESSAGE_HISTORY_LIMIT_RANGE = { min: 1, max: 200 } as const
const SESSION_HISTORY_LIMIT_RANGE = { min: 1, max: 100 } as const
const SUMMARY_TOKEN_LIMIT_RANGE = { min: 64, max: 50_000 } as const

/**
 * Defaults are pre-filled to the backend's own default values so a fresh
 * dialog matches what the backend would apply if the field were omitted.
 * Whatever value the user leaves in the input is what gets sent on save —
 * there's no "override" toggle gating emission.
 */
const DEFAULT_CONVERSATION_MEMORY_CONFIG: ConversationMemoryConfig = {
  retentionMethod: "sliding_window",
  messageHistoryLimit: 10,
  sessionHistoryLimit: 10,
  summaryTokenLimit: 2000,
}

// ---------------------------------------------------------------------------
// Safety and guardrails
// ---------------------------------------------------------------------------

// TODO(i18n): externalize once the i18n bundle is wired up.
const SAFETY_GUARDRAILS_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure safety and guardrails",
  DESCRIPTION: "Manage safety filters and content policies.",

  PII_TITLE: "Personally Identifiable Information (PII)",
  PII_DESCRIPTION: "Detect and redact personally identifiable information.",
  PII_TOGGLE_LABEL: "Enable PII detection",

  API_KEY_SCANNER_TITLE: "API Key & Token Scanner",
  API_KEY_SCANNER_DESCRIPTION:
    "Block harmful or inappropriate content and exposed API keys or tokens.",
  API_KEY_SCANNER_TOGGLE_LABEL: "Enable API key & token scanner",

  SECRET_DETECTION_TITLE: "Advanced Secret Detection",
  SECRET_DETECTION_DESCRIPTION:
    "Detect and prevent leakage of secrets and credentials.",
  SECRET_DETECTION_TOGGLE_LABEL: "Enable advanced secret detection",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

const DEFAULT_SAFETY_GUARDRAILS_CONFIG: SafetyGuardrailsConfig = {
  piiMaskerEnabled: true,
  apiKeyTokenScannerEnabled: true,
  secretDetectionEnabled: true,
}

// ---------------------------------------------------------------------------
// Automatic retries
// ---------------------------------------------------------------------------

// TODO(i18n): externalize once the i18n bundle is wired up.
const AUTOMATIC_RETRIES_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure automatic retries",
  DESCRIPTION: "Manage automatic retries of failed requests.",

  TOGGLE_LABEL: "Enable automatic retries",
  MAX_RETRIES_LABEL: "Maximum retries",

  MAX_RETRIES_ERROR: "Enter a retry count between 0 and 10.",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

// 0 lets the user disable retries via the count while keeping the
// toggle on (treated as "retry is configured, just no extra attempts");
// 10 is the highest most LLM SDKs default to.
const MAX_RETRIES_RANGE = { min: 0, max: 10 } as const

const DEFAULT_AUTOMATIC_RETRIES_CONFIG: AutomaticRetriesConfig = {
  enabled: true,
  maxRetries: 3,
}

// ---------------------------------------------------------------------------
// Agent rate limiting
// ---------------------------------------------------------------------------

// TODO(i18n): externalize once the i18n bundle is wired up.
const AGENT_RATE_LIMITING_CONFIG_STRINGS = {
  DIALOG_TITLE: "Configure agent rate limiting",
  DESCRIPTION: "Manage agent call throttling",

  TOGGLE_LABEL: "Enable rate limiting",
  MAX_RPM_LABEL: "Maximum requests per minute",

  MAX_RPM_ERROR: "Enter a per-minute limit between 1 and 10,000.",

  SAVE_ACTION_LABEL: "Save",
  CANCEL_ACTION_LABEL: "Cancel",
} as const

const MAX_REQUESTS_PER_MINUTE_RANGE = { min: 1, max: 10_000 } as const

const DEFAULT_AGENT_RATE_LIMITING_CONFIG: AgentRateLimitingConfig = {
  enabled: true,
  maxRequestsPerMinute: 60,
}

export {
  TOOLSET_CONFIG_STRINGS,
  TOOLSET_STATUS_LABEL,
  DEFAULT_TOOLSET_CONFIG,
  KNOWLEDGE_BASE_CONFIG_STRINGS,
  KNOWLEDGE_BASE_STATUS_LABEL,
  DEFAULT_KNOWLEDGE_BASE_CONFIG,
  TOP_K_RANGE,
  SIMILARITY_RANGE,
  OUTPUT_RESPONSE_CONFIG_STRINGS,
  OUTPUT_RESPONSE_MAX_LENGTH,
  DEFAULT_OUTPUT_RESPONSE_CONFIG,
  STRUCTURED_OUTPUT_CONFIG_STRINGS,
  STRUCTURED_OUTPUT_MAX_LENGTH,
  DEFAULT_STRUCTURED_OUTPUT_CONFIG,
  CONVERSATION_MEMORY_CONFIG_STRINGS,
  MESSAGE_RETENTION_METHOD_LABEL,
  MESSAGE_RETENTION_METHOD_HELPER_TEXT,
  MESSAGE_HISTORY_LIMIT_RANGE,
  SESSION_HISTORY_LIMIT_RANGE,
  SUMMARY_TOKEN_LIMIT_RANGE,
  DEFAULT_CONVERSATION_MEMORY_CONFIG,
  SAFETY_GUARDRAILS_CONFIG_STRINGS,
  DEFAULT_SAFETY_GUARDRAILS_CONFIG,
  AUTOMATIC_RETRIES_CONFIG_STRINGS,
  MAX_RETRIES_RANGE,
  DEFAULT_AUTOMATIC_RETRIES_CONFIG,
  AGENT_RATE_LIMITING_CONFIG_STRINGS,
  MAX_REQUESTS_PER_MINUTE_RANGE,
  DEFAULT_AGENT_RATE_LIMITING_CONFIG,
}

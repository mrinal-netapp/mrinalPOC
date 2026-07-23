import type { ReactElement } from "react"

// FIXME(be-integration): these shapes are placeholders carried over from the
// pre-API mock. Reconcile with the real OpenAPI schema for /models when the
// backend lands: confirm field names (camelCase vs snake_case), date formats
// (the mock uses pre-formatted strings; the real API will likely return ISO
// timestamps that need Intl.DateTimeFormat at the consumer — see I18-002),
// and which fields are optional / nullable.

// -- Enums --

type ModelStatus = "healthy" | "warning" | "error"
type ModelType = "LLM" | "Embedding"
type ActivityEventStatus = "error" | "success" | "warning"

// -- Sub-objects --

/** One dependent resource returned by GET /models/:id/dependents. */
type ModelDependentResource = {
  kind: string
  id: string
  name: string
  relation: string
}

type ActivityEvent = {
  id: string
  event: string
  status: ActivityEventStatus
  details: string
  timestamp: string
}

type CostConfig = {
  inputCostPer1MTokens: string
  outputCostPer1MTokens: string
  customPricing: "Enabled" | "Disabled"
  customInputCostPer1MTokens: string
  customOutputCostPer1MTokens: string
  markup: string
  spendingLimitUsd: string
  spendingThresholdAlert: string
  currentSpending: string
}

// -- Responses --

/** Minimal shape returned by the list endpoint (GET /models). */
type ModelListItem = {
  id: string
  name: string
  status: ModelStatus
  type: ModelType
  provider: string
  lastTimeUpdated: string
}

/** Full payload returned by the detail endpoint (GET /models/:id). */
type ModelDetail = ModelListItem & {
  providerUrl: string
  description: string
  labels: string[]
  model: string
  maxRequestsPerMinute: number
  maxTokensPerMinute: number
  created: string
  requests: number
  cost: string
  avgLatencyMs: number
  successRate: string
  activityEvents: ActivityEvent[]
  costConfig: CostConfig
}

// -- Page-local presentation types --

/** Status badge presentation derived from a `ModelStatus`. */
type ModelStatusPresentation = {
  label: string
  icon: ReactElement
  className: string
}

export type {
  ActivityEvent,
  ActivityEventStatus,
  CostConfig,
  ModelDependentResource,
  ModelDetail,
  ModelListItem,
  ModelStatus,
  ModelStatusPresentation,
  ModelType,
}

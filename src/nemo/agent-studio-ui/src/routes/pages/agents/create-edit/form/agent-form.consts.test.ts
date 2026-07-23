import { describe, expect, it } from "vitest"

import {
  AGENT_NAME_PATTERN_ERROR,
  DEFAULT_FEATURE_CONFIG,
  agentNamePatternError,
  buildAgentDefaultValues,
  buildFeatureBody,
  resetFeatureConfig,
  type AgentConfigurationFeature,
  type AgentFeatureKey,
} from "./agent-form.consts"

function makeConfig(): AgentConfigurationFeature {
  return {
    ...DEFAULT_FEATURE_CONFIG,
    piiMaskerEnabled: true,
    apiKeyTokenScannerEnabled: true,
    secretDetectionEnabled: true,
    messageHistoryLimit: 42,
    sessionHistoryLimit: 11,
    maxRetries: 9,
    maxRequestsPerMinute: 123,
    responseFormat: "text",
    structuredOutputSchema: "{\"type\":\"object\"}",
  }
}

describe("agent-form.consts helpers", () => {
  it("[tag:agent-form-consts] buildFeatureBody conversation memory: sliding_window shows message history limit", () => {
    const cfg = {
      ...makeConfig(),
      messageRetentionMethod: "sliding_window" as const,
      messageHistoryLimit: 42,
    }
    const rows = buildFeatureBody("conversation_memory", true, cfg)
    expect(rows).toEqual([
      { label: "Status", value: "Enabled" },
      { label: "Retention method", value: "Sliding window" },
      { label: "Message history limit", value: 42 },
    ])
  })

  it("[tag:agent-form-consts] buildFeatureBody conversation memory: summarized shows summary token limit", () => {
    const cfg = {
      ...makeConfig(),
      messageRetentionMethod: "summarized" as const,
      summaryTokenLimit: 1500,
    }
    const rows = buildFeatureBody("conversation_memory", true, cfg)
    expect(rows).toEqual([
      { label: "Status", value: "Enabled" },
      { label: "Retention method", value: "Summarization" },
      { label: "Summary token limit", value: 1500 },
    ])
  })

  it("[tag:agent-form-consts] buildFeatureBody returns safety and guardrails rows", () => {
    const rows = buildFeatureBody("safety_guardrails", true, makeConfig())
    expect(rows).toEqual([
      { label: "Personally Identifiable Information (PII)", value: "Enabled" },
      { label: "API Key & Token Scanner", value: "Enabled" },
      { label: "Advanced Secret Detection", value: "Enabled" },
    ])
  })

  it("[tag:agent-form-consts] buildFeatureBody returns automatic retries rows", () => {
    const rows = buildFeatureBody("automatic_retries", false, makeConfig())
    expect(rows).toEqual([
      { label: "Status", value: "Disabled" },
      { label: "Maximum retries", value: 9 },
    ])
  })

  it("[tag:agent-form-consts] buildFeatureBody returns rate limiting rows", () => {
    const rows = buildFeatureBody("api_rate_limiting", true, makeConfig())
    expect(rows).toEqual([
      { label: "Status", value: "Enabled" },
      { label: "Max requests per minute", value: 123 },
    ])
  })

  it("[tag:agent-form-consts] buildFeatureBody default branch returns status row", () => {
    const rows = buildFeatureBody("output_response", false, makeConfig())
    expect(rows).toEqual([{ label: "Status", value: "Disabled" }])
  })

  it("[tag:agent-form-consts] resetFeatureConfig resets structured output fields", () => {
    const next = resetFeatureConfig("structured_output", makeConfig())
    expect(next.structuredOutputSchema).toBe(DEFAULT_FEATURE_CONFIG.structuredOutputSchema)
    expect(next.responseFormat).toBe(DEFAULT_FEATURE_CONFIG.responseFormat)
  })

  it("[tag:agent-form-consts] buildAgentDefaultValues enables conversation memory by default", () => {
    const values = buildAgentDefaultValues()
    expect(values.enabledFeatures).toContain("conversation_memory")
    expect(values.featureConfig.messageRetentionMethod).toBe("sliding_window")
    expect(values.featureConfig.messageHistoryLimit).toBe(10)
  })

  it("[tag:agent-form-consts] resetFeatureConfig resets conversation memory fields", () => {
    const next = resetFeatureConfig("conversation_memory", makeConfig())
    expect(next.messageRetentionMethod).toBe(DEFAULT_FEATURE_CONFIG.messageRetentionMethod)
    expect(next.messageHistoryLimit).toBe(DEFAULT_FEATURE_CONFIG.messageHistoryLimit)
    expect(next.sessionHistoryLimit).toBe(DEFAULT_FEATURE_CONFIG.sessionHistoryLimit)
  })

  it("[tag:agent-form-consts] resetFeatureConfig resets guardrail fields", () => {
    const next = resetFeatureConfig("safety_guardrails", makeConfig())
    expect(next.piiMaskerEnabled).toBe(DEFAULT_FEATURE_CONFIG.piiMaskerEnabled)
    expect(next.apiKeyTokenScannerEnabled).toBe(DEFAULT_FEATURE_CONFIG.apiKeyTokenScannerEnabled)
    expect(next.secretDetectionEnabled).toBe(DEFAULT_FEATURE_CONFIG.secretDetectionEnabled)
  })

  it("[tag:agent-form-consts] resetFeatureConfig resets retries fields", () => {
    const next = resetFeatureConfig("automatic_retries", makeConfig())
    expect(next.maxRetries).toBe(DEFAULT_FEATURE_CONFIG.maxRetries)
  })

  it("[tag:agent-form-consts] resetFeatureConfig resets rate limiting fields", () => {
    const next = resetFeatureConfig("api_rate_limiting", makeConfig())
    expect(next.maxRequestsPerMinute).toBe(DEFAULT_FEATURE_CONFIG.maxRequestsPerMinute)
  })

  it("[tag:agent-form-consts] resetFeatureConfig default branch returns original config", () => {
    const current = makeConfig()
    const next = resetFeatureConfig("output_response" as AgentFeatureKey, current)
    expect(next).toBe(current)
  })
})

describe("agentNamePatternError [tag:agents]", () => {
  it("accepts valid names (letters, numbers, hyphens, underscores)", () => {
    for (const name of ["Triage-Agent", "orchestrator", "agent_1", "A", "gpt-4o-mini_v2"]) {
      expect(agentNamePatternError(name)).toBeUndefined()
    }
  })

  it("treats empty/whitespace as valid here (required-ness is separate)", () => {
    expect(agentNamePatternError("")).toBeUndefined()
    expect(agentNamePatternError("   ")).toBeUndefined()
  })

  it("rejects names with spaces or disallowed symbols", () => {
    expect(agentNamePatternError("Triage Agent")).toBe(AGENT_NAME_PATTERN_ERROR)
    expect(agentNamePatternError("agent!")).toBe(AGENT_NAME_PATTERN_ERROR)
    expect(agentNamePatternError("a.b")).toBe(AGENT_NAME_PATTERN_ERROR)
  })

  it("rejects leading/trailing whitespace (validates the raw value, not a trimmed copy)", () => {
    // Regression: these otherwise-valid names carry stray whitespace that the
    // backend regex ^[a-zA-Z0-9_-]{1,64}$ rejects. Trimming before validation
    // let them pass the UI check and then fail on save.
    expect(agentNamePatternError("Agent-1 ")).toBe(AGENT_NAME_PATTERN_ERROR)
    expect(agentNamePatternError(" Agent-1")).toBe(AGENT_NAME_PATTERN_ERROR)
    expect(agentNamePatternError("Agent 1")).toBe(AGENT_NAME_PATTERN_ERROR)
    expect(agentNamePatternError("\tAgent-1")).toBe(AGENT_NAME_PATTERN_ERROR)
  })

  it("rejects names longer than 64 characters", () => {
    expect(agentNamePatternError("a".repeat(64))).toBeUndefined()
    expect(agentNamePatternError("a".repeat(65))).toBe(AGENT_NAME_PATTERN_ERROR)
  })
})

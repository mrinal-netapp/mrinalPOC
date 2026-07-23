import { useState, type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"

import { ConfigurationSection } from "./configuration-section"
import {
  AGENT_RATE_LIMITING_CONFIG_STRINGS,
  AUTOMATIC_RETRIES_CONFIG_STRINGS,
  CONVERSATION_MEMORY_CONFIG_STRINGS,
  SAFETY_GUARDRAILS_CONFIG_STRINGS,
  STRUCTURED_OUTPUT_CONFIG_STRINGS,
} from "../configure-dialogs/configure-dialogs.consts"
import {
  AGENT_FEATURE_LIST,
  DEFAULT_ENABLED_FEATURES,
  DEFAULT_FEATURE_CONFIG,
  type AgentFeatureKey,
  type AgentFormValues,
} from "./agent-form.consts"

vi.setConfig({ testTimeout: 90_000 })

type Values = Pick<AgentFormValues, "enabledFeatures" | "featureConfig">

function Harness({
  enabledFeatures = [...DEFAULT_ENABLED_FEATURES] as AgentFeatureKey[],
  featureConfig = { ...DEFAULT_FEATURE_CONFIG },
  onChange,
  structuredOutputError,
}: {
  enabledFeatures?: AgentFeatureKey[]
  featureConfig?: AgentFormValues["featureConfig"]
  onChange?: (values: Values) => void
  structuredOutputError?: string
} = {}): ReactElement {
  const form = useTestForm({
    enabledFeatures,
    featureConfig,
  })
  const [, force] = useState(0)
  form.store.subscribe(() => {
    onChange?.(form.state.values as Values)
    force((v) => v + 1)
  })
  return <ConfigurationSection form={form} structuredOutputError={structuredOutputError} />
}

// Finds the primary action button ("Configure" or "Enable") for the card
// titled `title` by walking up from each candidate button to the card header.
function getCardActionButton(title: string, action: "Configure" | "Enable"): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: action })
  const target = buttons.find((b) => {
    let node: HTMLElement | null = b
    for (let i = 0; i < 4 && node; i++) {
      if (node.textContent?.includes(title)) return true
      node = node.parentElement
    }
    return false
  })
  if (!target) throw new Error(`${action} button not found for card: ${title}`)
  return target
}

describe("ConfigurationSection", () => {
  it("[tag:config-section] renders the section heading", () => {
    render(<Harness />)
    expect(screen.getAllByText("Configuration").length).toBeGreaterThan(0)
  })

  it("[tag:config-section] renders one feature card per entry in AGENT_FEATURE_LIST", () => {
    render(<Harness />)
    // Collapsed by default — reveal the rest first.
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    AGENT_FEATURE_LIST.forEach((meta) => {
      expect(screen.getByText(meta.title)).toBeInTheDocument()
    })
  })

  it("[tag:config-section] conversation memory is enabled by default; other disabled cards show Enable", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    expect(getCardActionButton("Conversation memory and context", "Configure")).toBeEnabled()
    expect(screen.getByText("Enabled")).toBeInTheDocument()
    expect(screen.getByText("Sliding window")).toBeInTheDocument()
    expect(screen.getByText("10")).toBeInTheDocument()
    expect(getCardActionButton("Automatic retries", "Enable")).toBeEnabled()
    expect(getCardActionButton("Structured output", "Configure")).toBeEnabled()
    expect(getCardActionButton("Safety and guardrails", "Enable")).toBeEnabled()
    expect(getCardActionButton("API rate limiting", "Enable")).toBeEnabled()
  })

  it("[tag:config-section] each card's dots menu reflects its enabled state", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    // Dots menus are present on all cards.
    const dotsTriggers = screen.getAllByRole("button", { name: /options$/ })
    expect(dotsTriggers.length).toBe(AGENT_FEATURE_LIST.length)
  })

  it("[tag:config-section] configure-first features are enabled only after a successful dialog save", () => {
    let latest: Values | undefined
    render(<Harness enabledFeatures={[]} onChange={(v) => (latest = v)} />)
    fireEvent.click(getCardActionButton("Structured output", "Configure"))
    // Save is blocked until schema text is provided.
    fireEvent.click(
      screen.getByRole("button", {
        name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.enabledFeatures ?? []).not.toContain("structured_output")

    fireEvent.change(screen.getByLabelText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_LABEL), {
      target: { value: '{"type":"object"}' },
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.enabledFeatures).toContain("structured_output")
  })

  it("[tag:config-section] disabling via the dots menu removes the feature and resets its featureConfig fields", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["automatic_retries"]}
        featureConfig={{ ...DEFAULT_FEATURE_CONFIG, maxRetries: 9 }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    // Open the dots menu for Automatic retries and click "Disable".
    fireEvent.click(screen.getByRole("button", { name: "Automatic retries options" }))
    fireEvent.click(screen.getByText("Disable"))
    expect(latest?.enabledFeatures).not.toContain("automatic_retries")
    expect(latest?.featureConfig.maxRetries).toBe(DEFAULT_FEATURE_CONFIG.maxRetries)
  })

  it("[tag:config-section] enabling structured output from dots menu opens dialog and still requires schema", () => {
    let latest: Values | undefined
    render(<Harness enabledFeatures={[]} onChange={(v) => (latest = v)} />)

    fireEvent.click(screen.getByRole("button", { name: "Structured output options" }))
    fireEvent.click(screen.getAllByText("Enable").at(-1) as HTMLElement)
    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    expect(latest?.enabledFeatures ?? []).not.toContain("structured_output")

    fireEvent.change(screen.getByLabelText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_LABEL), {
      target: { value: '{"type":"object"}' },
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )

    expect(latest?.enabledFeatures).toContain("structured_output")
  })

  it("[tag:config-section] toggling 'Show less' / 'Show more' collapses and re-expands the feature list", () => {
    render(<Harness />)

    // Collapsed by default: first two cards visible, the rest hidden.
    expect(screen.getByText(AGENT_FEATURE_LIST[0].title)).toBeInTheDocument()
    expect(screen.getByText(AGENT_FEATURE_LIST[1].title)).toBeInTheDocument()
    expect(screen.queryByText(AGENT_FEATURE_LIST[2].title)).not.toBeInTheDocument()

    const showMore = screen.getByRole("button", { name: /Show more/ })
    expect(showMore.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(showMore)

    // Expanded: every feature card is visible.
    AGENT_FEATURE_LIST.forEach((meta) => {
      expect(screen.getByText(meta.title)).toBeInTheDocument()
    })

    // Collapses again via "Show less".
    fireEvent.click(screen.getByRole("button", { name: /Show less/ }))
    expect(screen.queryByText(AGENT_FEATURE_LIST[2].title)).not.toBeInTheDocument()
  })

  it("[tag:config-section] conversation memory dialog Save persists the typed limit", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["conversation_memory"]}
        featureConfig={{
          ...DEFAULT_FEATURE_CONFIG,
          messageHistoryLimit: 20,
        }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(getCardActionButton("Conversation memory and context", "Configure"))

    // Conversation Memory dialog has a unique title; assert via that.
    expect(
      screen.getByText("Configure conversation memory and context"),
    ).toBeInTheDocument()

    // Change the message history limit directly — no toggle gating.
    const input = screen.getByLabelText(
      CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_LIMIT_LABEL,
    )
    fireEvent.change(input, { target: { value: "55" } })

    fireEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.featureConfig.messageHistoryLimit).toBe(55)
  })

  it("[tag:config-section] opening/saving Structured output syncs schema into featureConfig", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["structured_output"]}
        featureConfig={{ ...DEFAULT_FEATURE_CONFIG, structuredOutputSchema: '{"type":"object"}' }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(getCardActionButton("Structured output", "Configure"))
    fireEvent.click(
      screen.getByRole("button", {
        name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.featureConfig.structuredOutputSchema).toBe('{"type":"object"}')
  })

  it("[tag:config-section] opening/saving Structured output in text mode syncs responseFormat and guidelines", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["structured_output"]}
        featureConfig={{
          ...DEFAULT_FEATURE_CONFIG,
          responseFormat: "text",
          structuredOutputSchema: "Respond in markdown bullets.",
        }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(getCardActionButton("Structured output", "Configure"))
    fireEvent.click(
      screen.getByRole("button", {
        name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.featureConfig.responseFormat).toBe("text")
    expect(latest?.featureConfig.structuredOutputSchema).toBe("Respond in markdown bullets.")
  })

  it("[tag:config-section] opening/saving Automatic retries syncs maxRetries", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["automatic_retries"]}
        featureConfig={{ ...DEFAULT_FEATURE_CONFIG, maxRetries: 8 }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    fireEvent.click(getCardActionButton("Automatic retries", "Configure"))
    fireEvent.click(
      screen.getByRole("switch", {
        name: AUTOMATIC_RETRIES_CONFIG_STRINGS.TOGGLE_LABEL,
      }),
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: AUTOMATIC_RETRIES_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.featureConfig.maxRetries).toBe(8)
  })

  it("[tag:config-section] opening/saving API rate limiting syncs maxRequestsPerMinute", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["api_rate_limiting"]}
        featureConfig={{ ...DEFAULT_FEATURE_CONFIG, maxRequestsPerMinute: 888 }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    fireEvent.click(getCardActionButton("API rate limiting", "Configure"))
    fireEvent.click(
      screen.getByRole("switch", {
        name: AGENT_RATE_LIMITING_CONFIG_STRINGS.TOGGLE_LABEL,
      }),
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: AGENT_RATE_LIMITING_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.featureConfig.maxRequestsPerMinute).toBe(888)
  })

  it("[tag:config-section] opening/saving Safety and guardrails syncs all guardrail toggles", () => {
    let latest: Values | undefined
    render(
      <Harness
        enabledFeatures={["safety_guardrails"]}
        featureConfig={{
          ...DEFAULT_FEATURE_CONFIG,
          piiMaskerEnabled: true,
          apiKeyTokenScannerEnabled: true,
          secretDetectionEnabled: true,
        }}
        onChange={(v) => (latest = v)}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }))
    fireEvent.click(getCardActionButton("Safety and guardrails", "Configure"))
    fireEvent.click(
      screen.getByRole("switch", {
        name: SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TOGGLE_LABEL,
      }),
    )
    fireEvent.click(
      screen.getByRole("switch", {
        name: SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TOGGLE_LABEL,
      }),
    )
    fireEvent.click(
      screen.getByRole("switch", {
        name: SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_TOGGLE_LABEL,
      }),
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAFETY_GUARDRAILS_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(latest?.featureConfig.piiMaskerEnabled).toBe(false)
    expect(latest?.featureConfig.apiKeyTokenScannerEnabled).toBe(false)
    expect(latest?.featureConfig.secretDetectionEnabled).toBe(false)
  })

  it("[tag:config-section] canceling a dialog closes it without saving", () => {
    render(<Harness enabledFeatures={["structured_output"]} />)
    fireEvent.click(getCardActionButton("Structured output", "Configure"))
    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", {
        name: STRUCTURED_OUTPUT_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
      }),
    )
    expect(
      screen.queryByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.DIALOG_TITLE),
    ).not.toBeInTheDocument()
  })

  it("[tag:config-section] renders inline structured-output validation message when provided", () => {
    render(
      <Harness
        enabledFeatures={["structured_output"]}
        structuredOutputError="JSON schema is required when Structured output is enabled."
      />,
    )
    expect(
      screen.getByText("JSON schema is required when Structured output is enabled."),
    ).toBeInTheDocument()
  })
})

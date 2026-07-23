import { screen } from "@testing-library/react"
import { afterEach, describe, it, expect } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"
import type { ModelPricingDefaults } from "@/routes/pages/models/models.api"
import { OverviewPanel } from "./overview-panel"
import type { OverviewPanelProps } from "./overview-panel.types"
import type { ModelDetail } from "../../model-detail-page.types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_MODEL: ModelDetail = {
  id: "model-mcp-01",
  name: "model-mcp-01",
  status: "healthy",
  type: "LLM",
  provider: "OpenAI",
  providerUrl: "https://openai.com",
  description: "Test description",
  labels: ["Staging", "NFS"],
  model: "gpt-4-turbo-preview",
  maxRequestsPerMinute: 1000,
  maxTokensPerMinute: 2000000,
  lastTimeUpdated: "Feb 11, 2026",
  created: "Feb 10, 2026",
  requests: 1200000,
  cost: "$582.01",
  avgLatencyMs: 245,
  successRate: "99.2%",
  activityEvents: [],
  costConfig: {
    inputCostPer1MTokens: "$10.00",
    outputCostPer1MTokens: "$30.00",
    customPricing: "Enabled",
    customInputCostPer1MTokens: "$10.00",
    customOutputCostPer1MTokens: "$30.00",
    markup: "15%",
    spendingLimitUsd: "$5,000 per month",
    spendingThresholdAlert: "75%",
    currentSpending: "11.64%",
  },
}

const DEFAULT_PRICING: ModelPricingDefaults = {
  inputCostPer1M: 2.5,
  outputCostPer1M: 7.5,
  source: "datasheet",
  matchedModel: "gpt-4-turbo",
  approximate: false,
}

function renderOverviewPanel(overrides: Partial<OverviewPanelProps> = {}) {
  return renderWithProviders(<OverviewPanel model={MOCK_MODEL} {...overrides} />)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OverviewPanel", () => {
  afterEach(() => {
    restoreAllMocks()
  })

  it("[tag:overview-panel] renders metrics values", () => {
    renderOverviewPanel()
    expect(screen.getByText("Requests")).toBeInTheDocument()
    expect(screen.getByText("Cost")).toBeInTheDocument()
    expect(screen.getByText("Average latency")).toBeInTheDocument()
    expect(screen.getByText("Success rate")).toBeInTheDocument()
  })

  it("[tag:overview-panel] renders detail row labels", () => {
    renderOverviewPanel()
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Description")).toBeInTheDocument()
    expect(screen.getByText("Provider")).toBeInTheDocument()
  })

  it("[tag:overview-panel] renders the time range filter chip with default value", () => {
    renderOverviewPanel()
    expect(screen.getByText(/Time range: Last month/)).toBeInTheDocument()
  })

  it("[tag:overview-panel] clear filter button keeps the time range dropdown available", async () => {
    renderOverviewPanel()
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Clear time range filter" }))
    expect(screen.getByRole("button", { name: "Time range" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear time range filter" })).not.toBeInTheDocument()
  })

  it("[tag:overview-panel] lets the user select a time range after clearing it", async () => {
    renderOverviewPanel()
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Clear time range filter" }))
    await user.click(screen.getByRole("button", { name: "Time range" }))
    await user.click(await screen.findByRole("menuitem", { name: "Last week" }))
    expect(await screen.findByText(/Time range: Last week/)).toBeInTheDocument()
  })

  it("[tag:overview-panel] collapse button hides the metrics row", async () => {
    renderOverviewPanel()
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Collapse metrics" }))
    expect(screen.queryByText("Requests")).not.toBeInTheDocument()
  })

  it("[tag:overview-panel] expand button after collapse shows the metrics row again", async () => {
    renderOverviewPanel()
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Collapse metrics" }))
    await user.click(screen.getByRole("button", { name: "Expand metrics" }))
    expect(screen.getByText("Requests")).toBeInTheDocument()
  })

  it("[tag:overview-panel] switching to Cost configuration tab shows cost config rows", async () => {
    renderOverviewPanel()
    const user = userEvent.setup({ delay: null })
    await user.click(await screen.findByRole("tab", { name: "Cost configuration" }))
    expect(screen.getByText("Input cost (USD per 1M tokens)")).toBeInTheDocument()
    expect(screen.getByText("Markup")).toBeInTheDocument()
    expect(screen.getByText("Current spending")).toBeInTheDocument()
  })

  it("[tag:overview-panel] shows associated resources count in the details tab", () => {
    renderOverviewPanel({ dependentCount: 5 })
    expect(screen.getByText("Associated resources")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
  })

  it("[tag:overview-panel] defaults the associated resources count to 0 when not provided", () => {
    renderOverviewPanel()
    expect(screen.getByText("Associated resources")).toBeInTheDocument()
    expect(screen.getByText("0")).toBeInTheDocument()
  })

  it("[tag:overview-panel] shows the custom price when a custom override is set", () => {
    // MOCK_MODEL has custom input/output overrides, so the custom price wins
    // over any provider default that is passed in.
    renderOverviewPanel({ pricingDefaults: DEFAULT_PRICING })
    expect(screen.getByText("Input cost (USD per 1M tokens)")).toBeInTheDocument()
    expect(screen.getByText("Output cost (USD per 1M tokens)")).toBeInTheDocument()
    expect(screen.getByText("$10.00")).toBeInTheDocument()
    expect(screen.getByText("$30.00")).toBeInTheDocument()
  })

  it("[tag:overview-panel] falls back to the default price when custom pricing is absent", () => {
    const modelWithoutCustom: ModelDetail = {
      ...MOCK_MODEL,
      costConfig: {
        ...MOCK_MODEL.costConfig,
        customPricing: "Disabled",
        customInputCostPer1MTokens: "-",
        customOutputCostPer1MTokens: "-",
      },
    }
    renderWithProviders(
      <OverviewPanel model={modelWithoutCustom} pricingDefaults={DEFAULT_PRICING} />,
    )
    // Provider list price ($2.50 / $7.50) is shown instead of the custom values.
    expect(screen.getByText("$2.50")).toBeInTheDocument()
    expect(screen.getByText("$7.50")).toBeInTheDocument()
  })

  it("[tag:overview-panel] shows '-' when neither custom nor default pricing is available", () => {
    const modelWithoutCustom: ModelDetail = {
      ...MOCK_MODEL,
      costConfig: {
        ...MOCK_MODEL.costConfig,
        customPricing: "Disabled",
        customInputCostPer1MTokens: "-",
        customOutputCostPer1MTokens: "-",
      },
    }
    renderWithProviders(<OverviewPanel model={modelWithoutCustom} />)
    expect(screen.getByText("Input cost (USD per 1M tokens)")).toBeInTheDocument()
    // Both input and output cost fall back to "-" (Associated resources also
    // renders "-" only if given as such; here it is 0), so assert at least the
    // two price rows render the placeholder.
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(2)
  })

  it("[tag:overview-panel] time range dropdown lets the user pick a different option", async () => {
    renderOverviewPanel()
    const user = userEvent.setup({ delay: null })
    await user.click(await screen.findByRole("button", { name: /Time range/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Last week" }))
    expect(await screen.findByText(/Time range: Last week/)).toBeInTheDocument()
  }, 15000)

  it("[tag:overview-panel] renders live Bifrost usage metrics when a project is active", async () => {
    mockFetchByUrl([
      {
        match: "/models/model-mcp-01/stats",
        data: {
          requests: 4321,
          totalTokens: 100000,
          totalCost: 12.5,
          averageLatencyMs: 245.6,
          successRate: 99.2,
          available: true,
        },
      },
    ])

    renderWithProviders(<OverviewPanel model={MOCK_MODEL} />, {
      preloadedState: {
        projectContext: { activeProject: { id: "proj-1", name: "Proj", role: null } },
      },
    })

    // Live values from the stats endpoint replace the fixture placeholders.
    expect(await screen.findByText("$12.50")).toBeInTheDocument()
    expect(await screen.findByText("99.2%")).toBeInTheDocument()
    expect(await screen.findByText("246")).toBeInTheDocument()
  })

  it("[tag:overview-panel] shows sub-cent cost with 4 significant figures instead of $0.00", async () => {
    mockFetchByUrl([
      {
        match: "/models/model-mcp-01/stats",
        data: {
          requests: 1,
          totalTokens: 512,
          totalCost: 0.0002513465,
          averageLatencyMs: 900,
          successRate: 100,
          available: true,
        },
      },
    ])

    renderWithProviders(<OverviewPanel model={MOCK_MODEL} />, {
      preloadedState: {
        projectContext: { activeProject: { id: "proj-1", name: "Proj", role: null } },
      },
    })

    // A single small request costs a fraction of a cent; two-decimal rounding
    // would read as "$0.00", so we keep 4 significant figures.
    expect(await screen.findByText("$0.0002513")).toBeInTheDocument()
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument()
  })

  it("[tag:overview-panel] shows '-' cost when usage stats are unavailable", async () => {
    mockFetchByUrl([
      {
        match: "/models/model-mcp-01/stats",
        data: {
          requests: 0,
          totalTokens: 0,
          totalCost: 0,
          averageLatencyMs: 0,
          successRate: null,
          available: false,
        },
      },
    ])

    renderWithProviders(<OverviewPanel model={MOCK_MODEL} />, {
      preloadedState: {
        projectContext: { activeProject: { id: "proj-1", name: "Proj", role: null } },
      },
    })

    // available:false -> cost placeholder and success-rate em dash.
    expect(await screen.findByText("—")).toBeInTheDocument()
    expect(screen.queryByText("$582.01")).not.toBeInTheDocument()
  })
})

import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

vi.mock("@/routes/pages/models/models.api", () => ({
  useGetModelPricingDefaultsQuery: vi.fn(),
}))

import { useGetModelPricingDefaultsQuery } from "@/routes/pages/models/models.api"
import { ModelCostCell } from "./model-cost-cell"

type PricingHook = typeof useGetModelPricingDefaultsQuery

function mockPricing(overrides: { data?: unknown; isFetching?: boolean }) {
  vi.mocked(useGetModelPricingDefaultsQuery as unknown as PricingHook).mockReturnValue({
    data: undefined,
    isFetching: false,
    ...overrides,
  } as unknown as ReturnType<PricingHook>)
}

describe("ModelCostCell", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:model-cost-cell] shows the custom override and skips the default lookup", () => {
    mockPricing({})
    renderWithProviders(
      <ModelCostCell providerId="openai" providerModelId="gpt-4o" customCost={3} costType="input" />,
    )
    expect(screen.getByText("$3.00")).toBeInTheDocument()
    const [, options] = vi.mocked(useGetModelPricingDefaultsQuery).mock.calls[0] ?? []
    expect(options?.skip).toBe(true)
  })

  it("[tag:model-cost-cell] falls back to the catalog default when no custom price is set", () => {
    mockPricing({
      data: {
        inputCostPer1M: 2.5,
        outputCostPer1M: 10,
        source: "datasheet",
        matchedModel: "gpt-4o",
        approximate: false,
      },
    })
    renderWithProviders(
      <ModelCostCell providerId="openai" providerModelId="gpt-4o" customCost={null} costType="output" />,
      { preloadedState: { projectContext: { activeProject: { id: "proj-1", name: "Proj", role: null } } } },
    )
    expect(screen.getByText("$10.00")).toBeInTheDocument()
    const [, options] = vi.mocked(useGetModelPricingDefaultsQuery).mock.calls[0] ?? []
    expect(options?.skip).toBe(false)
  })

  it("[tag:model-cost-cell] renders '-' when neither custom nor default is available", () => {
    mockPricing({})
    renderWithProviders(
      <ModelCostCell providerId="" providerModelId="" customCost={null} costType="input" />,
    )
    expect(screen.getByText("-")).toBeInTheDocument()
  })

  it("[tag:model-cost-cell] shows a placeholder while the default is loading", () => {
    mockPricing({ isFetching: true })
    renderWithProviders(
      <ModelCostCell providerId="openai" providerModelId="gpt-4o" customCost={null} costType="input" />,
    )
    expect(screen.getByText("…")).toBeInTheDocument()
  })
})

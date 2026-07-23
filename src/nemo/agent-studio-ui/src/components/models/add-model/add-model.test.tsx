import { screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"

import { AddModel } from "./add-model"
import {
  buildModelDropdownData,
  buildSelectedModelCardDetails,
  configToModelLimits,
  providerColumnAriaSort,
  resolveModelRegistrationName,
  sortProviderRows,
} from "./add-model.utils"
import type { ModelProvider } from "./add-model.types"
import type { EditModelConfig } from "../edit-model/edit-model-modal.types"

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}))

const BASE_CFG: EditModelConfig = {
  name: "GPT-4o",
  throttlingTier: "custom",
  maxRequestsPerMinute: "60",
  maxTokensPerMinute: "10000",
  customPricingEnabled: false,
  inputCostUsd: "10",
  outputCostUsd: "20",
  pricingUnit: "per-1m",
  spendingLimitEnabled: false,
  spendingLimitUsd: "1000",
  spendingPeriod: "per-month",
}

const ROWS: ModelProvider[] = [
  { provider_id: "b", name: "Beta", capabilities: "Chat", data_residency: "Global" },
  { provider_id: "a", name: "Alpha", capabilities: "Embeddings", data_residency: "Regional" },
]

describe("add-model helpers", () => {
  describe("resolveModelRegistrationName", () => {
    it("[tag:add-model-helpers] prefers the Modify dialog name over the catalog label", () => {
      expect(
        resolveModelRegistrationName(
          { key: "gpt-5.4", value: "gpt-5.4", label: "gpt-5.4", kind: "llm" },
          { ...BASE_CFG, name: "gpt-5.4-prod" },
        ),
      ).toBe("gpt-5.4-prod");
    });

    it("[tag:add-model-helpers] falls back to the catalog label when Modify was not saved", () => {
      expect(
        resolveModelRegistrationName(
          { key: "gpt-5.4", value: "gpt-5.4", label: "gpt-5.4", kind: "llm" },
        ),
      ).toBe("gpt-5.4");
    });
  });

  describe("configToModelLimits", () => {
    it("[tag:add-model-helpers] returns an empty object for missing config", () => {
      expect(configToModelLimits(undefined)).toEqual({})
    })

    it("[tag:add-model-helpers] maps positive rpm/tpm and drops zero/NaN/negative", () => {
      expect(configToModelLimits(BASE_CFG)).toEqual({ rpm: 60, tpm: 10000 })
      expect(
        configToModelLimits({ ...BASE_CFG, maxRequestsPerMinute: "0", maxTokensPerMinute: "abc" }),
      ).toEqual({})
      expect(
        configToModelLimits({ ...BASE_CFG, maxRequestsPerMinute: "-5", maxTokensPerMinute: "100" }),
      ).toEqual({ tpm: 100 })
    })

    it("[tag:add-model-helpers] maps the spending period when a limit is enabled", () => {
      expect(
        configToModelLimits({
          ...BASE_CFG,
          spendingLimitEnabled: true,
          spendingLimitUsd: "1,000",
          spendingPeriod: "per-day",
        }),
      ).toMatchObject({ spendingLimit: 1000, spendingLimitPeriod: "day" })
      expect(
        configToModelLimits({ ...BASE_CFG, spendingLimitEnabled: true, spendingPeriod: "per-week" }),
      ).toMatchObject({ spendingLimitPeriod: "week" })
      expect(
        configToModelLimits({ ...BASE_CFG, spendingLimitEnabled: true, spendingPeriod: "per-month" }),
      ).toMatchObject({ spendingLimitPeriod: "month" })
    })

    it("[tag:add-model-helpers] omits the spending limit when disabled or non-positive", () => {
      expect(configToModelLimits({ ...BASE_CFG, spendingLimitEnabled: false })).not.toHaveProperty(
        "spendingLimit",
      )
      expect(
        configToModelLimits({ ...BASE_CFG, spendingLimitEnabled: true, spendingLimitUsd: "0" }),
      ).not.toHaveProperty("spendingLimit")
    })

    it("[tag:add-model-helpers] normalises custom pricing to per-1M tokens", () => {
      expect(
        configToModelLimits({
          ...BASE_CFG,
          customPricingEnabled: true,
          pricingUnit: "per-1m",
          inputCostUsd: "5",
          outputCostUsd: "15",
        }),
      ).toMatchObject({ inputCostPer1M: 5, outputCostPer1M: 15 })

      expect(
        configToModelLimits({
          ...BASE_CFG,
          customPricingEnabled: true,
          pricingUnit: "per-1k",
          inputCostUsd: "1",
          outputCostUsd: "2",
        }),
      ).toMatchObject({ inputCostPer1M: 1000, outputCostPer1M: 2000 })
    })
  })

  describe("sortProviderRows", () => {
    it("[tag:add-model-helpers] returns a copy in original order when unsorted", () => {
      const out = sortProviderRows(ROWS, null)
      expect(out.map((r) => r.name)).toEqual(["Beta", "Alpha"])
      expect(out).not.toBe(ROWS)
    })

    it("[tag:add-model-helpers] sorts by name ascending and descending", () => {
      expect(sortProviderRows(ROWS, { column: "name", direction: "asc" }).map((r) => r.name)).toEqual(
        ["Alpha", "Beta"],
      )
      expect(sortProviderRows(ROWS, { column: "name", direction: "desc" }).map((r) => r.name)).toEqual(
        ["Beta", "Alpha"],
      )
    })

    it("[tag:add-model-helpers] sorts by capabilities and data residency", () => {
      expect(
        sortProviderRows(ROWS, { column: "capabilities", direction: "asc" }).map((r) => r.name),
      ).toEqual(["Beta", "Alpha"])
      expect(
        sortProviderRows(ROWS, { column: "data_residency", direction: "asc" }).map((r) => r.name),
      ).toEqual(["Beta", "Alpha"])
    })
  })

  describe("providerColumnAriaSort", () => {
    it("[tag:add-model-helpers] reports none unless the column is the active sort", () => {
      expect(providerColumnAriaSort("name", null)).toBe("none")
      expect(providerColumnAriaSort("name", { column: "capabilities", direction: "asc" })).toBe("none")
      expect(providerColumnAriaSort("name", { column: "name", direction: "asc" })).toBe("ascending")
      expect(providerColumnAriaSort("name", { column: "name", direction: "desc" })).toBe("descending")
    })
  })

  describe("buildModelDropdownData", () => {
    it("[tag:add-model-helpers] lists LLM models before embedding models", () => {
      const { items } = buildModelDropdownData([
        { key: "a", value: "a", label: "A", kind: "llm" },
        { key: "e", value: "e", label: "E", kind: "embedding" },
        { key: "b", value: "b", label: "B", kind: "llm" },
      ])
      expect(items.map((i) => i.value)).toEqual(["a", "b", "e"])
    })

    it("[tag:add-model-helpers] splits models into LLM and Embedding groups", () => {
      const { groups } = buildModelDropdownData([
        { key: "a", value: "a", label: "A", kind: "llm" },
        { key: "e", value: "e", label: "E", kind: "embedding" },
        { key: "b", value: "b", label: "B", kind: "llm" },
      ])
      expect(groups.map((g) => g.label)).toEqual(["LLM", "Embedding"])
      expect(groups[0].items.map((i) => i.value)).toEqual(["a", "b"]);
      expect(groups[1].items.map((i) => i.value)).toEqual(["e"]);
    })

    it("[tag:add-model-helpers] omits a section when it has no models", () => {
      const { groups } = buildModelDropdownData([
        { key: "a", value: "a", label: "A", kind: "llm" },
      ])
      expect(groups.map((g) => g.label)).toEqual(["LLM"])
    })
  })

  describe("buildSelectedModelCardDetails", () => {
    const MODEL = { key: "gpt-4o", value: "gpt-4o", label: "GPT-4o", kind: "llm" as const }

    function detailsMap(config?: EditModelConfig): Record<string, string> {
      return Object.fromEntries(
        buildSelectedModelCardDetails(MODEL, config).map((d) => [d.label, d.value]),
      )
    }

    it("[tag:add-model-helpers] leaves throttling/pricing rows blank without a config", () => {
      const map = detailsMap()
      expect(map.Name).toBe("GPT-4o")
      expect(map.Type).toBe("LLM")
      expect(map.Model).toBe("GPT-4o")
      expect(map["Input cost per 1M tokens"]).toBe("")
      expect(map["Maximum requests per minute"]).toBe("")
      // No spending-limit row until a budget is set.
      expect(map).not.toHaveProperty("Spending limit")
    })

    it("[tag:add-model-helpers] surfaces custom throttling values", () => {
      const map = detailsMap({ ...BASE_CFG, throttlingTier: "custom" })
      expect(map["Maximum requests per minute"]).toBe("60")
      expect(map["Maximum tokens per minute"]).toBe("10000")
    })

    it("[tag:add-model-helpers] surfaces custom pricing normalised to per-1M", () => {
      const map = detailsMap({
        ...BASE_CFG,
        customPricingEnabled: true,
        pricingUnit: "per-1k",
        inputCostUsd: "1",
        outputCostUsd: "2",
      })
      expect(map["Input cost per 1M tokens"]).toBe("$1,000")
      expect(map["Output cost per 1M tokens"]).toBe("$2,000")
    })

    it("[tag:add-model-helpers] adds a spending-limit row only when a budget is set", () => {
      const map = detailsMap({
        ...BASE_CFG,
        spendingLimitEnabled: true,
        spendingLimitUsd: "1000",
        spendingPeriod: "per-week",
      })
      expect(map["Spending limit"]).toBe("$1,000 / week")
    })

    it("[tag:add-model-helpers] reports the embedding type", () => {
      const map = Object.fromEntries(
        buildSelectedModelCardDetails(
          { key: "emb", value: "emb", label: "Embed", kind: "embedding" },
        ).map((d) => [d.label, d.value]),
      )
      expect(map.Type).toBe("Embedding")
    })
  })
})

const PROJECT_STATE = {
  projectContext: { activeProject: { id: "proj-1", name: "Project One", role: "admin" } },
} as const

function renderAddModel() {
  return renderWithProviders(undefined, {
    routeConfig: [{ path: "/", element: <AddModel /> }],
    initialEntries: ["/"],
    preloadedState: PROJECT_STATE,
  })
}

describe("AddModel", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    // The available-models query is skipped until authenticated, but stub
    // fetch so opening the Configure modal (which lists credentials) is safe.
    mockFetchByUrl([{ match: "/credentials", data: [] }])
  })
  afterEach(() => {
    roCleanup?.()
    restoreAllMocks()
    vi.clearAllMocks()
  })

  it("[tag:add-model] renders the provider table and an unconfigured connection", () => {
    renderAddModel()
    expect(screen.getByText("Add model")).toBeInTheDocument()
    expect(screen.getByText("Provider details")).toBeInTheDocument()
    expect(screen.getByText("Providers (11)")).toBeInTheDocument()
    // Bifrost-supported providers added alongside the originals.
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("Google Gemini")).toBeInTheDocument()
    expect(screen.getByText("Cohere")).toBeInTheDocument()
    expect(screen.getByText("Perplexity")).toBeInTheDocument()
    expect(screen.getByText("Hugging Face")).toBeInTheDocument()
    expect(screen.getByText("Fireworks AI")).toBeInTheDocument()
    expect(screen.getByText("Connection status")).toBeInTheDocument()
    expect(screen.getByText("Not configured")).toBeInTheDocument()
  })

  it("[tag:add-model] paginates the provider list at 10 rows per page", async () => {
    renderAddModel()
    // Page 1 shows the first 10 providers; Ollama (11th) rolls to page 2.
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.queryByText("Ollama")).not.toBeInTheDocument()
    expect(screen.getByText("1 - 10 of 11")).toBeInTheDocument()

    const nextBtn = screen.getByRole("button", { name: "Next page" })
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()
    await userEvent.click(nextBtn)

    // Page 2 shows only the remaining provider(s).
    expect(await screen.findByText("Ollama")).toBeInTheDocument()
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument()
    expect(screen.getByText("11 - 11 of 11")).toBeInTheDocument()
    expect(nextBtn).toBeDisabled()

    await userEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(await screen.findByText("OpenAI")).toBeInTheDocument()
    expect(screen.queryByText("Ollama")).not.toBeInTheDocument()
  })

  it("[tag:add-model] filters the provider list from the search box", async () => {
    renderAddModel()
    // Search is collapsed by default; the icon toggles the input open.
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Search providers" }))

    const searchBox = screen.getByRole("searchbox", { name: "Search providers" })
    await userEvent.type(searchBox, "fire")

    expect(await screen.findByText("Fireworks AI")).toBeInTheDocument()
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument()
    expect(screen.getByText("Providers (1)")).toBeInTheDocument()

    // A non-matching query shows the empty state.
    await userEvent.clear(searchBox)
    await userEvent.type(searchBox, "zzzzz")
    expect(await screen.findByText(/No providers match/)).toBeInTheDocument()

    // Collapsing the search clears the query and restores the full list.
    await userEvent.click(screen.getByRole("button", { name: "Close provider search" }))
    expect(await screen.findByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Providers (11)")).toBeInTheDocument()
  })

  it("[tag:add-model] cycles the Name column sort indicator on repeated clicks", async () => {
    renderAddModel()
    const nameHeader = (): HTMLElement => screen.getAllByRole("columnheader")[1]
    expect(nameHeader()).toHaveAttribute("aria-sort", "none")

    const sortBtn = screen.getByRole("button", { name: "Sort by Name" })
    await userEvent.click(sortBtn)
    await waitFor(() => expect(nameHeader()).toHaveAttribute("aria-sort", "ascending"))
    await userEvent.click(sortBtn)
    await waitFor(() => expect(nameHeader()).toHaveAttribute("aria-sort", "descending"))
    await userEvent.click(sortBtn)
    await waitFor(() => expect(nameHeader()).toHaveAttribute("aria-sort", "none"))
  })

  it("[tag:add-model] selects a provider row on click", async () => {
    renderAddModel()
    await userEvent.click(screen.getByText("Azure OpenAI"))
    await waitFor(() =>
      expect(screen.getByText("Azure OpenAI").closest("tr")).toHaveAttribute("aria-selected", "true"),
    )
  })

  it("[tag:add-model] reveals the proxy configuration fields when toggled", async () => {
    renderAddModel()
    await userEvent.click(screen.getByRole("button", { name: /Proxy configuration/ }))
    expect(await screen.findByText("Concurrent requests")).toBeInTheDocument()
    expect(screen.getByText("Buffer size")).toBeInTheDocument()
  })

  it("[tag:add-model] shows a coming-soon placeholder on the self-hosted tab", async () => {
    renderAddModel()
    await userEvent.click(screen.getByRole("tab", { name: "Add self-hosted model" }))
    expect(
      await screen.findByText("Self-hosted models are coming soon"),
    ).toBeInTheDocument()
    expect(screen.queryByText("Authentication status")).not.toBeInTheDocument()
  })

  it("[tag:add-model] opens the provider Configure modal", async () => {
    renderAddModel()
    await userEvent.click(screen.getByRole("button", { name: "Configure" }))
    expect(await screen.findByText("Configure OpenAI")).toBeInTheDocument()
  })

  it("[tag:add-model] blocks adding before the provider connection is configured", async () => {
    renderAddModel()
    await userEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Configure the provider connection before adding models.",
      ),
    )
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})

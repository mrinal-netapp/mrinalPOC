import { screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"

import { EditModelModal } from "./edit-model-modal"
import type { EditModelConfig, EditModelModalModel } from "./edit-model-modal.types"

const MODEL: EditModelModalModel = { key: "gpt-4o", value: "gpt-4o", label: "GPT-4o" }

const SAVED_CFG: EditModelConfig = {
  name: "GPT-4o-prod",
  throttlingTier: "custom",
  maxRequestsPerMinute: "60",
  maxTokensPerMinute: "10000",
  customPricingEnabled: true,
  inputCostUsd: "5",
  outputCostUsd: "15",
  pricingUnit: "per-1m",
  spendingLimitEnabled: true,
  spendingLimitUsd: "1000",
  spendingPeriod: "per-week",
}

const PROJECT_STATE = {
  projectContext: { activeProject: { id: "proj-1", name: "Project One", role: "admin" } },
} as const

describe("EditModelModal", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => {
    roCleanup?.()
    restoreAllMocks()
    vi.clearAllMocks()
  })

  it("[tag:edit-model] does not render the body when closed or model is null", () => {
    const { rerender } = renderWithProviders(
      <EditModelModal open={false} onOpenChange={() => {}} model={MODEL} />,
    )
    expect(screen.queryByText("Model details")).not.toBeInTheDocument()

    rerender(<EditModelModal open onOpenChange={() => {}} model={null} />)
    expect(screen.queryByText("Model details")).not.toBeInTheDocument()
  })

  it("[tag:edit-model] renders the form seeded from the model when open", async () => {
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} />,
    )

    expect(await screen.findByText("Model details")).toBeInTheDocument()
    expect(screen.getByDisplayValue("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("Custom pricing")).toBeInTheDocument()
    expect(screen.getByText("Spending limit")).toBeInTheDocument()
    expect(screen.queryByText("Notification threshold")).not.toBeInTheDocument()
  })

  it("[tag:edit-model] emits the configured limits + pricing on Save and closes", async () => {
    const onSave = vi.fn()
    const onOpenChange = vi.fn()
    renderWithProviders(
      <EditModelModal open onOpenChange={onOpenChange} model={MODEL} onSave={onSave} />,
    )
    await screen.findByText("Model details")

    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(onSave).toHaveBeenCalledTimes(1)
    const [modelKey, config] = onSave.mock.calls[0]
    expect(modelKey).toBe("gpt-4o")
    expect(config).toMatchObject({
      name: "GPT-4o",
      maxRequestsPerMinute: "",
      maxTokensPerMinute: "",
      customPricingEnabled: false,
      inputCostUsd: "",
      outputCostUsd: "",
      pricingUnit: "per-1m",
      spendingLimitEnabled: false,
      spendingLimitUsd: "",
      spendingPeriod: "per-month",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("[tag:edit-model] collapsing Custom pricing flags it disabled in the saved config", async () => {
    const onSave = vi.fn()
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} onSave={onSave} />,
    )
    await screen.findByText("Model details")

    // Pricing section starts collapsed with empty defaults.
    expect(screen.queryByLabelText("Input cost, USD")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Custom pricing/ }))
    await waitFor(() => expect(screen.getByLabelText("Input cost, USD")).toBeInTheDocument())

    await userEvent.click(screen.getByRole("button", { name: /Custom pricing/ }))
    await waitFor(() => expect(screen.queryByLabelText("Input cost, USD")).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave.mock.calls[0][1].customPricingEnabled).toBe(false)
  })

  it("[tag:edit-model] emits the edited model name on Save", async () => {
    const onSave = vi.fn()
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} onSave={onSave} />,
    )
    await screen.findByText("Model details")

    const nameInput = screen.getByDisplayValue("GPT-4o")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "GPT-4o-prod")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(onSave.mock.calls[0][1].name).toBe("GPT-4o-prod")
  })

  it("[tag:edit-model] reflects edits to the model name in the form", async () => {
    const onSave = vi.fn()
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} onSave={onSave} />,
    )
    await screen.findByText("Model details")

    const nameInput = screen.getByDisplayValue("GPT-4o")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "GPT-4o-prod")
    expect(screen.getByDisplayValue("GPT-4o-prod")).toBeInTheDocument()
  })

  it("[tag:edit-model] shows the catalog list price hint under Custom pricing", async () => {
    mockFetchByUrl([
      {
        match: "/models/pricing-defaults",
        data: {
          provider: "openai",
          model: "gpt-4o",
          pricing: { inputCostPer1M: 2.5, outputCostPer1M: 10, source: "datasheet" },
        },
      },
    ])
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} provider="openai" />,
      { preloadedState: PROJECT_STATE },
    )
    await screen.findByText("Model details")

    await userEvent.click(screen.getByRole("button", { name: /Custom pricing/ }))

    const note = await screen.findByRole("note")
    expect(note.textContent).toContain("$2.50")
    expect(note.textContent).toContain("$10.00")
    // Exact match: no "approximate / closest match" caveat.
    expect(note.textContent).not.toContain("closest catalog match")
  })

  it("[tag:edit-model] flags an approximate catalog match with the resolved family id", async () => {
    const approxModel: EditModelModalModel = {
      key: "gpt-4o-mini-model",
      value: "gpt-4o-mini-model",
      label: "gpt-4o-mini-model",
    }
    mockFetchByUrl([
      {
        match: "/models/pricing-defaults",
        data: {
          provider: "azure",
          model: "gpt-4o-mini-model",
          pricing: {
            inputCostPer1M: 0.15,
            outputCostPer1M: 0.6,
            source: "builtin",
            matchedModel: "gpt-4o-mini",
            approximate: true,
          },
        },
      },
    ])
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={approxModel} provider="azure" />,
      { preloadedState: PROJECT_STATE },
    )
    await screen.findByText("Model details")
    await userEvent.click(screen.getByRole("button", { name: /Custom pricing/ }))

    const note = await screen.findByRole("note")
    expect(note.textContent).toContain("$0.15")
    expect(note.textContent).toContain("closest catalog match: gpt-4o-mini")
  })

  it("[tag:edit-model] 'Use these' prefills input/output cost from the catalog price", async () => {
    const onSave = vi.fn()
    mockFetchByUrl([
      {
        match: "/models/pricing-defaults",
        data: {
          provider: "openai",
          model: "gpt-4o",
          pricing: { inputCostPer1M: 2.5, outputCostPer1M: 10, source: "datasheet" },
        },
      },
    ])
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} provider="openai" onSave={onSave} />,
      { preloadedState: PROJECT_STATE },
    )
    await screen.findByText("Model details")
    await userEvent.click(screen.getByRole("button", { name: /Custom pricing/ }))
    await screen.findByRole("note")

    await userEvent.click(screen.getByRole("button", { name: "Use these" }))

    expect(screen.getByLabelText("Input cost, USD")).toHaveValue(2.5)
    expect(screen.getByLabelText("Output cost, USD")).toHaveValue(10)

    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave.mock.calls[0][1]).toMatchObject({ inputCostUsd: "2.5", outputCostUsd: "10" })
  })

  it("[tag:edit-model] omits the catalog hint when the model has no catalog price", async () => {
    mockFetchByUrl([
      {
        match: "/models/pricing-defaults",
        data: { provider: "openai", model: "gpt-4o", pricing: null },
      },
    ])
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} provider="openai" />,
      { preloadedState: PROJECT_STATE },
    )
    await screen.findByText("Model details")
    await userEvent.click(screen.getByRole("button", { name: /Custom pricing/ }))
    await waitFor(() => expect(screen.getByLabelText("Input cost, USD")).toBeInTheDocument())

    expect(screen.queryByRole("note")).not.toBeInTheDocument()
  })

  it("[tag:edit-model] seeds the form from a previously-saved config so edits persist", async () => {
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} initialConfig={SAVED_CFG} />,
    )
    await screen.findByText("Model details")

    // Name + custom throttling values restored.
    expect(screen.getByDisplayValue("GPT-4o-prod")).toBeInTheDocument()
    expect(screen.getByDisplayValue("60")).toBeInTheDocument()
    expect(screen.getByDisplayValue("10000")).toBeInTheDocument()
    // Collapsible sections reopen with their saved values.
    expect(screen.getByLabelText("Input cost, USD")).toHaveValue(5)
    expect(screen.getByLabelText("Output cost, USD")).toHaveValue(15)
    expect(screen.getByLabelText("Spending limit, USD")).toHaveValue(1000)
  })

  it("[tag:edit-model] re-emits the seeded config unchanged on Save", async () => {
    const onSave = vi.fn()
    renderWithProviders(
      <EditModelModal open onOpenChange={() => {}} model={MODEL} initialConfig={SAVED_CFG} onSave={onSave} />,
    )
    await screen.findByText("Model details")

    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave.mock.calls[0][1]).toMatchObject(SAVED_CFG)
  })

  it("[tag:edit-model] Cancel closes without emitting a config", async () => {
    const onSave = vi.fn()
    const onOpenChange = vi.fn()
    renderWithProviders(
      <EditModelModal open onOpenChange={onOpenChange} model={MODEL} onSave={onSave} />,
    )
    await screen.findByText("Model details")

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onSave).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the component
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockUpdateModel = vi.fn()

// Stable reference — must be declared outside the mock factory so the same
// object is returned on every render. A new object each call would change the
// `data` reference on every render, triggering an infinite useEffect loop in
// the component (useEffect depends on `data` and calls setForm which re-renders).
const MOCK_MODEL_DATA = {
  id: "model-mcp-01",
  name: "model-mcp-01",
  provider: "openai",
  providerModelId: "gpt-4o",
  rpm: 60,
  tpm: 10000,
  inputCostPer1M: 10,
  outputCostPer1M: 20,
  markupPercent: 15,
  spendingLimit: 1000,
  spendingLimitPeriod: "month",
}

// Stable reference for the catalog pricing hook result (see note above).
const MOCK_CATALOG_PRICING = {
  data: {
    inputCostPer1M: 2.5,
    outputCostPer1M: 7.5,
    source: "datasheet",
    matchedModel: "gpt-4o",
    approximate: false,
  },
}

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("@/routes/pages/models/models.api", () => ({
  useGetModelForEditQuery: () => ({
    data: MOCK_MODEL_DATA,
    isLoading: false,
    isError: false,
  }),
  useGetModelPricingDefaultsQuery: () => MOCK_CATALOG_PRICING,
  useUpdateModelMutation: () => [mockUpdateModel, { isLoading: false }],
}))

import { ModelEditPage } from "./model-edit-page"

const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Project 1", role: null },
  },
}

function renderModelEditPage() {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/models/:modelId/edit", element: <ModelEditPage /> },
      { path: "/models/:modelId", element: <div data-testid="model-detail" /> },
    ],
    initialEntries: ["/models/model-mcp-01/edit"],
    preloadedState: PROJECT_STATE,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateModel.mockReturnValue({
      unwrap: () => Promise.resolve({}),
    })
  })

  it("[tag:model-edit] renders model edit form fields", () => {
    renderModelEditPage()

    expect(screen.getByRole("heading", { level: 1, name: "Edit model" })).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument()
    expect(screen.getByRole("spinbutton", { name: "Maximum requests per minute" })).toBeInTheDocument()
  })

  it("[tag:model-edit] save calls update and navigates to detail", async () => {
    renderModelEditPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(mockUpdateModel).toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledWith("/models/model-mcp-01")
  })

  it("[tag:model-edit][tag:navigation] cancel navigates to model detail", async () => {
    renderModelEditPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockNavigate).toHaveBeenCalledWith("/models/model-mcp-01")
  })

  it("[tag:model-edit] shows the catalog list price hint under Custom pricing", () => {
    renderModelEditPage()

    expect(screen.getByRole("note")).toBeInTheDocument()
    expect(screen.getByText(/Catalog list price/)).toBeInTheDocument()
  })

  it("[tag:model-edit] 'Use these' prefills input/output cost from the catalog price", async () => {
    renderModelEditPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Use these" }))
    expect(screen.getByLabelText("Input cost, USD")).toHaveValue(2.5)
    expect(screen.getByLabelText("Output cost, USD")).toHaveValue(7.5)
  })
})

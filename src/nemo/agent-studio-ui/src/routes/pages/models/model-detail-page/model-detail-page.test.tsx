import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { ModelDetail } from "./model-detail-page.types"

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the component
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("./model-detail-page.api", () => ({
  useGetModelQuery: vi.fn(),
}))

vi.mock("@/routes/pages/models/models.api", () => ({
  useDeleteModelMutation: vi.fn(() => [vi.fn(), { isLoading: false }]),
  useListModelDependentsQuery: vi.fn(),
  useGetModelPricingDefaultsQuery: vi.fn(() => ({ data: undefined })),
}))

vi.mock("./panels/overview-panel", () => ({
  OverviewPanel: () => <div data-testid="overview-panel">Overview panel</div>,
}))

vi.mock("./panels/associated-resources-panel", () => ({
  AssociatedResourcesPanel: ({ dependents }: { dependents: unknown[] }) => (
    <div data-testid="associated-resources-panel">Associated resources ({dependents.length})</div>
  ),
}))

vi.mock("./panels/activity-panel", () => ({
  ActivityPanel: () => <div data-testid="activity-panel">Activity panel</div>,
}))

import { useGetModelQuery } from "./model-detail-page.api"
import { useListModelDependentsQuery } from "@/routes/pages/models/models.api"
import { ModelDetailPage } from "./model-detail-page"

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
  description: "Test model description",
  labels: ["Staging"],
  model: "gpt-4-turbo-preview",
  maxRequestsPerMinute: 1000,
  maxTokensPerMinute: 2000000,
  lastTimeUpdated: "Feb 11, 2026, 1:08:23 PM",
  created: "Feb 10, 2026, 7:15:06 AM",
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

const SUCCESS_DEPENDENTS_RESULT = {
  data: {
    items: [
      { kind: "agent", id: "agent-01", name: "Agent One", relation: "uses_model" },
      { kind: "agent", id: "agent-02", name: "Agent Two", relation: "uses_model" },
    ],
    totalByKind: { agent: 2 },
  },
  isLoading: false,
  isFetching: false,
  isSuccess: true,
  isError: false,
  refetch: vi.fn(),
} as ReturnType<typeof useListModelDependentsQuery>

type GetModelResult = ReturnType<typeof useGetModelQuery>

function makeQueryResult(overrides: Partial<GetModelResult> = {}): GetModelResult {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
    currentData: undefined,
    endpointName: "getModel",
    fulfilledTimeStamp: undefined,
    isUninitialized: false,
    originalArgs: undefined,
    requestId: undefined,
    startedTimeStamp: undefined,
    status: "uninitialized",
    ...overrides,
  } as unknown as GetModelResult
}

const SUCCESS_RESULT = makeQueryResult({
  data: MOCK_MODEL,
  isSuccess: true,
  status: "fulfilled",
})

function renderModelDetailPage() {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/models/:modelId", element: <ModelDetailPage /> },
      { path: "/models", element: <div data-testid="models-list" /> },
    ],
    initialEntries: ["/models/model-mcp-01"],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useListModelDependentsQuery).mockReturnValue(SUCCESS_DEPENDENTS_RESULT)
  })

  it("[tag:model-detail][tag:loading] shows loading state while fetching", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({ isLoading: true, status: "pending" }),
    )
    renderModelDetailPage()

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument()
  })

  it("[tag:model-detail][tag:error] shows error message on fetch failure", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 500, data: undefined }, status: "rejected" }),
    )
    renderModelDetailPage()

    expect(screen.getByText("Failed to load model.")).toBeInTheDocument()
  })

  it("[tag:model-detail][tag:error] back button navigates to Models list on error", async () => {
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 500, data: undefined }, status: "rejected" }),
    )
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Back to Models" }))
    expect(mockNavigate).toHaveBeenCalledWith("/models")
  })

  it("[tag:model-detail][tag:not-found] shows not found message when model does not exist", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 404, data: undefined }, status: "rejected" }),
    )
    renderModelDetailPage()

    expect(screen.getByText("Model not found.")).toBeInTheDocument()
  })

  it("[tag:model-detail][tag:not-found] shows not found message when response is empty", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({ data: undefined, isSuccess: true, status: "fulfilled" }),
    )
    renderModelDetailPage()

    expect(screen.getByText("Model not found.")).toBeInTheDocument()
  })

  it("[tag:model-detail][tag:not-found] shows not found on 404 even when stale data is still cached", () => {
    // RTK Query retains the last successful `data` when a subsequent request
    // errors. Simulate: a model loaded successfully, then was deleted on the
    // backend; the next refetch returns 404 but `data` is still populated.
    // The page MUST render the not-found UI, not fall through to stale success.
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({
        data: MOCK_MODEL,
        isError: true,
        error: { status: 404, data: undefined },
        status: "rejected",
      }),
    )
    renderModelDetailPage()

    expect(screen.getByText("Model not found.")).toBeInTheDocument()
    expect(screen.queryByTestId("overview-panel")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
  })

  it("[tag:model-detail][tag:not-found] back button navigates to Models list on not-found", async () => {
    vi.mocked(useGetModelQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 404, data: undefined }, status: "rejected" }),
    )
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Back to Models" }))
    expect(mockNavigate).toHaveBeenCalledWith("/models")
  })

  it("[tag:model-detail] success state renders the page title", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    expect(screen.getByText("Model details")).toBeInTheDocument()
  })

  it("[tag:model-detail] success state renders breadcrumbs", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    expect(screen.getByText("Models")).toBeInTheDocument()
    // "model-mcp-01" appears in both the breadcrumb and the Name summary field
    expect(screen.getAllByText("model-mcp-01").length).toBeGreaterThanOrEqual(1)
  })

  it("[tag:model-detail] success state renders summary field values", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("LLM")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("[tag:model-detail] Overview tab is active by default", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    expect(screen.getByTestId("overview-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("activity-panel")).not.toBeInTheDocument()
  })

  it("[tag:model-detail] Associated Resources tab label shows agent count", () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    expect(screen.getByRole("tab", { name: "Associated resources (2)" })).toBeInTheDocument()
  }, 15000)

  it("[tag:model-detail] switching to Associated Resources tab shows the panel", async () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    await user.click(await screen.findByRole("tab", { name: "Associated resources (2)" }))

    expect(await screen.findByTestId("associated-resources-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("overview-panel")).not.toBeInTheDocument()
  }, 15000)

  it("[tag:model-detail] switching to Activity tab shows the panel", async () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    await user.click(await screen.findByRole("tab", { name: "Activity" }))

    expect(await screen.findByTestId("activity-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("overview-panel")).not.toBeInTheDocument()
  }, 15000)

  it("[tag:model-detail] Edit menu item and Actions button are rendered", async () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    expect(screen.getByRole("button", { name: "Actions" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Actions" }))
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument()
  }, 15000)

  it("[tag:model-detail] Refresh button calls refetch", async () => {
    const refetch = vi.fn()
    vi.mocked(useGetModelQuery).mockReturnValue({ ...SUCCESS_RESULT, refetch } as GetModelResult)
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    expect(refetch).toHaveBeenCalled()
  }, 15000)

  it("[tag:model-detail][tag:edit] Edit menu item navigates to the model edit page", async () => {
    vi.mocked(useGetModelQuery).mockReturnValue(SUCCESS_RESULT)
    renderModelDetailPage()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }))
    expect(mockNavigate).toHaveBeenCalledWith("/models/model-mcp-01/edit")
  }, 15000)
})

import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router"

import { renderWithProviders, userEvent } from "@test/render"
import { createMockStore, mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"
import { evalApi } from "@/routes/pages/evaluations/api/eval-api.slice"

const { mockNavigate, mockParams, mockToast, mockUseListAgents } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockParams: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  mockUseListAgents: vi.fn(),
}))
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => mockParams() }
})
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListAgentsQuery: () => mockUseListAgents(),
  useListProjectModelsQuery: () => ({ data: [] }),
}))
vi.mock("@/ui-lib/base-components/toast/toast", () => ({ toast: mockToast }))

import { EvalDetailPage } from "./eval-detail-page"

const PROJECT_ID = "proj-1"
const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: PROJECT_ID, name: "Project 1", role: null },
  },
}

const TEMPLATE = {
  templateId: "evt-1",
  projectId: PROJECT_ID,
  evalName: "Finance eval",
  target: "agent_version",
  agent: { agentId: "agt-1", agentVersion: "latest" },
  models: ["gpt-4o"],
  evaluationScope: "full_agent_execution",
  suite: "rag",
  evaluators: { strategy: "both", aiJudge: { models: ["gpt-4o"], dimensions: ["helpfulness"] }, deterministic: { metrics: ["rag_quality"] } },
  runMode: "single",
}

const RUN = { runId: "run-1", templateId: "evt-1", name: "Run 1", status: "completed", results: { domainMetrics: {} } }

describe("EvalDetailPage", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    vi.clearAllMocks()
    mockUseListAgents.mockReturnValue({ data: [{ id: "agt-1", name: "Finance agent" }] })
  })
  afterEach(() => { roCleanup?.(); restoreAllMocks() })

  it("[tag:eval] shows a spinner when there is no templateId", () => {
    mockParams.mockReturnValue({})
    mockFetchByUrl([{ match: "/templates", data: TEMPLATE }])
    const { container } = renderWithProviders(<EvalDetailPage />, { preloadedState: PROJECT_STATE })
    expect(container.querySelector(".eval-detail__loading")).toBeInTheDocument()
  })

  it("[tag:eval] shows a not-found state on error and navigates back", async () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    mockFetchByUrl([
      { match: "/agents/runs", data: [] },
      { match: "/templates/evt-1", data: { error: "no" }, status: 500 },
    ])
    const user = userEvent.setup()
    renderWithProviders(<EvalDetailPage />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Evaluation not found.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Back to Evaluations" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] renders the summary, tabs and edit action once loaded", async () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    mockFetchByUrl([
      { match: "/agents/runs", data: [RUN] },
      { match: "/templates/evt-1", data: TEMPLATE },
    ])
    const user = userEvent.setup()
    renderWithProviders(<EvalDetailPage />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Evaluation details")).toBeInTheDocument()
    expect(screen.getByText("Deterministic with AI judge")).toBeInTheDocument()
    expect(screen.getAllByText("Finance agent").length).toBeGreaterThan(0)
    expect(screen.getByText("Run overview")).toBeInTheDocument()
    expect(screen.getByText("Runs (1)")).toBeInTheDocument()
    expect(screen.getByText("Evaluation test cases")).toBeInTheDocument()
    expect(
      screen.getByText("Runs (1)").compareDocumentPosition(screen.getByText("Evaluation test cases")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Edit" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] falls back to list-cache values and placeholders for a sparse template", async () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    // No agent ref, no evaluators block → exercises the nullish fallbacks.
    const SPARSE = { templateId: "evt-1", projectId: "proj-1", evalName: "Sparse eval", target: "agent_version", models: [], evaluationScope: "full_agent_execution", suite: "rag", runMode: "single" }
    const LIST_ITEM = { templateId: "evt-1", evalName: "Sparse eval", latestRunStatus: "completed", runCount: 7 }
    mockFetchByUrl([
      { match: "/agents/runs", data: { error: "no runs" }, status: 500 },
      { match: "/templates/evt-1", data: SPARSE },
      { match: "/templates", data: [LIST_ITEM] },
    ])
    mockUseListAgents.mockReturnValue({ data: [] })

    const store = createMockStore(PROJECT_STATE)
    // Populate the list-query cache so the detail page's fast-path selector resolves.
    await store.dispatch(evalApi.endpoints.listEvaluations.initiate({ projectId: PROJECT_ID }))

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EvalDetailPage />
        </MemoryRouter>
      </Provider>,
    )

    expect(await screen.findByText("Evaluation details")).toBeInTheDocument()
    // runCount + latestRunStatus come from the cached list item (runs query errored).
    expect(screen.getByText("Runs (7)")).toBeInTheDocument()
  })

  it("[tag:eval] defaults run status and count when neither runs nor cache are available", async () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    // Runs query errors and the list cache is empty → status/count fall through to defaults.
    mockFetchByUrl([
      { match: "/agents/runs", data: { error: "no" }, status: 500 },
      { match: "/templates/evt-1", data: TEMPLATE },
    ])
    renderWithProviders(<EvalDetailPage />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Evaluation details")).toBeInTheDocument()
    expect(screen.getByText("Runs (0)")).toBeInTheDocument()
  })

  it("[tag:eval] shows the raw strategy when it has no friendly label", async () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    const WEIRD = { ...TEMPLATE, evaluators: { strategy: "weird_strategy" } }
    mockFetchByUrl([
      { match: "/agents/runs", data: [RUN] },
      { match: "/templates/evt-1", data: WEIRD },
    ])
    renderWithProviders(<EvalDetailPage />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("weird_strategy")).toBeInTheDocument()
  })

  it("[tag:eval] deletes an evaluation from the detail actions menu", async () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    const fetchMock = mockFetchByUrl([
      { match: "/agents/runs", data: [RUN] },
      { match: "/templates/evt-1", data: TEMPLATE },
    ])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalDetailPage />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Evaluation details")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))

    expect(await screen.findByText(/Are you sure you want to delete/)).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!)

    await screen.findByText("Evaluation details")
    const deleteRequest = fetchMock.mock.calls
      .map(([request]) => request as Request)
      .find((request) => request.url.includes("/templates/evt-1") && request.method === "DELETE")
    expect(deleteRequest).toBeDefined()
    expect(mockToast.success).toHaveBeenCalledWith("\"Finance eval\" deleted successfully.")
    expect(mockNavigate).toHaveBeenCalledWith("/evaluations")
  })
})

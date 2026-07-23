import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"

const { mockToast, mockUseListAgents } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  mockUseListAgents: vi.fn(),
}))
vi.mock("@/ui-lib/base-components/toast/toast", () => ({ toast: mockToast }))
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListAgentsQuery: () => mockUseListAgents(),
}))

import { EvalRunsPanel } from "./eval-runs-panel"

const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Project 1", role: null },
  },
}

// Match the persisted EvaluationResults wire shape (eval-worker /
// config-service): dimensions[].headline carries the per-metric values,
// not a flat `domainMetrics` map.
const RESULTS_RUN_FULL = {
  verdict: "pass",
  triggeredGates: [],
  dimensions: [
    {
      id: "ai-judge",
      label: "AI judge",
      headline: { "Mean AI judge score": 88 },
    },
  ],
  coverage: { total: 1, completed: 1, completedPct: 100 },
  infraFailureRate: 0,
  judgeCoverage: { scored: 0, target: 0, pct: 0 },
  preFlightNonPromotable: false,
  runStopped: false,
}

const RESULTS_RUN_DETAIL = {
  verdict: "pass",
  triggeredGates: [],
  dimensions: [
    { id: "judge", label: "Judge", headline: { Helpfulness: 90 } },
  ],
  coverage: { total: 1, completed: 1, completedPct: 100 },
  infraFailureRate: 0,
  judgeCoverage: { scored: 0, target: 0, pct: 0 },
  preFlightNonPromotable: false,
  runStopped: false,
}

const RUN_FULL = {
  runId: "run-1",
  name: "Completed run",
  status: "completed",
  baselineStatus: "not_set",
  results: RESULTS_RUN_FULL,
  trigger: { triggeredAt: "2026-02-10" },
  templateSnapshot: {
    agent: { agentId: "agt-1" },
    evaluators: {
      strategy: "both",
      aiJudge: {
        models: ["gpt-4o"],
        dimensions: ["helpfulness", "correctness", "completeness", "coherence"],
      },
    },
  },
}

const RUN_BARE = {
  runId: "run-2",
  name: "Queued run",
  status: "queued",
  baselineStatus: "not_set",
}

const RUN_DETAIL = {
  runId: "run-1",
  name: "Completed run",
  status: "completed",
  results: RESULTS_RUN_DETAIL,
}

describe("EvalRunsPanel", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    vi.clearAllMocks()
    mockUseListAgents.mockReturnValue({ data: [{ id: "agt-1", name: "Finance agent" }] })
  })
  afterEach(() => { roCleanup?.(); restoreAllMocks() })

  function routes() {
    mockFetchByUrl([
      { match: "/runs/run-1", data: RUN_DETAIL },
      { match: "/templates", data: { runId: "x", workflowId: "wf", status: "queued" } },
      { match: "/agents/runs", data: [RUN_FULL, RUN_BARE] },
    ])
  }

  it("[tag:eval] renders run rows with resolved agent name, strategy and judge details", async () => {
    routes()
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Completed run")).toBeInTheDocument()
    expect(screen.getByText("Queued run")).toBeInTheDocument()
    expect(screen.getAllByText("Finance agent").length).toBeGreaterThan(0)
    expect(screen.getByText("88%")).toBeInTheDocument()
    // 4 dimensions → first 3 + " +1"
    expect(screen.getByText(/Helpfulness, Correctness, Completeness \+1/)).toBeInTheDocument()
  })

  it("[tag:eval] opens the results dialog from the run name link", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Completed run" }))
    // The dialog renders the run name in its title.
    await waitFor(() => expect(screen.getAllByText("Completed run").length).toBeGreaterThan(1))
  })

  it("[tag:eval] triggers a run again from the actions menu", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Queued run" }))
    await user.click(await screen.findByText("Run again"))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Run queued successfully."))
  })

  it("[tag:eval] opens and closes the results dialog from the View button", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "View" }))
    await waitFor(() => expect(screen.getAllByText("Completed run").length).toBeGreaterThan(1))

    // Closing the dialog drives the onOpenChange(false) handler.
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.getAllByText("Completed run").length).toBe(1))
  })

  it("[tag:eval] resolves unknown dimensions and strategies and renders a short dimension list", async () => {
    const RUN_ODD = {
      runId: "run-3",
      name: "Odd run",
      status: "completed",
      baselineStatus: "not_set",
      results: {
        verdict: "pass",
        triggeredGates: [],
        dimensions: [],
        coverage: { total: 0, completed: 0, completedPct: 0 },
        infraFailureRate: 0,
        judgeCoverage: { scored: 0, target: 0, pct: 0 },
        preFlightNonPromotable: false,
        runStopped: false,
      },
      trigger: { triggeredAt: "2026-03-01" },
      templateSnapshot: {
        // agentId not present in the agents list → resolver falls back to the raw id.
        agent: { agentId: "agt-unknown" },
        evaluators: {
          strategy: "weird_strategy",
          aiJudge: { models: ["m"], dimensions: ["helpfulness", "made_up_dim"] },
        },
      },
    }
    mockFetchByUrl([
      { match: "/templates", data: { runId: "x", workflowId: "wf", status: "queued" } },
      { match: "/agents/runs", data: [RUN_ODD] },
    ])
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    // Unknown dimension id echoed verbatim; 2 dims → no "+N" suffix.
    expect(await screen.findByText("Helpfulness, made_up_dim")).toBeInTheDocument()
    expect(screen.getByText("weird_strategy")).toBeInTheDocument()
  })

  it("[tag:eval] renders an empty table when the runs query errors", async () => {
    mockFetchByUrl([{ match: "/agents/runs", data: { error: "no" }, status: 500 }])
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    await waitFor(() => expect(screen.queryByText("Completed run")).not.toBeInTheDocument())
  })

  it("[tag:eval] surfaces an error toast when the run again fails", async () => {
    mockFetchByUrl([
      { match: "/templates", data: { error: "no" }, status: 500 },
      { match: "/agents/runs", data: [RUN_FULL, RUN_BARE] },
    ])
    const user = userEvent.setup()
    renderWithProviders(<EvalRunsPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Completed run" }))
    await user.click(await screen.findByText("Run again"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Failed to start run."))
  })
})

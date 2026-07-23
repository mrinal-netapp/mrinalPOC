import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"

const { mockToast } = vi.hoisted(() => ({ mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("@/ui-lib/base-components/toast/toast", () => ({ toast: mockToast }))

import { EvalRunOverviewPanel } from "./eval-run-overview-panel"

const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Project 1", role: null },
  },
}

const RUN = {
  runId: "run-1",
  templateId: "evt-1",
  name: "Latest run",
  status: "completed",
  results: {
    verdict: "pass",
    triggeredGates: [],
    dimensions: [
      {
        id: "ai-judge",
        label: "AI judge",
        headline: { "Mean AI judge score": 88, Helpfulness: 91 },
      },
    ],
    coverage: { total: 1, completed: 1, completedPct: 100 },
    infraFailureRate: 0,
    judgeCoverage: { scored: 0, target: 0, pct: 0 },
    preFlightNonPromotable: false,
    runStopped: false,
  },
}

describe("EvalRunOverviewPanel", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => restoreAllMocks())

  it("[tag:eval] shows an empty state when there are no runs", async () => {
    mockFetchByUrl([{ match: "/agents/runs", data: [] }])
    renderWithProviders(<EvalRunOverviewPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("No runs yet for this evaluation.")).toBeInTheDocument()
  })

  it("[tag:eval] renders the latest run overview and triggers a new run", async () => {
    mockFetchByUrl([
      { match: "/templates/", data: { runId: "run-x", workflowId: "wf", status: "queued" } },
      { match: "/agents/runs", data: [RUN] },
    ])
    const user = userEvent.setup()
    renderWithProviders(<EvalRunOverviewPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Overview")).toBeInTheDocument()
    expect(screen.getByText("AI judge")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Run again" }))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Run queued successfully."))
  })

  it("[tag:eval] defaults metrics and gate outcome when the run has no results", async () => {
    const bareRun = { runId: "run-2", templateId: "evt-1", name: "Bare run", status: "completed" }
    mockFetchByUrl([{ match: "/agents/runs", data: [bareRun] }])
    renderWithProviders(<EvalRunOverviewPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    // Still renders the overview card (with empty metrics) rather than the empty state.
    expect(await screen.findByText("Overview")).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error toast when triggering a run fails", async () => {
    mockFetchByUrl([
      { match: "/templates/", data: { error: "no" }, status: 500 },
      { match: "/agents/runs", data: [RUN] },
    ])
    const user = userEvent.setup()
    renderWithProviders(<EvalRunOverviewPanel templateId="evt-1" />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Run again" }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Failed to start run."))
  })
})

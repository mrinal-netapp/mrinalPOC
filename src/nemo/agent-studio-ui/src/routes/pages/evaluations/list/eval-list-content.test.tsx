import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router"

import { renderWithProviders, userEvent } from "@test/render"
import { createMockStore, mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"
import { setEvalFilters } from "@/store/slices/eval.slice"

const { mockNavigate, mockToast } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})
vi.mock("@/ui-lib/base-components/toast/toast", () => ({ toast: mockToast }))

import { EvalListContent } from "./eval-list-content"

const LIST = [
  { templateId: "evt-1", evalName: "Finance eval", runCount: 2, labels: ["finance"], latestRunStatus: "completed" },
  { templateId: "evt-2", evalName: "Support eval", runCount: 0, labels: [] },
]
const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Project 1", role: null },
  },
}

describe("EvalListContent", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    vi.clearAllMocks()
  })
  afterEach(() => { roCleanup?.(); restoreAllMocks() })

  function routes(opts: { triggerStatus?: number; deleteStatus?: number } = {}) {
    mockFetchByUrl([
      { match: "/runs", data: { runId: "x", status: "queued" }, status: opts.triggerStatus },
      { match: "/templates/evt", data: {}, status: opts.deleteStatus },
      { match: "/templates", data: LIST },
    ])
  }

  it("[tag:eval] renders evaluation rows and navigates to create from the Add action", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    expect(await screen.findByText("Finance eval")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] navigates to detail when the evaluation name is clicked", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Finance eval" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] closes the confirm dialog on cancel without deleting", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument())
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it("[tag:eval] passes active list filters to the query", async () => {
    routes()
    const store = createMockStore(PROJECT_STATE)
    store.dispatch(setEvalFilters({ status: "completed" }))

    render(
      <Provider store={store}>
        <MemoryRouter>
          <EvalListContent />
        </MemoryRouter>
      </Provider>,
    )

    expect(await screen.findByText("Finance eval")).toBeInTheDocument()
  })

  it("[tag:eval] starts a manual run from the row actions menu", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("Start manual run"))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Run queued for "Finance eval".'))
  })

  it("[tag:eval] navigates from View details and Edit menu actions", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("View details"))
    expect(mockNavigate).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("Edit"))
    expect(mockNavigate).toHaveBeenCalledTimes(2)
  })

  it("[tag:eval] deletes an evaluation through the confirm dialog", async () => {
    routes()
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('"Finance eval" deleted successfully.'))
  })

  it("[tag:eval] surfaces an error toast when deletion fails", async () => {
    routes({ deleteStatus: 500 })
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Failed to delete "Finance eval".'))
  })

  it("[tag:eval] surfaces an error toast when a manual run fails", async () => {
    routes({ triggerStatus: 500 })
    const user = userEvent.setup()
    renderWithProviders(<EvalListContent />, { preloadedState: PROJECT_STATE })

    await user.click(await screen.findByRole("button", { name: "Actions for Finance eval" }))
    await user.click(await screen.findByText("Start manual run"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Failed to start run for "Finance eval".'))
  })
})

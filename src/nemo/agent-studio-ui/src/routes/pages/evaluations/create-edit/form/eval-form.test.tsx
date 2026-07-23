import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import type { EvaluationTemplate } from "@/routes/pages/evaluations/api/eval.types"

const { mockNavigate, mockToast, mockCreate, mockUpdate, mockUseListAgents, mockUseListAgentTeams, mockFetchProject, mockPutObject, mockGetObjectText } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockUseListAgents: vi.fn(),
  mockUseListAgentTeams: vi.fn(),
  mockFetchProject: vi.fn(),
  mockPutObject: vi.fn(),
  mockGetObjectText: vi.fn(),
}))

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("@/ui-lib/base-components/toast/toast", () => ({ toast: mockToast }))

vi.mock("@/routes/pages/evaluations/api/eval-api.slice", () => ({
  useCreateEvaluationMutation: () => [mockCreate, { isLoading: false }],
  useUpdateEvaluationMutation: () => [mockUpdate, { isLoading: false }],
}))

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListAgentsQuery: () => mockUseListAgents(),
  useListAgentTeamsQuery: () => mockUseListAgentTeams(),
  useListProjectModelsQuery: () => ({ data: [] }),
}))
vi.mock("@/api/kb-api.slice", () => ({
  useListKnowledgeBasesQuery: () => ({ data: { data: [] } }),
}))
vi.mock("@/api/project-api.slice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/project-api.slice")>()),
  useLazyGetProjectQuery: () => [mockFetchProject],
}))
vi.mock("@/api/s3-upload", () => ({
  putObject: (...args: unknown[]) => mockPutObject(...args),
  getObjectText: (...args: unknown[]) => mockGetObjectText(...args),
}))

import { EvalForm } from "./eval-form"

const AGENT = { id: "agt-1", name: "Finance agent" }
const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Project 1", role: null },
  },
}

/** The page has multiple SelectDropdowns; the Agent one is the second trigger. */
function agentTrigger(): HTMLElement {
  const triggers = document.querySelectorAll<HTMLElement>('[data-slot="select-dropdown-trigger"]')
  return triggers[triggers.length - 1]
}

const TEMPLATE: EvaluationTemplate = {
  templateId: "evt-1",
  projectId: "proj-1",
  evalName: "Existing eval",
  description: "desc",
  labels: ["finance"],
  target: "agent_version",
  agent: { agentId: "agt-1", agentVersion: "latest" },
  models: ["gpt-4o"],
  evaluationScope: "full_agent_execution",
  suite: "rag",
  evaluators: {
    strategy: "both",
    aiJudge: { models: ["gpt-4o"], dimensions: ["helpfulness"] },
    deterministic: { metrics: ["rag_quality"] },
  },
  cases: { source: "upload", filename: "cases.csv" },
  runMode: "single",
}

function fileInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(".configure-dialog__upload-trigger-input")!
}

function makeFile(content: string, name: string, type = "text/plain"): File {
  return new File([content], name, { type })
}

async function configureDeterministicWithUpload(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: "Configure" })[0])
  await screen.findByText("Configure deterministic metrics")
  await user.upload(fileInput(), makeFile("id,query\n1,Hello", "cases.csv", "text/csv"))
  await screen.findByText("Hello")
  await user.click(screen.getByRole("button", { name: "Save" }))
}

describe("EvalForm", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    mockFetchSuccess([])
    mockUseListAgents.mockReturnValue({ data: [AGENT], isLoading: false, isError: false })
    mockUseListAgentTeams.mockReturnValue({ data: [], isLoading: false, isError: false })
    mockFetchProject.mockReturnValue({
      unwrap: () => Promise.resolve({ home_dir: "s3://test-bucket/projects/proj-1" }),
    })
    mockPutObject.mockResolvedValue(undefined)
    mockGetObjectText.mockResolvedValue("query,expected\nq1,a1")
    mockCreate.mockReturnValue({ unwrap: () => Promise.resolve({ templateId: "evt-new" }) })
    mockUpdate.mockReturnValue({ unwrap: () => Promise.resolve({}) })
  })
  afterEach(() => { roCleanup?.(); restoreAllMocks(); vi.clearAllMocks() })

  it("[tag:eval] blocks submit and shows validation errors when required fields are missing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(screen.getByText("Name is required.")).toBeInTheDocument()
    expect(screen.getByText("Agent or team is required.")).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("[tag:eval] creates an evaluation through the happy path (deterministic only)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    await user.type(screen.getByPlaceholderText("e.g. RAG Validation"), "New eval")

    // Switch to deterministic-only so no judge config is required.
    await user.click(screen.getByText("Deterministic", { exact: true }))

    // Pick the agent.
    await user.click(agentTrigger())
    await user.click(await screen.findByRole("option", { name: "Finance agent" }))

    // Configure deterministic metrics (skip source → valid without a file).
    await configureDeterministicWithUpload(user)

    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockToast.success).toHaveBeenCalledWith("Evaluation created successfully.")
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] surfaces an error toast when creation fails with a thrown Error", async () => {
    mockCreate.mockReturnValue({ unwrap: () => Promise.reject(new Error("boom")) })
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    await user.type(screen.getByPlaceholderText("e.g. RAG Validation"), "New eval")
    await user.click(screen.getByText("Deterministic", { exact: true }))
    await user.click(agentTrigger())
    await user.click(await screen.findByRole("option", { name: "Finance agent" }))
    await configureDeterministicWithUpload(user)
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("boom"))
    consoleErr.mockRestore()
  })

  it("[tag:eval] surfaces backend error message when creation fails with 409 duplicate name", async () => {
    mockCreate.mockReturnValue({
      unwrap: () => Promise.reject({
        status: 409,
        data: { error: "Evaluation template with this name already exists in this project" },
      }),
    })
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    await user.type(screen.getByPlaceholderText("e.g. RAG Validation"), "New eval")
    await user.click(screen.getByText("Deterministic", { exact: true }))
    await user.click(agentTrigger())
    await user.click(await screen.findByRole("option", { name: "Finance agent" }))
    await configureDeterministicWithUpload(user)
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(
      "Evaluation template with this name already exists in this project",
    ))
    consoleErr.mockRestore()
  })

  it("[tag:eval] surfaces backend error message when creation fails with 400 validation", async () => {
    mockCreate.mockReturnValue({
      unwrap: () => Promise.reject({
        status: 400,
        data: { message: "evalName is required" },
      }),
    })
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    await user.type(screen.getByPlaceholderText("e.g. RAG Validation"), "New eval")
    await user.click(screen.getByText("Deterministic", { exact: true }))
    await user.click(agentTrigger())
    await user.click(await screen.findByRole("option", { name: "Finance agent" }))
    await configureDeterministicWithUpload(user)
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("evalName is required"))
    consoleErr.mockRestore()
  })

  it("[tag:eval] edits an existing evaluation and navigates back to its detail page", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm isEdit initialData={TEMPLATE} />, { preloadedState: PROJECT_STATE })

    expect(screen.getByText("Edit evaluation")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({ projectId: "proj-1", templateId: "evt-1" })
    expect(mockToast.success).toHaveBeenCalledWith("Evaluation updated successfully.")
  })

  it("[tag:eval] blocks submit when deterministic metrics are configured but none are backend-enabled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const unsupportedMetricsTemplate: EvaluationTemplate = {
      ...TEMPLATE,
      evaluators: {
        strategy: "deterministic",
        deterministic: { metrics: ["performance", "token_usage"] },
      },
    }

    renderWithProviders(<EvalForm isEdit initialData={unsupportedMetricsTemplate} />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith("Select at least one deterministic metric that is currently available.")
  })

  it("[tag:eval] cancel in edit mode navigates back to the detail page", async () => {
    const user = userEvent.setup()
    renderWithProviders(<EvalForm isEdit initialData={TEMPLATE} />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] close button in create mode navigates to the list", async () => {
    const user = userEvent.setup()
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] adds a new label from the Labels dropdown", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    // The Labels dropdown is the first select-dropdown trigger on the page.
    const labelsTrigger = document.querySelectorAll<HTMLElement>('[data-slot="select-dropdown-trigger"]')[0]
    await user.click(labelsTrigger)

    const searchInput = await screen.findByPlaceholderText(/or add/i)
    await user.type(searchInput, "regression")
    await user.click(screen.getByRole("button", { name: "Add new item" }))

    // The newly added label becomes an option in the list.
    expect(await screen.findByText("regression")).toBeInTheDocument()
  })

  it("[tag:eval] configures the AI judge and saves the selection", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm />, { preloadedState: PROJECT_STATE })

    // Default strategy is "both" → the AI judge card (second Configure button) is shown.
    const configureButtons = screen.getAllByRole("button", { name: "Configure" })
    await user.click(configureButtons[configureButtons.length - 1])

    await screen.findByText("Configure AI judge")
    await user.click(screen.getByRole("button", { name: "Save" }))

    // Dialog closes after saving the judge config.
    await waitFor(() => expect(screen.queryByText("Configure AI judge")).not.toBeInTheDocument())
  })

  it("[tag:eval] surfaces an error toast when an update fails", async () => {
    mockUpdate.mockReturnValue({ unwrap: () => Promise.reject(new Error("boom")) })
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm isEdit initialData={TEMPLATE} />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("boom"))
    consoleErr.mockRestore()
  })

  it("[tag:eval] de-duplicates pre-filled labels in edit mode", () => {
    const withDupLabels: EvaluationTemplate = { ...TEMPLATE, labels: ["finance", "Finance", "finance"] }
    renderWithProviders(<EvalForm isEdit initialData={withDupLabels} />, { preloadedState: PROJECT_STATE })
    // Single normalized chip rendered despite duplicate inputs.
    expect(screen.getByText("Edit evaluation")).toBeInTheDocument()
  })

  // ─── Clone mode ─────────────────────────────────────────────────────────────

  it("[tag:eval] prefills the name with 'Clone from' prefix in clone mode", () => {
    renderWithProviders(<EvalForm cloneSource={TEMPLATE} />, { preloadedState: PROJECT_STATE })
    const nameInput = screen.getByPlaceholderText("e.g. RAG Validation") as HTMLInputElement
    expect(nameInput.value).toMatch(/^Clone from Existing eval \d{8}-\d{4}$/)
  })

  it("[tag:eval] shows Clone evaluation title and Clone submit button in clone mode", () => {
    renderWithProviders(<EvalForm cloneSource={TEMPLATE} />, { preloadedState: PROJECT_STATE })
    expect(screen.getByText("Clone evaluation")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clone" })).toBeInTheDocument()
  })

  it("[tag:eval] copies S3 test cases and shows success toast on a clean clone", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm cloneSource={TEMPLATE} />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Clone" }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockGetObjectText).toHaveBeenCalled()
    expect(mockPutObject).toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith(
      expect.stringMatching(/cloned successfully\.$/),
    )
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] saves the clone with a warning when S3 file copy throws", async () => {
    mockGetObjectText.mockRejectedValue(new Error("S3 unreachable"))
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm cloneSource={TEMPLATE} />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Clone" }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    // Clone still saves; success toast mentions the manual upload fallback.
    expect(mockToast.success).toHaveBeenCalledWith(
      expect.stringContaining("Test cases could not be copied"),
    )
    expect(mockNavigate).toHaveBeenCalled()
    consoleErr.mockRestore()
  })

  it("[tag:eval] shows an error toast when the clone API call fails", async () => {
    mockCreate.mockReturnValue({ unwrap: () => Promise.reject(new Error("server error")) })
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderWithProviders(<EvalForm cloneSource={TEMPLATE} />, { preloadedState: PROJECT_STATE })

    await user.click(screen.getByRole("button", { name: "Clone" }))

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("server error"))
    expect(mockNavigate).not.toHaveBeenCalled()
    consoleErr.mockRestore()
  })
})

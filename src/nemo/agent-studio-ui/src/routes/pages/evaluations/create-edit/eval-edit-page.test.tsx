import { screen } from "@testing-library/react"
import { describe, expect, it, vi, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

const { mockNavigate, mockParams, mockGetEval } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockParams: vi.fn(),
  mockGetEval: vi.fn(),
}))

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => mockParams() }
})

vi.mock("@/routes/pages/evaluations/api/eval-api.slice", () => ({ useGetEvaluationQuery: () => mockGetEval() }))

vi.mock("./form/eval-form", () => ({ EvalForm: () => <div data-testid="eval-form" /> }))

import { EvalEditPage } from "./eval-edit-page"

describe("EvalEditPage", () => {
  afterEach(() => vi.clearAllMocks())

  it("[tag:eval] shows a spinner while loading", () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    mockGetEval.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    const { container } = renderWithProviders(<EvalEditPage />)
    expect(container.querySelector(".eval-edit-page__center")).toBeInTheDocument()
  })

  it("[tag:eval] shows a spinner when there is no templateId", () => {
    mockParams.mockReturnValue({})
    mockGetEval.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    const { container } = renderWithProviders(<EvalEditPage />)
    expect(container.querySelector(".eval-edit-page__center")).toBeInTheDocument()
  })

  it("[tag:eval] shows a not-found state on error and navigates back", async () => {
    const user = userEvent.setup()
    mockParams.mockReturnValue({ templateId: "evt-1" })
    mockGetEval.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<EvalEditPage />)

    expect(screen.getByText("Evaluation not found.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Back to Evaluations" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:eval] renders the form once the template loads", () => {
    mockParams.mockReturnValue({ templateId: "evt-1" })
    mockGetEval.mockReturnValue({ data: { templateId: "evt-1" }, isLoading: false, isError: false })
    renderWithProviders(<EvalEditPage />)
    expect(screen.getByTestId("eval-form")).toBeInTheDocument()
  })
})

import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

const { mockNavigate, mockUseGetEvaluation, mockSearchParamsState } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseGetEvaluation: vi.fn(),
  // Mutable so each test can set a different cloneFrom value.
  mockSearchParamsState: { params: new URLSearchParams() },
}))

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [mockSearchParamsState.params, vi.fn()],
  }
})

vi.mock("./form/eval-form", () => ({ EvalForm: () => <div data-testid="eval-form" /> }))

vi.mock("@/routes/pages/evaluations/api/eval-api.slice", () => ({
  useGetEvaluationQuery: (...args: unknown[]) => mockUseGetEvaluation(...args),
}))

import { EvalCreatePage } from "./eval-create-page"

describe("EvalCreatePage", () => {
  beforeEach(() => {
    mockSearchParamsState.params = new URLSearchParams()
    mockUseGetEvaluation.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  })

  it("[tag:eval] renders the shared eval form when cloneFrom is absent", () => {
    renderWithProviders(<EvalCreatePage />)
    expect(screen.getByTestId("eval-form")).toBeInTheDocument()
  })

  it("[tag:eval] shows a spinner while the cloneFrom template is loading", () => {
    mockSearchParamsState.params = new URLSearchParams("cloneFrom=evt-1")
    mockUseGetEvaluation.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderWithProviders(<EvalCreatePage />)
    // Spinner renders — the form must NOT appear while loading.
    expect(screen.queryByTestId("eval-form")).not.toBeInTheDocument()
  })

  it("[tag:eval] shows not-found UI when the cloneFrom query errors or returns nothing", async () => {
    mockSearchParamsState.params = new URLSearchParams("cloneFrom=evt-missing")
    mockUseGetEvaluation.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<EvalCreatePage />)
    expect(await screen.findByText("Evaluation not found.")).toBeInTheDocument()
    expect(screen.queryByTestId("eval-form")).not.toBeInTheDocument()
  })
})

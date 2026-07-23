import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"
import type { Credential } from "../credential.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./credential-rotate-form", () => ({
  CredentialRotateForm: ({ credential }: { credential: Credential }) => (
    <div
      data-testid="credential-rotate-form"
      data-name={credential.name}
      data-provider={credential.provider}
    />
  ),
}))

const mockGetCredential = vi.fn()

vi.mock("../credential-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credential-api.slice")>()
  return {
    ...actual,
    useGetCredentialQuery: (...args: unknown[]) => mockGetCredential(...args),
  }
})

import { CredentialRotatePage } from "./credential-rotate-page"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CREDENTIAL: Credential = {
  id: "cred-abc",
  projectId: "proj-1",
  name: "openai-key",
  provider: "openai",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function renderRotatePage(credId?: string) {
  const path = credId ? `/credentials/${credId}/rotate` : "/credentials/rotate"
  const routePath = credId ? "/credentials/:credId/rotate" : "/credentials/rotate"

  return renderWithProviders(undefined, {
    routeConfig: [
      { path: routePath, element: <CredentialRotatePage /> },
      { path: "/credentials", element: <div data-testid="credentials-list" /> },
    ],
    initialEntries: [path],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialRotatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:credential-rotate-page] no credId param → redirects to credentials list", async () => {
    mockGetCredential.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderRotatePage(undefined)

    await waitFor(() => {
      expect(screen.getByTestId("credentials-list")).toBeInTheDocument()
    })
  })

  it("[tag:credential-rotate-page][tag:loading] isLoading → spinner shown, form hidden", () => {
    mockGetCredential.mockReturnValue({ data: undefined, isLoading: true, isError: false })

    renderRotatePage("cred-abc")

    expect(screen.queryByTestId("credential-rotate-form")).not.toBeInTheDocument()
    const loadingDiv = document.querySelector(".cred-form-page__loading")
    expect(loadingDiv).toBeInTheDocument()
  })

  it("[tag:credential-rotate-page][tag:error] error state → error message shown", () => {
    mockGetCredential.mockReturnValue({ data: undefined, isLoading: false, isError: true })

    renderRotatePage("cred-abc")

    expect(screen.getByText("Failed to load credential.")).toBeInTheDocument()
    expect(screen.queryByTestId("credential-rotate-form")).not.toBeInTheDocument()
  })

  it("[tag:credential-rotate-page] data loaded → CredentialRotateForm receives credential", () => {
    mockGetCredential.mockReturnValue({ data: MOCK_CREDENTIAL, isLoading: false, isError: false })

    renderRotatePage("cred-abc")

    const form = screen.getByTestId("credential-rotate-form")
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute("data-name", "openai-key")
    expect(form).toHaveAttribute("data-provider", "openai")
  })
})

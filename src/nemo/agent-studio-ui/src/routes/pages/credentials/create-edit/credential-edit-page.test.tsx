import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"
import type { Credential } from "../credential.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./credential-form", () => ({
  CredentialForm: ({ isEdit, initialData }: { isEdit?: boolean; initialData?: Credential }) => (
    <div
      data-testid="credential-form"
      data-is-edit={isEdit ? "true" : "false"}
      data-name={initialData?.name}
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

import { CredentialEditPage } from "./credential-edit-page"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CREDENTIAL: Credential = {
  id: "cred-abc",
  projectId: "proj-1",
  name: "my-openai-key",
  provider: "openai",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function renderEditPage(credId?: string) {
  const path = credId ? `/credentials/${credId}/edit` : "/credentials/edit"
  const routePath = credId ? "/credentials/:credId/edit" : "/credentials/edit"

  return renderWithProviders(undefined, {
    routeConfig: [
      { path: routePath, element: <CredentialEditPage /> },
      { path: "/credentials", element: <div data-testid="credentials-list" /> },
    ],
    initialEntries: [path],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:credential-edit-page] no credId param → redirects to credentials list", async () => {
    mockGetCredential.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderEditPage(undefined)

    await waitFor(() => {
      expect(screen.getByTestId("credentials-list")).toBeInTheDocument()
    })
  })

  it("[tag:credential-edit-page][tag:loading] isLoading → spinner shown, form hidden", () => {
    mockGetCredential.mockReturnValue({ data: undefined, isLoading: true, isError: false })

    renderEditPage("cred-abc")

    expect(screen.queryByTestId("credential-form")).not.toBeInTheDocument()
    const loadingDiv = document.querySelector(".cred-form-page__loading")
    expect(loadingDiv).toBeInTheDocument()
  })

  it("[tag:credential-edit-page][tag:error] error state → error message shown", () => {
    mockGetCredential.mockReturnValue({ data: undefined, isLoading: false, isError: true })

    renderEditPage("cred-abc")

    expect(screen.getByText("Failed to load credential.")).toBeInTheDocument()
    expect(screen.queryByTestId("credential-form")).not.toBeInTheDocument()
  })

  it("[tag:credential-edit-page] data loaded → CredentialForm receives isEdit and initialData", () => {
    mockGetCredential.mockReturnValue({ data: MOCK_CREDENTIAL, isLoading: false, isError: false })

    renderEditPage("cred-abc")

    const form = screen.getByTestId("credential-form")
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute("data-is-edit", "true")
    expect(form).toHaveAttribute("data-name", "my-openai-key")
  })
})

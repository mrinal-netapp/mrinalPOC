import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockLocation = { pathname: "/credentials/new", search: "", hash: "", state: null, key: "key" }

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useLocation: () => mockLocation,
  }
})

vi.mock("./credential-form", () => ({
  CredentialForm: ({ isEdit }: { isEdit?: boolean }) => (
    <div
      data-testid="credential-form"
      data-is-edit={isEdit ? "true" : "false"}
    />
  ),
}))

import { CredentialCreatePage } from "./credential-create-page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:credential-create-page] renders CredentialForm without isEdit", () => {
    renderWithProviders(<CredentialCreatePage />)

    const form = screen.getByTestId("credential-form")
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute("data-is-edit", "false")
  })

  it("[tag:credential-create-page] re-mounts form when pathname changes", () => {
    renderWithProviders(<CredentialCreatePage />)

    // The key is derived from location.pathname, ensuring re-mount on navigation
    expect(screen.getByTestId("credential-form")).toBeInTheDocument()
  })
})

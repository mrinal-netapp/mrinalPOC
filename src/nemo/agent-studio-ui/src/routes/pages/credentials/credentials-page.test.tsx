import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders } from "@test/render"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./credentials-list", () => ({
  CredentialsList: () => <div data-testid="credentials-list" />,
}))

import { CredentialsPage } from "./credentials-page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialsPage", () => {
  it("[tag:credentials-page] renders the credentials list", () => {
    renderWithProviders(<CredentialsPage />)

    expect(screen.getByTestId("credentials-list")).toBeInTheDocument()
  })
})

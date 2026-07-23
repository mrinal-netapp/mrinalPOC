import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders } from "@test/render"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/components/models", () => ({
  ModelsOverview: () => <div data-testid="models-overview" />,
}))

import { ModelsPage } from "./models-page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelsPage", () => {
  it("[tag:models-page] renders the models overview", () => {
    renderWithProviders(<ModelsPage />)

    expect(screen.getByTestId("models-overview")).toBeInTheDocument()
  })
})

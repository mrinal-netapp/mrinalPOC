import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@test/render"

vi.mock("./eval-list-content", () => ({ EvalListContent: () => <div data-testid="list-content" /> }))

import { EvalListPage } from "./eval-list-page"

describe("EvalListPage", () => {
  it("[tag:eval] renders the page header and the list content", () => {
    renderWithProviders(<EvalListPage />)

    expect(screen.getByText("Evaluations")).toBeInTheDocument()
    expect(screen.getByTestId("list-content")).toBeInTheDocument()
  })
})

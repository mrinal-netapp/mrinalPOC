import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"
import type { EvalRunStatus } from "@/routes/pages/evaluations/api/eval.types"
import { EvalStatusCell } from "./eval-status-cell"

describe("EvalStatusCell", () => {
  it("[tag:eval] renders a placeholder when no status is supplied", () => {
    const { container } = renderWithProviders(<EvalStatusCell />)

    expect(container.querySelector(".eval-list-cell-placeholder")).toHaveTextContent("—")
  })

  it.each<[EvalRunStatus, string]>([
    ["queued", "Queued"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["stopped", "Stopped"],
  ])("[tag:eval] renders an icon + label for %s", (status, label) => {
    renderWithProviders(<EvalStatusCell status={status} />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it.each<[EvalRunStatus, string]>([
    ["running", "Running"],
    ["scoring", "Scoring"],
  ])("[tag:eval] renders a spinner + label for %s", (status, label) => {
    const { container } = renderWithProviders(<EvalStatusCell status={status} />)

    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.querySelector(".ds-status-spinner")).toBeInTheDocument()
  })
})

import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { EvaluationRun } from "@/routes/pages/evaluations/api/eval.types"
import { EvalRunDetailsDialog } from "./eval-run-details-dialog"

function run(partial: Partial<EvaluationRun>): EvaluationRun {
  return {
    runId: "run-1",
    templateId: "evt-1",
    name: "Run details",
    status: "completed",
    ...partial,
  } as EvaluationRun
}

describe("EvalRunDetailsDialog", () => {
  it("[tag:eval] renders metric sections when the run has domain metrics", () => {
    renderWithProviders(
      <EvalRunDetailsDialog
        open
        onOpenChange={vi.fn()}
        run={run({
          results: {
            verdict: "pass",
            triggeredGates: [],
            dimensions: [
              { id: "judge", label: "Judge", headline: { Helpfulness: 90 } },
            ],
            coverage: { total: 1, completed: 1, completedPct: 100 },
            infraFailureRate: 0,
            judgeCoverage: { scored: 0, target: 0, pct: 0 },
            preFlightNonPromotable: false,
            runStopped: false,
          },
        } as Partial<EvaluationRun>)}
      />,
    )

    expect(screen.getByText("Overview")).toBeInTheDocument()
    expect(screen.getByText("AI judge")).toBeInTheDocument()
  })

  it("[tag:eval] shows the in-progress empty state for a running run", () => {
    renderWithProviders(
      <EvalRunDetailsDialog open onOpenChange={vi.fn()} run={run({ status: "running", results: undefined })} />,
    )

    expect(screen.getByText(/Run in progress/)).toBeInTheDocument()
  })

  it("[tag:eval] shows the no-data empty state for a finished run with no metrics", () => {
    renderWithProviders(
      <EvalRunDetailsDialog open onOpenChange={vi.fn()} run={run({ status: "completed", results: undefined })} />,
    )

    expect(screen.getByText(/No results data available/)).toBeInTheDocument()
  })

  it("[tag:eval] calls onOpenChange(false) when Close is clicked", async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <EvalRunDetailsDialog open onOpenChange={onOpenChange} run={run({ results: undefined })} />,
    )

    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

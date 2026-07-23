import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"
import type {
  EvaluationDimension,
  EvaluationResults,
  EvaluationRun,
  EvaluationTriggeredGate,
} from "@/routes/pages/evaluations/api/eval.types"
import { EvalRunResultsBreakdown } from "./eval-run-results-breakdown"

function run(partial: Partial<EvaluationRun>): EvaluationRun {
  return {
    runId: "run-1",
    templateId: "evt-1",
    name: "Run 1",
    status: "completed",
    ...partial,
  } as EvaluationRun
}

/** Build a minimal results object — fields the breakdown reads directly
 *  (coverage, infraFailureRate, qualityPct, dimensions, triggeredGates,
 *  verdict) plus the wire-shape required fields the type insists on. */
function results(partial: {
  verdict?: EvaluationResults["verdict"]
  triggeredGates?: EvaluationTriggeredGate[]
  dimensions?: EvaluationDimension[]
  coverage?: EvaluationResults["coverage"]
  infraFailureRate?: number
  qualityPct?: number
}): EvaluationResults {
  return {
    verdict: partial.verdict ?? "pass",
    triggeredGates: partial.triggeredGates ?? [],
    dimensions: partial.dimensions ?? [],
    coverage: partial.coverage ?? { total: 0, completed: 0, completedPct: 0 },
    infraFailureRate: partial.infraFailureRate ?? 0,
    judgeCoverage: { scored: 0, target: 0, pct: 0 },
    preFlightNonPromotable: false,
    runStopped: false,
    qualityPct: partial.qualityPct,
  }
}

describe("EvalRunResultsBreakdown", () => {
  it("[tag:eval] shows in-progress copy for a queued/running run with no results", () => {
    renderWithProviders(<EvalRunResultsBreakdown run={run({ status: "running", results: undefined })} />)

    expect(screen.getByText(/Run in progress/)).toBeInTheDocument()
  })

  it("[tag:eval] shows the no-data copy for a finished run with no results", () => {
    renderWithProviders(<EvalRunResultsBreakdown run={run({ status: "completed", results: undefined })} />)

    expect(screen.getByText(/No results data available/)).toBeInTheDocument()
  })

  it("[tag:eval] renders headline KPIs, domain metrics and a passed gate", () => {
    renderWithProviders(
      <EvalRunResultsBreakdown
        run={run({
          results: results({
            verdict: "pass",
            coverage: { total: 7, completed: 7, completedPct: 100 },
            infraFailureRate: 0.005, // 0.5%
            qualityPct: 92,
            dimensions: [
              { id: "judge", label: "Judge", headline: { Helpfulness: 93 } },
            ],
            triggeredGates: [
              {
                id: "coverage",
                level: "blocking",
                status: "passed",
                threshold: 0,
                actual: 100,
                message: "",
              },
            ],
          }),
        })}
      />,
    )

    expect(screen.getByText("Test case coverage")).toBeInTheDocument()
    // failure/error key → one decimal place
    expect(screen.getByText("0.5%")).toBeInTheDocument()
    // normal metric → rounded
    expect(screen.getByText("93%")).toBeInTheDocument()
    expect(screen.getByText("All gates passed")).toBeInTheDocument()
    expect(screen.getByText("Pass")).toBeInTheDocument()
  })

  it("[tag:eval] renders a failed gate with the failed gate names", () => {
    renderWithProviders(
      <EvalRunResultsBreakdown
        run={run({
          results: results({
            verdict: "fail",
            triggeredGates: [
              {
                id: "latency",
                level: "blocking",
                status: "failed",
                threshold: 0,
                actual: 0,
                message: "",
              },
              {
                id: "accuracy",
                level: "blocking",
                status: "failed",
                threshold: 0,
                actual: 0,
                message: "",
              },
            ],
          }),
        })}
      />,
    )

    expect(screen.getByText(/Failed gates: latency, accuracy/)).toBeInTheDocument()
    expect(screen.getByText("Fail")).toBeInTheDocument()
  })

  it("[tag:eval] renders an em dash when verdict is non-pass but no blocking gate is flagged", () => {
    renderWithProviders(
      <EvalRunResultsBreakdown
        run={run({
          results: results({
            verdict: "blocked",
            triggeredGates: [
              {
                id: "preflight_policy",
                level: "warning",
                status: "failed",
                threshold: null,
                actual: null,
                message: "",
              },
            ],
          }),
        })}
      />,
    )

    expect(screen.getByText(/Failed gates: —/)).toBeInTheDocument()
  })
})

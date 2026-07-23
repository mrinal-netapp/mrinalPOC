import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"
import type { EvaluationRun } from "@/routes/pages/evaluations/api/eval.types"
import {
  EvalRunMetricSections,
  GateOutcomeCard,
  RunOverviewCard,
} from "./eval-run-metric-sections"

const DOMAIN_METRICS: Record<string, number> = {
  Helpfulness: 93, // ai-judge, pass, has tooltip
  Groundedness: 60, // rag-quality, warn (percent < 70)
  "Token F1": 71, // correctness, pass
  "P95 latency": 2100, // performance, ms, neutral
  "Total tokens": 31250, // token-usage, tokens, neutral
  "Mystery metric": 5, // leftover, raw, no tooltip
}

describe("EvalRunMetricSections", () => {
  it("[tag:eval] renders a card per group, a leftovers card and a gate card", () => {
    renderWithProviders(
      <EvalRunMetricSections
        domainMetrics={DOMAIN_METRICS}
        gateOutcome={{ passed: true, failedGates: [] }}
      />,
    )

    expect(screen.getByText("AI judge")).toBeInTheDocument()
    expect(screen.getByText("RAG quality")).toBeInTheDocument()
    expect(screen.getByText("Correctness")).toBeInTheDocument()
    expect(screen.getByText("Performance")).toBeInTheDocument()
    expect(screen.getByText("Token usage")).toBeInTheDocument()
    expect(screen.getByText("Other metrics")).toBeInTheDocument()
    expect(screen.getByText("Gate results")).toBeInTheDocument()
    // ms >= 1000 → seconds
    expect(screen.getByText("2.1 s")).toBeInTheDocument()
    // tokens → locale string
    expect(screen.getByText((31250).toLocaleString())).toBeInTheDocument()
  })

  it("[tag:eval] omits groups with no metrics and the gate card when no outcome", () => {
    renderWithProviders(
      <EvalRunMetricSections domainMetrics={{ Helpfulness: 80 }} gateOutcome={null} />,
    )

    expect(screen.getByText("AI judge")).toBeInTheDocument()
    expect(screen.queryByText("Performance")).not.toBeInTheDocument()
    expect(screen.queryByText("Gate results")).not.toBeInTheDocument()
    // "Other metrics" now surfaces only the derived Mean AI judge score (raw
    // unmapped backend keys are intentionally suppressed) when AI-judge
    // dimensions are present.
    expect(screen.getByText("Other metrics")).toBeInTheDocument()
    expect(screen.getByText("Mean AI judge score")).toBeInTheDocument()
  })
})

describe("GateOutcomeCard", () => {
  it("[tag:eval] renders a passed result", () => {
    renderWithProviders(<GateOutcomeCard passed failedGates={[]} />)
    expect(screen.getByText("All gates passed")).toBeInTheDocument()
  })

  it("[tag:eval] renders failed gates and an em dash when none are named", () => {
    const { rerender } = renderWithProviders(<GateOutcomeCard passed={false} failedGates={["latency"]} />)
    expect(screen.getByText("Failed: latency")).toBeInTheDocument()

    rerender(<GateOutcomeCard passed={false} failedGates={[]} />)
    expect(screen.getByText("Failed: —")).toBeInTheDocument()
  })
})

describe("RunOverviewCard", () => {
  const run = { runId: "run-1", templateId: "evt-1", name: "Nightly run", status: "completed" } as EvaluationRun

  it("[tag:eval] renders the mean judge headline plus one KPI per group", () => {
    renderWithProviders(
      <RunOverviewCard
        run={run}
        domainMetrics={{ "Mean AI judge score": 88, ...DOMAIN_METRICS }}
      />,
    )

    expect(screen.getByText("Nightly run")).toBeInTheDocument()
    expect(screen.getByText("Mean AI judge score")).toBeInTheDocument()
    expect(screen.getByText("88%")).toBeInTheDocument()
  })

  it("[tag:eval] renders only the run identity when there are no headline metrics", () => {
    renderWithProviders(<RunOverviewCard run={run} domainMetrics={{}} />)

    expect(screen.getByText("Nightly run")).toBeInTheDocument()
    expect(screen.queryByText("Mean AI judge score")).not.toBeInTheDocument()
  })
})

describe("EvalRunMetricSections — RAG quality section", () => {
  it("[tag:eval] lists all three RAG metrics, with em dash for ones the backend omits", () => {
    renderWithProviders(
      <EvalRunMetricSections domainMetrics={{ "rag.groundedness": 0.85 }} gateOutcome={null} />,
    )

    expect(screen.getByText("RAG quality")).toBeInTheDocument()
    expect(screen.getByText("Groundedness")).toBeInTheDocument()
    expect(screen.getByText("85%")).toBeInTheDocument() // 0.85 fraction -> 85%
    // precision/recall absent from the contract -> shown as placeholders.
    expect(screen.getByText("Retrieval precision")).toBeInTheDocument()
    expect(screen.getByText("Retrieval recall")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2)
  })

  it("[tag:eval] hides the RAG section when every RAG value is absent or zero", () => {
    // Mirrors the real contract sample: only rag.groundedness, and it is 0.
    renderWithProviders(
      <EvalRunMetricSections domainMetrics={{ "rag.groundedness": 0 }} gateOutcome={null} />,
    )

    expect(screen.queryByText("RAG quality")).not.toBeInTheDocument()
  })
})

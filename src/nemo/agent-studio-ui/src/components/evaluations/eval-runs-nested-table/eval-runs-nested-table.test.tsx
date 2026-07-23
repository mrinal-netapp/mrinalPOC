import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { EvalRunsNestedTable, type EvalRunRow } from "./eval-runs-nested-table"

const ROW: EvalRunRow = {
  runId: "run-1",
  name: "Nightly run",
  status: "completed",
  agentName: "Finance agent",
  strategy: "Deterministic with AI judge",
  dimensions: ["Helpfulness", "Correctness"],
  lastRun: "2 hours ago",
  triggeredBy: "Sarah",
}

const BASELINE_ROW: EvalRunRow = {
  ...ROW,
  runId: "run-2",
  name: "Baseline run",
  baselineStatus: "Current baseline",
}

describe("EvalRunsNestedTable", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:eval] renders an empty state when there are no runs", () => {
    renderWithProviders(<EvalRunsNestedTable runs={[]} />)

    expect(screen.getByText("No evaluation runs yet.")).toBeInTheDocument()
  })

  it("[tag:eval] renders a row with its name, agent, strategy and dimensions", () => {
    renderWithProviders(<EvalRunsNestedTable runs={[ROW]} />)

    expect(screen.getByText("Nightly run")).toBeInTheDocument()
    expect(screen.getByText("Finance agent")).toBeInTheDocument()
    expect(screen.getByText("Helpfulness")).toBeInTheDocument()
  })

  it("[tag:eval] fires onRun and onSetBaseline from the actions menu", async () => {
    const onRun = vi.fn()
    const onSetBaseline = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <EvalRunsNestedTable runs={[ROW]} onRun={onRun} onSetBaseline={onSetBaseline} />,
    )

    await user.click(screen.getByRole("button", { name: "Actions for Nightly run" }))
    await user.click(await screen.findByText("Run"))
    expect(onRun).toHaveBeenCalledWith(ROW)

    await user.click(screen.getByRole("button", { name: "Actions for Nightly run" }))
    await user.click(await screen.findByText("Set as baseline"))
    expect(onSetBaseline).toHaveBeenCalledWith(ROW)
  })

  it("[tag:eval] hides the baseline action for the current baseline run", async () => {
    const user = userEvent.setup()

    renderWithProviders(<EvalRunsNestedTable runs={[BASELINE_ROW]} />)

    await user.click(screen.getByRole("button", { name: "Actions for Baseline run" }))
    expect(screen.queryByText("Set as baseline")).not.toBeInTheDocument()
    // No handlers supplied — clicking Run exercises the optional-call branch.
    await user.click(await screen.findByText("Run"))
  })
})

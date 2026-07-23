import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import type { EvalScoringStrategy, EvalDatasetColumnMapping } from "@/routes/pages/evaluations/api/eval.types"
import { EvalScoringSection } from "./eval-scoring-section"

const MAPPING: EvalDatasetColumnMapping = { id: "", query: "", expected: undefined }

function fileInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(".configure-dialog__upload-trigger-input")!
}

function makeFile(content: string, name: string, type = "text/plain"): File {
  return new File([content], name, { type })
}

function setup(props: Partial<Parameters<typeof EvalScoringSection>[0]> = {}) {
  const onStrategyChange = vi.fn()
  const onJudgeConfigSave = vi.fn()
  const onDeterministicConfigSave = vi.fn()
  const utils = renderWithProviders(
    <EvalScoringSection
      strategy={"both" as EvalScoringStrategy}
      judgeModel="gpt-4o"
      judgeDimensionIds={["helpfulness"]}
      deterministicMetricIds={["rag_quality"]}
      isJudgeConfigured
      isDeterministicConfigured
      datasetColumnMapping={MAPPING}
      uploadedFileName=""
      submitted={false}
      onStrategyChange={onStrategyChange}
      onJudgeConfigSave={onJudgeConfigSave}
      onDeterministicConfigSave={onDeterministicConfigSave}
      {...props}
    />,
  )
  return { onStrategyChange, onJudgeConfigSave, onDeterministicConfigSave, ...utils }
}

describe("EvalScoringSection", () => {
  beforeEach(() => { mockFetchSuccess([]) })
  afterEach(() => { restoreAllMocks() })

  it("[tag:eval] shows both configure cards for the 'both' strategy", () => {
    setup()
    expect(screen.getByText("Deterministic metrics")).toBeInTheDocument()
    expect(screen.getByText("AI judge")).toBeInTheDocument()
    // configured labels resolve to titles
    expect(screen.getByText("RAG quality")).toBeInTheDocument()
  })

  it("[tag:eval] hides the AI judge card for the deterministic strategy", () => {
    setup({ strategy: "deterministic" as EvalScoringStrategy })
    expect(screen.getByText("Deterministic metrics")).toBeInTheDocument()
    expect(screen.queryByText("AI judge")).not.toBeInTheDocument()
  })

  it("[tag:eval] shows 'Not configured' state and error styling when unconfigured + submitted", () => {
    setup({ isDeterministicConfigured: false, isJudgeConfigured: false, judgeModel: "", submitted: true })
    expect(screen.getAllByText("Required — click Configure").length).toBeGreaterThan(0)
    expect(screen.getByText(/Deterministic metrics must be configured/)).toBeInTheDocument()
    expect(screen.getByText(/AI judge must be configured/)).toBeInTheDocument()
  })

  it("[tag:eval] shows 'Not configured' (no error) when unconfigured and not submitted", () => {
    setup({ isDeterministicConfigured: false, isJudgeConfigured: false, judgeModel: "" })
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0)
  })

  it("[tag:eval] renders the uploaded-file test-case state", () => {
    setup({ uploadedFileName: "cases.csv" })
    expect(screen.getByText("Enabled")).toBeInTheDocument()
    expect(screen.getByText("cases.csv")).toBeInTheDocument()
  })

  it("[tag:eval] changes strategy via the radio group", async () => {
    const user = userEvent.setup()
    const { onStrategyChange } = setup()
    await user.click(screen.getByText("Deterministic", { exact: true }))
    expect(onStrategyChange).toHaveBeenCalledWith("deterministic")
  })

  it("[tag:eval] opens the deterministic dialog and saves", async () => {
    const user = userEvent.setup()
    const { onDeterministicConfigSave } = setup()

    const configureButtons = screen.getAllByRole("button", { name: "Configure" })
    await user.click(configureButtons[0]) // deterministic is first
    expect(await screen.findByText("Configure deterministic metrics")).toBeInTheDocument()
    await user.upload(fileInput(), makeFile("id,query\n1,Hello", "cases.csv", "text/csv"))
    await screen.findByText("Hello")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onDeterministicConfigSave).toHaveBeenCalled()
  })

  it("[tag:eval] shows an em dash when configured ids resolve to no known labels", () => {
    setup({
      isDeterministicConfigured: true,
      isJudgeConfigured: true,
      deterministicMetricIds: ["unknown-metric"],
      judgeDimensionIds: ["unknown-dimension"],
    })
    // Both the Metrics and Dimensions rows collapse to the em-dash fallback.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2)
  })

  it("[tag:eval] opens the AI judge dialog and saves", async () => {
    const user = userEvent.setup()
    const { onJudgeConfigSave } = setup()

    const configureButtons = screen.getAllByRole("button", { name: "Configure" })
    await user.click(configureButtons[1]) // judge is second
    expect(await screen.findByText("Configure AI judge")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onJudgeConfigSave).toHaveBeenCalled()
  })
})

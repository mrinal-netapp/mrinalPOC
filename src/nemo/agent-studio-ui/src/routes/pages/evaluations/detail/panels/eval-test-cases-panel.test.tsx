import { screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"
import { mockResizeObserver } from "@test/mocks"
import { getObjectText } from "@/api/s3-upload"
import { EvalTestCasesPanel } from "./eval-test-cases-panel"

vi.mock("@/api/s3-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/s3-upload")>()
  return {
    ...actual,
    getObjectText: vi.fn(),
  }
})

const PROJECT = {
  id: "local-dev-project",
  name: "Local Dev Project",
  home_dir: "s3://default-nemo/projects/local-dev-project",
}

const RUNS = [
  {
    runId: "run-1",
    templateId: "evt-1",
    projectId: "local-dev-project",
    name: "Run 1",
    status: "completed",
    baselineStatus: "not_set",
    templateSnapshot: {
      evalName: "Test Eval",
      evaluators: {
        strategy: "both",
        aiJudge: { models: ["GPT-4o"], dimensions: ["helpfulness", "correctness"] },
        deterministic: { metrics: ["RAG quality", "Performance"] },
      },
    },
  },
  {
    runId: "run-2",
    templateId: "evt-1",
    projectId: "local-dev-project",
    name: "Run 2 selected snapshot",
    status: "completed",
    baselineStatus: "not_set",
    templateSnapshot: {
      evalName: "Test Eval",
      evaluators: {
        strategy: "deterministic",
        aiJudge: { models: ["GPT-4.1"], dimensions: [] },
        deterministic: { metrics: ["Performance"] },
      },
    },
  },
]

const CASES_CSV = [
  "id,query,expected_answer",
  'case-001,How do I reset my finance dashboard?,"Open settings, choose Dashboard, then select Reset."',
  "case-002,Summarize the latest support handoff.,",
].join("\n")

const RESULTS_RUN_1 = JSON.stringify({
  perCaseArtifacts: [
    {
      caseId: "case-001",
      status: "COMPLETED",
      response: "Open Settings, choose Finance dashboard, then reset the dashboard.",
      deterministicMetrics: {
        "correctness.em": 0,
        "perf.e2e_ms": 3465,
        "cost.total_tokens": 620000,
      },
      judgeRubrics: [
        { rubricId: "helpfulness", score: 0.7, errored: false },
        { rubricId: "correctness", score: 0.4, errored: false },
      ],
      telemetry: { e2eMs: 3465 },
    },
  ],
})

const RESULTS_RUN_2 = JSON.stringify({
  perCaseArtifacts: [
    {
      caseId: "case-run-2",
      status: "COMPLETED",
      response: "Selected run actual answer.",
      deterministicMetrics: {
        "perf.e2e_ms": 2222,
        "cost.total_tokens": 10000,
      },
      judgeRubrics: [
        { rubricId: "helpfulness", score: 0.9, errored: false },
      ],
      telemetry: { e2eMs: 2222 },
    },
  ],
})

const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "local-dev-project", name: "Local Dev Project", role: null },
  },
}

function mockRunArtifacts(runId: string, casesText: string | null, resultsText: string | null) {
  vi.mocked(getObjectText).mockImplementation(async (_bucket, key) => {
    if (key.includes(`/runs/${runId}/_input/cases.jsonl`)) {
      return casesText
    }
    if (key.includes(`/runs/${runId}/results.json`)) {
      return resultsText
    }
    return null
  })
}

describe("EvalTestCasesPanel", () => {
  let roCleanup: () => void

  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    vi.mocked(getObjectText).mockReset()
  })

  afterEach(() => {
    roCleanup?.()
    restoreAllMocks()
  })

  it("[tag:eval] renders joined test cases and results in a table", async () => {
    const user = userEvent.setup()
    mockFetchByUrl([
      { match: "/evaluation/agents/runs", data: RUNS },
      { match: "/projects/local-dev-project", data: PROJECT },
    ])
    mockRunArtifacts("run-1", CASES_CSV, RESULTS_RUN_1)

    renderWithProviders(
      <EvalTestCasesPanel templateId="evt-1" evalName="Test Eval" />,
      { preloadedState: PROJECT_STATE },
    )

    expect(await screen.findByText("Completed evaluation run")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /Evaluation run/i })).toHaveValue("run-1")
    expect(screen.getByText("Deterministic with AI judge")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(await screen.findByText("case-001")).toBeInTheDocument()
    expect(screen.getByText("How do I reset my finance dashboard?")).toBeInTheDocument()
    expect(screen.getByText("Open settings, choose Dashboard, then select Reset.")).toBeInTheDocument()
    expect(screen.getByText("Open Settings, choose Finance dashboard, then reset the dashboard.")).toBeInTheDocument()
    expect(screen.getByText("case-002")).toBeInTheDocument()
    expect(screen.getByText("Summarize the latest support handoff.")).toBeInTheDocument()
    expect(screen.getAllByText("70%").length).toBeGreaterThan(0)
    expect(screen.getByText("40%")).toBeInTheDocument()
    expect(screen.getByText("55%")).toBeInTheDocument()
    expect(screen.getByText("3,465 ms")).toBeInTheDocument()
    expect(screen.getByText("620,000")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(2)

    await user.click(screen.getAllByRole("button", { name: "View" })[0])
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("Source result record")).toBeInTheDocument()
  })

  it("[tag:eval] updates table rows when a different run is selected", async () => {
    const user = userEvent.setup()
    mockFetchByUrl([
      { match: "/evaluation/agents/runs", data: RUNS },
      { match: "/projects/local-dev-project", data: PROJECT },
    ])
    const run2Cases = [
      "id,query,expected_answer",
      "case-run-2,Only visible for the selected run.,Selected run expected answer.",
    ].join("\n")
    vi.mocked(getObjectText).mockImplementation(async (_bucket, key) => {
      if (key.includes("/runs/run-1/_input/cases.jsonl")) return CASES_CSV
      if (key.includes("/runs/run-1/results.json")) return RESULTS_RUN_1
      if (key.includes("/runs/run-2/_input/cases.jsonl")) return run2Cases
      if (key.includes("/runs/run-2/results.json")) return RESULTS_RUN_2
      return null
    })

    renderWithProviders(
      <EvalTestCasesPanel templateId="evt-1" evalName="Test Eval" />,
      { preloadedState: PROJECT_STATE },
    )

    expect(await screen.findByText("case-001")).toBeInTheDocument()
    expect(screen.queryByText("case-run-2")).not.toBeInTheDocument()

    await user.selectOptions(screen.getByRole("combobox", { name: /Evaluation run/i }), "run-2")

    expect(await screen.findByText("case-run-2")).toBeInTheDocument()
    expect(screen.getByText("Only visible for the selected run.")).toBeInTheDocument()
    expect(screen.getByText("Selected run expected answer.")).toBeInTheDocument()
    expect(screen.getByText("Selected run actual answer.")).toBeInTheDocument()
    expect(screen.getByText("Deterministic")).toBeInTheDocument()
    expect(screen.getByText("2,222 ms")).toBeInTheDocument()
    expect(screen.getByText("10,000")).toBeInTheDocument()
    expect(screen.queryByText("case-001")).not.toBeInTheDocument()
  })

  it("[tag:eval] renders an empty state when both artifacts are missing", async () => {
    mockFetchByUrl([
      { match: "/evaluation/agents/runs", data: RUNS },
      { match: "/projects/local-dev-project", data: PROJECT },
    ])
    mockRunArtifacts("run-1", null, null)

    renderWithProviders(
      <EvalTestCasesPanel templateId="evt-1" evalName="Test Eval" />,
      { preloadedState: PROJECT_STATE },
    )

    expect(await screen.findByText("No test cases or results for this run.")).toBeInTheDocument()
  })

  it("[tag:eval] renders an error state when runs fail to load", async () => {
    mockFetchByUrl([
      { match: "/evaluation/agents/runs", data: { error: "boom" }, status: 500 },
      { match: "/projects/local-dev-project", data: PROJECT },
    ])

    renderWithProviders(
      <EvalTestCasesPanel templateId="evt-1" evalName="Test Eval" />,
      { preloadedState: PROJECT_STATE },
    )

    expect(await screen.findByText("Failed to load evaluation runs.")).toBeInTheDocument()
  })

  it("[tag:eval] loads run artifacts using the snapshot eval name slug", async () => {
    mockFetchByUrl([
      {
        match: "/evaluation/agents/runs",
        data: [{
          ...RUNS[0],
          templateSnapshot: {
            ...RUNS[0].templateSnapshot,
            evalName: "Original Eval",
          },
        }],
      },
      { match: "/projects/local-dev-project", data: PROJECT },
    ])
    mockRunArtifacts("run-1", CASES_CSV, RESULTS_RUN_1)

    renderWithProviders(
      <EvalTestCasesPanel templateId="evt-1" evalName="Renamed Eval" />,
      { preloadedState: PROJECT_STATE },
    )

    expect(await screen.findByText("case-001")).toBeInTheDocument()
    expect(vi.mocked(getObjectText).mock.calls.some(
      ([, key]) => typeof key === "string" && key.includes("/evaluations/original-eval/runs/run-1/"),
    )).toBe(true)
  })
})

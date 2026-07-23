import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { EvaluationTemplate } from "@/routes/pages/evaluations/api/eval.types"
import { EvalOverviewPanel } from "./eval-overview-panel"

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListProjectModelsQuery: () => ({
    data: [{ id: "gpt-4o", name: "gpt-4o", displayName: "GPT-4o" }],
  }),
}))

const FULL: EvaluationTemplate = {
  templateId: "evt-1",
  projectId: "proj-1",
  evalName: "Finance eval",
  description: "A description",
  labels: ["finance", "prod"],
  target: "agent_version",
  agent: { agentId: "agt-1", agentVersion: "latest" },
  models: ["gpt-4o"],
  evaluationScope: "full_agent_execution",
  suite: "rag",
  owner: "Sarah",
  lastModifiedBy: "Jordan",
  updatedAt: "2026-02-10",
  createdAt: "2026-01-01",
  evaluators: {
    strategy: "both",
    aiJudge: { models: ["gpt-4o"], dimensions: ["helpfulness"] },
    deterministic: { metrics: ["rag_quality", "correctness"] },
  },
  runMode: "single",
}

describe("EvalOverviewPanel", () => {
  it("[tag:eval] renders the details tab and switches to configuration + agent tabs", async () => {
    const user = userEvent.setup()
    renderWithProviders(<EvalOverviewPanel template={FULL} agentName="Finance agent" />)

    expect(screen.getByText("A description")).toBeInTheDocument()
    expect(screen.getByText("finance, prod")).toBeInTheDocument()
    expect(screen.getByText("Sarah")).toBeInTheDocument()
    expect(screen.getByText("Jordan")).toBeInTheDocument()

    await user.click(screen.getByText("Configuration"))
    expect(screen.getByText("Deterministic with AI judge")).toBeInTheDocument()
    expect(screen.getByText("rag_quality, correctness")).toBeInTheDocument()
    expect(screen.getByText("Helpfulness")).toBeInTheDocument()

    await user.click(screen.getByText("Associated agent"))
    expect(screen.getByText("Finance agent")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Deployed")).toBeInTheDocument()
  })

  it("[tag:eval] uses placeholders and deterministic-only config for a minimal template", async () => {
    const user = userEvent.setup()
    const minimal = {
      ...FULL,
      description: undefined,
      labels: [],
      owner: undefined,
      lastModifiedBy: undefined,
      updatedAt: undefined,
      createdAt: undefined,
      models: [],
      evaluators: { strategy: "deterministic", deterministic: { metrics: [] } },
    } as unknown as EvaluationTemplate
    renderWithProviders(<EvalOverviewPanel template={minimal} agentName="Bare agent" />)

    await user.click(screen.getByText("Configuration"))
    expect(screen.getByText("Deterministic only")).toBeInTheDocument()
    // model + dimensions + metrics all collapse to em dash for deterministic-only
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:eval] falls back to the raw strategy when it is unknown", async () => {
    const user = userEvent.setup()
    const weird = { ...FULL, evaluators: { strategy: "custom-strategy" } } as unknown as EvaluationTemplate
    renderWithProviders(<EvalOverviewPanel template={weird} agentName="A" />)

    await user.click(screen.getByText("Configuration"))
    expect(screen.getByText("custom-strategy")).toBeInTheDocument()
  })

  it("[tag:eval] handles missing models and unknown dimension ids for an llm_judge template", async () => {
    const user = userEvent.setup()
    const judgeOnly = {
      ...FULL,
      models: undefined,
      evaluators: { strategy: "llm_judge", aiJudge: { models: [], dimensions: ["nonexistent_dim"] } },
    } as unknown as EvaluationTemplate
    renderWithProviders(<EvalOverviewPanel template={judgeOnly} agentName="A" />)

    await user.click(screen.getByText("Configuration"))
    // Unknown dimension id is echoed verbatim; empty models collapse to em dash.
    expect(screen.getByText("nonexistent_dim")).toBeInTheDocument()
  })

  it("[tag:eval] shows an em dash when the strategy is absent entirely", async () => {
    const user = userEvent.setup()
    const noStrategy = { ...FULL, evaluators: {} } as unknown as EvaluationTemplate
    renderWithProviders(<EvalOverviewPanel template={noStrategy} agentName="A" />)

    await user.click(screen.getByText("Configuration"))
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })
})

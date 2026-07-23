import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"
import { AssociatedResourcesPanel } from "./associated-resources-panel"
import type { ModelDependentResource } from "../../model-detail-page.types"

const MOCK_DEPENDENTS: ModelDependentResource[] = [
  {
    id: "agent-01",
    kind: "agent",
    name: "agent-name-01",
    relation: "uses_model",
  },
  {
    id: "team-01",
    kind: "agent_team",
    name: "team-name-01",
    relation: "uses_team_model",
  },
  {
    id: "kb-01",
    kind: "knowledge_base",
    name: "kb-name-01",
    relation: "uses_model",
  },
  {
    id: "eval-01",
    kind: "evaluation",
    name: "eval-name-01",
    relation: "uses_judge_model",
  },
]

describe("AssociatedResourcesPanel", () => {
  it("[tag:associated-resources-panel] renders heading with dependent count", () => {
    renderWithProviders(<AssociatedResourcesPanel dependents={MOCK_DEPENDENTS} />)
    expect(screen.getByText("Associated resources (4)")).toBeInTheDocument()
  })

  it("[tag:associated-resources-panel] renders heading with zero count when no dependents", () => {
    renderWithProviders(<AssociatedResourcesPanel dependents={[]} />)
    expect(screen.getByText("Associated resources (0)")).toBeInTheDocument()
  })

  it("[tag:associated-resources-panel] renders dependent names in table", () => {
    renderWithProviders(<AssociatedResourcesPanel dependents={MOCK_DEPENDENTS} />)
    expect(screen.getByText("agent-name-01")).toBeInTheDocument()
    expect(screen.getByText("eval-name-01")).toBeInTheDocument()
  })

  it("[tag:associated-resources-panel] renders column headers", () => {
    renderWithProviders(<AssociatedResourcesPanel dependents={MOCK_DEPENDENTS} />)
    expect(screen.getByText("Type")).toBeInTheDocument()
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Relation")).toBeInTheDocument()
  })

  it("[tag:associated-resources-panel] renders formatted kind and relation labels", () => {
    renderWithProviders(<AssociatedResourcesPanel dependents={MOCK_DEPENDENTS} />)
    expect(screen.getByText("Agent")).toBeInTheDocument()
    expect(screen.getByText("Agent team")).toBeInTheDocument()
    expect(screen.getByText("Evaluation")).toBeInTheDocument()
    // Two dependents share the `uses_model` relation (agent + knowledge base).
    expect(screen.getAllByText("Uses model")).toHaveLength(2)
    expect(screen.getByText("Judge model")).toBeInTheDocument()
  })

  it("[tag:associated-resources-panel] links each resource name to its detail page by kind", () => {
    renderWithProviders(<AssociatedResourcesPanel dependents={MOCK_DEPENDENTS} />)
    expect(screen.getByRole("link", { name: "agent-name-01" })).toHaveAttribute(
      "href",
      "/agents/agent-01",
    )
    // Agent teams reuse the /agents/:id detail route.
    expect(screen.getByRole("link", { name: "team-name-01" })).toHaveAttribute(
      "href",
      "/agents/team-01",
    )
    expect(screen.getByRole("link", { name: "kb-name-01" })).toHaveAttribute(
      "href",
      "/knowledge-bases/kb-01",
    )
    expect(screen.getByRole("link", { name: "eval-name-01" })).toHaveAttribute(
      "href",
      "/evaluations/eval-01",
    )
  })
})

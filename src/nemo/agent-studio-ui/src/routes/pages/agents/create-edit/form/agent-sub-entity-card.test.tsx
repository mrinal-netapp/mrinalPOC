import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AgentSubEntityCard } from "./agent-sub-entity-card"
import type { AgentSubEntity } from "./agent-form.consts"

const baseEntity: AgentSubEntity = {
  id: "ent-1",
  name: "$entity-name",
  status: "healthy",
  deployment: "Deployed",
  labels: ["Staging", "Sales"],
}

describe("AgentSubEntityCard", () => {
  it("[tag:agent-sub-entity-card] renders the entity name with the external-link icon", () => {
    render(<AgentSubEntityCard entity={baseEntity} />)
    expect(screen.getByText("$entity-name")).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: 'Open agent "$entity-name" in a new tab' }),
    ).toHaveAttribute("href", "/agents/ent-1")
  })

  it("[tag:agent-sub-entity-card] renders all four label/value rows", () => {
    render(<AgentSubEntityCard entity={baseEntity} />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
    expect(screen.getByText("Deployment")).toBeInTheDocument()
    expect(screen.getByText("Labels")).toBeInTheDocument()
    expect(screen.getByText("Deployed")).toBeInTheDocument()
    expect(screen.getByText("Staging, Sales")).toBeInTheDocument()
  })

  it("[tag:agent-sub-entity-card] maps a 'healthy' status to the 'Healthy' display label and the dot modifier", () => {
    const { container } = render(<AgentSubEntityCard entity={baseEntity} />)
    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(
      container.querySelector(".agent-form__status-dot--healthy"),
    ).not.toBeNull()
  })

  it("[tag:agent-sub-entity-card] non-healthy status renders the raw status string and corresponding dot modifier", () => {
    const { container } = render(
      <AgentSubEntityCard entity={{ ...baseEntity, status: "degraded" }} />,
    )
    expect(screen.getByText("degraded")).toBeInTheDocument()
    expect(
      container.querySelector(".agent-form__status-dot--degraded"),
    ).not.toBeNull()
  })
})

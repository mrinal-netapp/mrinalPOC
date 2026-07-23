import { type ReactElement } from "react"
import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"
import { mockResizeObserver } from "@/utils/unit-tests"

import { TeamAgentsSection } from "./team-agents-section"
import type { AgentSubEntity } from "./agent-form.consts"
import type { TeamMemberOptions } from "./use-team-member-options"

const CATALOG: AgentSubEntity[] = [
  { id: "ag-1", name: "Primary agent", status: "healthy", deployment: "Deployed", labels: ["Staging"] },
  { id: "ag-2", name: "Secondary agent", status: "healthy", deployment: "Deployed", labels: ["Sales"] },
]

const optionsResult: TeamMemberOptions = {
  entities: CATALOG,
  items: CATALOG.map((a) => ({ key: a.id, value: a.id, label: a.name })),
  isLoading: false,
  isError: false,
}

vi.mock("./use-team-member-options", () => ({
  useTeamAgentOptions: (): TeamMemberOptions => optionsResult,
}))

function Harness({ initialIds = [] as string[] }: { initialIds?: string[] }): ReactElement {
  const form = useTestForm({
    team: {
      orchestrationPattern: "",
      managerModel: "",
      managerSystemPrompt: "",
      agentIds: initialIds,
      teamIds: [],
    },
  })
  return <TeamAgentsSection form={form} />
}

describe("TeamAgentsSection", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>
  beforeEach(() => {
    roHandle = mockResizeObserver()
  })
  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:team-agents-section] renders the section heading", () => {
    render(<Harness />)
    expect(screen.getByText("Agents")).toBeInTheDocument()
  })

  it("[tag:team-agents-section] does not render any sub-entity cards when no agents are selected", () => {
    const { container } = render(<Harness />)
    expect(
      container.querySelector(".agent-form__sub-entity-list"),
    ).toBeNull()
  })

  it("[tag:team-agents-section] renders one card per selected agent id with the matching name", () => {
    const ids = CATALOG.map((a) => a.id)
    const { container } = render(<Harness initialIds={ids} />)

    const list = container.querySelector(".agent-form__sub-entity-list")
    expect(list).not.toBeNull()
    // Each card carries the entity name; assert against the list scope so
    // chip-display copies of the same string in the dropdown don't conflict.
    CATALOG.forEach((a) => {
      expect(list?.textContent).toContain(a.name)
    })
  })

  it("[tag:team-agents-section] silently skips ids that don't match the catalog (defensive)", () => {
    const { container } = render(<Harness initialIds={["does-not-exist"]} />)
    expect(
      container.querySelector(".agent-form__sub-entity-list"),
    ).toBeNull()
  })
})

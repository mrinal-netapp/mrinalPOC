import { type ReactElement } from "react"
import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"
import { mockResizeObserver } from "@/utils/unit-tests"

import { TeamTeamsSection } from "./team-teams-section"
import type { AgentSubEntity } from "./agent-form.consts"
import type { TeamMemberOptions } from "./use-team-member-options"

const CATALOG: AgentSubEntity[] = [
  { id: "agr-1", name: "Support team", status: "healthy", deployment: "Deployed", labels: ["Staging"] },
  { id: "agr-2", name: "Ops team", status: "healthy", deployment: "Deployed", labels: [] },
]

const optionsResult: TeamMemberOptions = {
  entities: CATALOG,
  items: CATALOG.map((t) => ({ key: t.id, value: t.id, label: t.name })),
  isLoading: false,
  isError: false,
}

vi.mock("./use-team-member-options", () => ({
  useTeamTeamOptions: (): TeamMemberOptions => optionsResult,
}))

function Harness({
  initialIds = [] as string[],
  currentTeamId,
}: {
  initialIds?: string[]
  currentTeamId?: string
}): ReactElement {
  const form = useTestForm({
    team: {
      orchestrationPattern: "",
      managerModel: "",
      managerSystemPrompt: "",
      agentIds: [],
      teamIds: initialIds,
    },
  })
  return <TeamTeamsSection form={form} currentTeamId={currentTeamId} />
}

describe("TeamTeamsSection", () => {
  // ChipList (rendered for selected teams) relies on ResizeObserver, which jsdom
  // does not implement. Stub it per the shared test convention.
  let roHandle: ReturnType<typeof mockResizeObserver>
  beforeEach(() => {
    roHandle = mockResizeObserver()
  })
  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:team-teams-section] renders the section heading", () => {
    render(<Harness />)
    expect(screen.getByText("Teams")).toBeInTheDocument()
  })

  it("[tag:team-teams-section] does not render any team cards when no teams are selected", () => {
    const { container } = render(<Harness />)
    expect(
      container.querySelector(".agent-form__sub-entity-list"),
    ).toBeNull()
  })

  it("[tag:team-teams-section] renders a card per selected team id with the matching name", () => {
    const ids = CATALOG.map((t) => t.id)
    const { container } = render(<Harness initialIds={ids} />)
    const list = container.querySelector(".agent-form__sub-entity-list")
    expect(list).not.toBeNull()
    CATALOG.forEach((t) => {
      expect(list?.textContent).toContain(t.name)
    })
  })

  it("[tag:team-teams-section] silently skips ids that don't match the catalog (defensive)", () => {
    const { container } = render(<Harness initialIds={["nope"]} />)
    expect(
      container.querySelector(".agent-form__sub-entity-list"),
    ).toBeNull()
  })

  it("[tag:team-teams-section] never renders a card for the current team (no self-membership)", () => {
    const ids = CATALOG.map((t) => t.id)
    const { container } = render(<Harness initialIds={ids} currentTeamId="agr-1" />)
    const list = container.querySelector(".agent-form__sub-entity-list")
    expect(list?.textContent).not.toContain("Support team")
    expect(list?.textContent).toContain("Ops team")
  })
})

import { type ReactElement } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"

import { TeamConfigSection } from "./team-config-section"

type MockProjectModelsQueryResult = {
  data: { id: string; name: string; type: string }[] | undefined
  isLoading: boolean
  isError: boolean
}

const mockUseListProjectModelsQuery = vi.fn<() => MockProjectModelsQueryResult>(() => ({
  data: [
    { id: "mdl-1", name: "Model Alpha", type: "llm" },
    { id: "mdl-2", name: "Model Beta", type: "llm" },
  ],
  isLoading: false,
  isError: false,
}));

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListProjectModelsQuery: () => mockUseListProjectModelsQuery(),
}))

vi.mock("@/store", () => ({
  useAppSelector: () => "proj-test-001",
}))

function Harness({
  orchestrationPattern = "",
  managerName = "",
  managerModel = "",
  managerInstructions = "",
}: {
  orchestrationPattern?: string
  managerName?: string
  managerModel?: string
  managerInstructions?: string
} = {}): ReactElement {
  const form = useTestForm({
    team: {
      orchestrationPattern,
      managerName,
      managerModel,
      managerInstructions,
      agentIds: [],
      teamIds: [],
    },
  })
  return <TeamConfigSection form={form} />
}

describe("TeamConfigSection", () => {
  it("[tag:team-config-section] renders the section heading", () => {
    render(<Harness />)
    expect(screen.getByText("Configuration")).toBeInTheDocument()
  })

  it("[tag:team-config-section] renders the orchestration pattern label", () => {
    render(<Harness />)
    expect(screen.getByText("Orchestration pattern")).toBeInTheDocument()
  })

  it("[tag:team-config-section] renders the inline 'Add at least one to continue' notice", () => {
    render(<Harness />)
    expect(
      screen.getByText(
        "Add at least one to continue: a single agent or a team agent.",
      ),
    ).toBeInTheDocument()
  })

  it("[tag:team-config-section] does NOT render manager fields when orchestration is not 'coordinate' or 'route'", () => {
    render(<Harness orchestrationPattern="sequential" />)
    expect(screen.queryByText("Manager agent")).not.toBeInTheDocument()
    expect(screen.queryByText("Instructions")).not.toBeInTheDocument()
  })

  it("[tag:team-config-section] does NOT render manager fields when no orchestration is selected", () => {
    render(<Harness />)
    expect(screen.queryByText("Manager agent")).not.toBeInTheDocument()
  })

  it("[tag:team-config-section] renders manager fields when orchestration is 'coordinate'", () => {
    render(<Harness orchestrationPattern="coordinate" />)
    expect(screen.getByText("Manager agent")).toBeInTheDocument()
    expect(screen.getByText("Manager name")).toBeInTheDocument()
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Instructions")).toBeInTheDocument()
    // Goal field was removed — Instructions is the single freeform input now.
    expect(screen.queryByText("Goal")).not.toBeInTheDocument()
  })

  it("[tag:team-config-section] renders manager fields when orchestration is 'route' (triage router)", () => {
    render(<Harness orchestrationPattern="route" />)
    expect(screen.getByText("Manager agent")).toBeInTheDocument()
    expect(screen.getByText("Manager name")).toBeInTheDocument()
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Instructions")).toBeInTheDocument()
    expect(screen.queryByText("Goal")).not.toBeInTheDocument()
    // Copy should distinguish triage routing from magentic coordination so the
    // operator understands what the prompt drives.
    expect(
      screen.getByText(/router agent that decides which team member/i),
    ).toBeInTheDocument()
  })

  it("[tag:team-config-section] does NOT render manager fields when orchestration is 'sequential'", () => {
    render(<Harness orchestrationPattern="sequential" />)
    expect(screen.queryByText("Manager agent")).not.toBeInTheDocument()
  })

  it("[tag:team-config-section] does NOT render manager fields when orchestration is 'concurrent'", () => {
    render(<Harness orchestrationPattern="concurrent" />)
    expect(screen.queryByText("Manager agent")).not.toBeInTheDocument()
  })

  it("[tag:team-config-section] instructions textarea onChange updates field value (coordinate)", () => {
    render(<Harness orchestrationPattern="coordinate" />)
    const instructionsTextarea = screen.getByPlaceholderText(
      "Describe the manager agent's tone, constraints, and coordination strategy.",
    )
    fireEvent.change(instructionsTextarea, { target: { value: "Be concise." } })
    expect(instructionsTextarea).toHaveValue("Be concise.")
  })

  it("[tag:team-config-section] instructions placeholder differs for the route (triage) pattern", () => {
    render(<Harness orchestrationPattern="route" />)
    const instructionsTextarea = screen.getByPlaceholderText(
      "Describe routing rules: which specialist to pick for which kind of user message.",
    )
    fireEvent.change(instructionsTextarea, {
      target: { value: "Use Hello for greetings; Restaurants_Search for food." },
    })
    expect(instructionsTextarea).toHaveValue(
      "Use Hello for greetings; Restaurants_Search for food.",
    )
  })

  it("[tag:team-config-section] shows character count when instructions is non-empty", () => {
    render(<Harness orchestrationPattern="coordinate" managerInstructions="Be brief." />)
    expect(screen.getByText("9 characters")).toBeInTheDocument()
  })

  it("[tag:team-config-section] shows loading placeholder while models are fetching", () => {
    mockUseListProjectModelsQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      isError: false,
    })
    render(<Harness orchestrationPattern="coordinate" />)
    expect(screen.getByText("Loading models…")).toBeInTheDocument()
  })

  it("[tag:team-config-section] shows error placeholder when model fetch fails", () => {
    mockUseListProjectModelsQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    render(<Harness orchestrationPattern="coordinate" />)
    expect(screen.getByText("Failed to load models")).toBeInTheDocument()
  })

  it("[tag:team-config-section] shows no-models placeholder when model list is empty", () => {
    mockUseListProjectModelsQuery.mockReturnValueOnce({
      data: [],
      isLoading: false,
      isError: false,
    })
    render(<Harness orchestrationPattern="coordinate" />)
    expect(screen.getByText("No models available")).toBeInTheDocument()
  })
})

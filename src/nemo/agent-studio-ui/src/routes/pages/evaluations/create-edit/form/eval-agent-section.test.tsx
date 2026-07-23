import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { encodeEvalTargetKey } from "@/routes/pages/evaluations/api/eval-mappers"

const mockUseListAgents = vi.fn()
const mockUseListAgentTeams = vi.fn()
const mockUseListModels = vi.fn()
const mockUseListKbs = vi.fn()

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListAgentsQuery: () => mockUseListAgents(),
  useListAgentTeamsQuery: () => mockUseListAgentTeams(),
  useListProjectModelsQuery: () => mockUseListModels(),
}))

vi.mock("@/api/kb-api.slice", () => ({
  useListKnowledgeBasesQuery: () => mockUseListKbs(),
}))

import { EvalAgentSection } from "./eval-agent-section"

const FULL_AGENT = {
  id: "agt-1",
  name: "Finance agent",
  status: "Healthy",
  deploymentStatus: "deployed",
  labels: ["prod", "finance"],
  model: { displayName: "GPT-4o" },
  associatedResources: { knowledgeBases: [{ name: "Policies KB" }] },
  mcpServerIds: ["mcp-1", "mcp-2"],
}

const BARE_AGENT = {
  id: "agt-2",
  name: "Bare agent",
  knowledgeBaseIds: ["kb-1"],
}

const TEAM = {
  id: "team-1",
  name: "Support team",
  status: "Healthy",
  deploymentStatus: "deployed",
  labels: ["support"],
  members: [{ memberType: "agent", memberId: "agt-1" }],
  sharedKnowledgeBaseIds: ["kb-1"],
  orchestrationPolicy: "sequential",
}

function setup(props: Partial<Parameters<typeof EvalAgentSection>[0]> = {}) {
  const onAgentVersionChange = vi.fn()
  const utils = renderWithProviders(
    <EvalAgentSection
      agentVersionKey={encodeEvalTargetKey("agent", "agt-1")}
      submitted={false}
      onAgentVersionChange={onAgentVersionChange}
      {...props}
    />,
  )
  return { onAgentVersionChange, ...utils }
}

describe("EvalAgentSection", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    mockUseListAgents.mockReturnValue({ data: [FULL_AGENT, BARE_AGENT], isLoading: false, isError: false })
    mockUseListAgentTeams.mockReturnValue({ data: [TEAM], isLoading: false, isError: false })
    mockUseListModels.mockReturnValue({ data: [] })
    mockUseListKbs.mockReturnValue({ data: { data: [{ kb_id: "kb-1", name: "Fallback KB" }] } })
  })
  afterEach(() => { roCleanup?.(); vi.clearAllMocks() })

  it("[tag:eval] renders the full property panel for the selected agent", () => {
    setup({ agentVersionKey: encodeEvalTargetKey("agent", "agt-1") })

    expect(screen.getAllByText("Finance agent").length).toBeGreaterThan(0)
    expect(screen.getByText("Deployed")).toBeInTheDocument()
    expect(screen.getByText("prod, finance")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("Policies KB")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("[tag:eval] falls back to placeholders and KB-id resolution for a bare agent", () => {
    setup({ agentVersionKey: encodeEvalTargetKey("agent", "agt-2") })

    expect(screen.getAllByText("Bare agent").length).toBeGreaterThan(0)
    expect(screen.getByText("Fallback KB")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:eval] renders team properties when a team is selected", () => {
    setup({ agentVersionKey: encodeEvalTargetKey("team", "team-1") })

    expect(screen.getAllByText("Support team").length).toBeGreaterThan(0)
    expect(screen.getByText("Members")).toBeInTheDocument()
    expect(screen.getByText("Shared knowledge bases")).toBeInTheDocument()
    expect(screen.getAllByText("1")).toHaveLength(2)
    expect(screen.getByText("sequential")).toBeInTheDocument()
  })

  it("[tag:eval] renders no property panel when no agent is selected", () => {
    setup({ agentVersionKey: "" })
    expect(screen.queryByText("Finance agent")).not.toBeInTheDocument()
  })

  it("[tag:eval] shows the required error when submitted with no agent", () => {
    setup({ agentVersionKey: "", submitted: true })
    expect(screen.getByText("Agent or team is required.")).toBeInTheDocument()
  })

  it("[tag:eval] shows a load error when either query fails", () => {
    mockUseListAgents.mockReturnValue({ data: [], isLoading: false, isError: true })
    setup({ agentVersionKey: "" })
    expect(screen.getByText("Failed to load agents and teams.")).toBeInTheDocument()
  })

  it("[tag:eval] defaults to an empty KB list when the KB query returns no data", () => {
    mockUseListKbs.mockReturnValue({})
    setup({ agentVersionKey: encodeEvalTargetKey("agent", "agt-2") })
    expect(screen.getAllByText("Bare agent").length).toBeGreaterThan(0)
  })
})

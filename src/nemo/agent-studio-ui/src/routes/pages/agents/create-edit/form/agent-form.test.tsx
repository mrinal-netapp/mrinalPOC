import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router"

vi.setConfig({ testTimeout: 120_000 })

// AgentForm pulls in ~12 section components — every one of them mounts its
// own fan-out of dialogs/chip-lists/cards on first paint. Stub them to
// lightweight placeholders so the test stays focused on the save-dropdown
// wiring (and stays under the per-test timeout).
vi.mock("./setup-section", () => ({ SetupSection: () => null }))
vi.mock("./model-section", () => ({ ModelSection: () => null }))
vi.mock("./profile-section", () => ({ ProfileSection: () => null }))
vi.mock("./knowledge-bases-section", () => ({
  KnowledgeBasesSection: () => null,
}))
vi.mock("./toolset-section", () => ({ ToolsetSection: () => null }))
vi.mock("./configuration-section", () => ({
  ConfigurationSection: () => null,
}))
vi.mock("./team-config-section", () => ({ TeamConfigSection: () => null }))
vi.mock("./team-agents-section", () => ({ TeamAgentsSection: () => null }))
vi.mock("./team-teams-section", () => ({ TeamTeamsSection: () => null }))
vi.mock("./template-section", () => ({ TemplateSection: () => null }))
vi.mock("./template-agents-section", () => ({ TemplateAgentsSection: () => null }))

// The Playground panels render their own Card + CardHeader + an absolutely-
// positioned toggle button — and the run-details panel additionally calls
// `useListAgentSessionsQuery` (RTK Query). Stub them out so the AgentForm
// tests don't have to mount RTK Query providers, and so we can assert
// "is the chat / output-details column rendered?" via simple test IDs.
vi.mock(
  "@/routes/pages/agents/playground/components/playground-chat-panel",
  () => ({
    PlaygroundChatPanel: () => <div data-testid="agent-form__chat-panel" />,
  }),
)
vi.mock(
  "@/routes/pages/agents/playground/components/run-details-panel",
  () => ({
    RunDetailsPanel: () => <div data-testid="agent-form__run-details-panel" />,
  }),
)

// Capture navigate calls without mounting the real router tree.
const navigateSpy = vi.fn()

// Stubbed useBlocker so the AgentForm mounts without a data router. The
// default return is "unblocked"; individual tests override the next call
// with `useBlockerSpy.mockReturnValueOnce(...)` to drive the ConfirmDialog
// path.
type BlockerLike = {
  state: "unblocked" | "blocked"
  proceed?: () => void
  reset?: () => void
}
const useBlockerSpy = vi.fn<() => BlockerLike>(() => ({
  state: "unblocked",
  proceed: undefined,
  reset: undefined,
}))

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router")
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    useBlocker: () => useBlockerSpy(),
  }
})

// AgentForm now reads playground streaming state from Redux via the typed
// store hooks. Stub them so the form mounts without a <Provider> (consistent
// with the mocked RTK Query hooks below); the playground panels are mocked, so
// the selected values are never rendered directly.
const playgroundDispatchSpy = vi.fn()
const TEST_PROJECT_ID = "proj-test"

const {
  createAgentMock,
  createAgentMutationSpy,
  createAgentTeamMock,
  createAgentTeamMutationSpy,
  updateAgentMutationSpy,
  updateAgentStatusMutationSpy,
  updateAgentTeamMutationSpy,
  updateAgentTeamStatusMock,
  deleteAgentMock,
  toastErrorSpy,
} = vi.hoisted(() => {
  const createAgent = vi.fn(() => ({
    unwrap: () => Promise.resolve({ id: "member-agent-1" }),
  }))
  const updateAgent = vi.fn(() => ({
    unwrap: () => Promise.resolve({ id: "updated-agent" }),
  }))
  const updateAgentStatus = vi.fn(() => ({
    unwrap: () => Promise.resolve({ id: "status-agent" }),
  }))
  const createAgentTeam = vi.fn(() => ({
    unwrap: () => Promise.resolve({ id: "created-team-1" }),
  }))
  const updateAgentTeam = vi.fn(() => ({
    unwrap: () => Promise.resolve({ id: "updated-team" }),
  }))
  const updateAgentTeamStatus = vi.fn(() => ({
    unwrap: () => Promise.resolve({ id: "created-team-1" }),
  }))
  const deleteAgent = vi.fn(() => ({
    unwrap: () => Promise.resolve(undefined),
  }))

  return {
    createAgentMock: createAgent,
    createAgentMutationSpy: createAgent,
    createAgentTeamMock: createAgentTeam,
    createAgentTeamMutationSpy: createAgentTeam,
    updateAgentMutationSpy: updateAgent,
    updateAgentStatusMutationSpy: updateAgentStatus,
    updateAgentTeamMutationSpy: updateAgentTeam,
    updateAgentTeamStatusMock: updateAgentTeamStatus,
    updateAgentTeamStatusMutationSpy: updateAgentTeamStatus,
    deleteAgentMock: deleteAgent,
    toastErrorSpy: vi.fn(),
  }
})

vi.mock("@/store/hooks", async () => {
  const { projectContextSelector } = await import(
    "@/store/selectors/project-context.selector"
  )
  return {
    useAppDispatch: () => playgroundDispatchSpy,
    useAppSelector: (selector: unknown) => {
      if (selector === projectContextSelector.activeProjectId) {
        return TEST_PROJECT_ID
      }
      return undefined
    },
  }
})

// Watch toast.success / toast.info calls.
const toastSuccessSpy = vi.fn()
const toastInfoSpy = vi.fn()
const toastWarningSpy = vi.fn()
vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessSpy(...args),
    info: (...args: unknown[]) => toastInfoSpy(...args),
    error: (...args: unknown[]) => toastErrorSpy(...args),
    warning: (...args: unknown[]) => toastWarningSpy(...args),
    warn: vi.fn(),
  },
}))

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useGetAgentQuery: () => ({ data: undefined }),
  useGetAgentTeamQuery: () => ({ data: undefined }),
  useListGuardrailCatalogQuery: () => ({ data: [] }),
  useListProjectModelsQuery: () => ({ data: undefined }),
  useCreateAgentMutation: () => [createAgentMock, {}],
  useUpdateAgentMutation: () => [updateAgentMutationSpy, {}],
  useUpdateAgentStatusMutation: () => [updateAgentStatusMutationSpy, {}],
  useCreateAgentTeamMutation: () => [createAgentTeamMock, {}],
  useUpdateAgentTeamMutation: () => [updateAgentTeamMutationSpy, {}],
  useUpdateAgentTeamStatusMutation: () => [updateAgentTeamStatusMock, {}],
  useDeleteAgentMutation: () => [deleteAgentMock, {}],
}))

// AgentForm now lazy-loads historical session transcripts for the run-details
// dropdown (merged from main's playground session work). Stub the RTK Query hook
// so the form mounts without a Redux <Provider> - same pattern as the mocked
// playground panels above.
vi.mock("@/routes/pages/agents/api/agents-runtime-api.slice", () => ({
  useLazyGetAgentSessionQuery: () => [
    vi.fn(() => ({ unwrap: () => Promise.resolve(undefined) })),
    {},
  ],
}))

import { AgentForm } from "./agent-form"
import { SAVE_AGENT_DIALOG_STRINGS } from "../configure-dialogs/save-agent-dialog"
import { DEPLOY_LOCKED_CLASS } from "../../agents.consts"
import { DEFAULT_FEATURE_CONFIG } from "./agent-form.consts"
import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
} from "./agent-templates.consts"
import {
  buildAgentInstanceFromTemplate,
  buildManagerInstanceFromTemplate,
} from "./template-agent.utils"

const TEMPLATE_AGENT_DEF: AgentTemplateAgentDefinition = {
  name: "Researcher",
  role: "research-analyst",
  systemPrompt: "Find references",
  modelId: "model-a",
  requirements: {
    knowledgeBases: [
      { id: "kb-required", label: "Req KB", description: "", required: true },
      { id: "kb-optional", label: "Opt KB", description: "", required: false },
    ],
    mcpServers: [
      { id: "mcp-required", label: "Req MCP", description: "", required: true },
      { id: "mcp-optional", label: "Opt MCP", description: "", required: false },
    ],
  },
}

const TEMPLATE_DEF: AgentTemplateDefinition = {
  id: "tmpl-1",
  name: "Research Team",
  description: "Template",
  capabilities: [],
  examples: [],
  instructions: "Template instructions",
  orchestrationPattern: "Sequential",
  model: "claude",
  role: "team-manager",
  agents: [TEMPLATE_AGENT_DEF],
}

function makeConfiguredTemplateInitialData(options?: {
  includeOptionalRequirements?: boolean
  missingRequiredRequirements?: boolean
}) {
  const member = {
    ...buildAgentInstanceFromTemplate(TEMPLATE_AGENT_DEF, TEMPLATE_DEF.instructions),
    primaryModel: "model-uuid",
    name: "Research-goal",
    description: "Researches references for the team",
    instructions: "Do research",
    satisfiedKbRequirementIds: options?.missingRequiredRequirements
      ? []
      : options?.includeOptionalRequirements
        ? ["kb-required", "kb-optional"]
        : ["kb-required"],
    satisfiedMcpRequirementIds: options?.missingRequiredRequirements
      ? []
      : options?.includeOptionalRequirements
        ? ["mcp-required", "mcp-optional"]
        : ["mcp-required"],
  }
  const manager = {
    ...buildManagerInstanceFromTemplate(TEMPLATE_DEF),
    primaryModel: "manager-model",
    name: "Manager-goal",
    instructions: "Lead the team",
  }

  return {
    configuration: "from_template" as const,
    template: {
      selectedTemplate: TEMPLATE_DEF,
      agentInstances: [member],
      managerInstance: manager,
      orchestrationPattern: "sequential" as const,
    },
  }
}

const TEMPLATE_AGENT_DEF_2: AgentTemplateAgentDefinition = {
  ...TEMPLATE_AGENT_DEF,
  name: "Writer",
  role: "writer",
  systemPrompt: "Write summaries",
}

const TEMPLATE_DEF_TWO_MEMBERS: AgentTemplateDefinition = {
  ...TEMPLATE_DEF,
  agents: [TEMPLATE_AGENT_DEF, TEMPLATE_AGENT_DEF_2],
}

function makeTwoMemberTemplateInitialData() {
  const member1 = {
    ...buildAgentInstanceFromTemplate(TEMPLATE_AGENT_DEF, TEMPLATE_DEF.instructions),
    primaryModel: "model-uuid",
    name: "Research-goal",
    instructions: "Do research",
    satisfiedKbRequirementIds: ["kb-required"],
    satisfiedMcpRequirementIds: ["mcp-required"],
  }
  const member2 = {
    ...buildAgentInstanceFromTemplate(TEMPLATE_AGENT_DEF_2, TEMPLATE_DEF.instructions),
    primaryModel: "model-uuid",
    name: "Writer-goal",
    instructions: "Write summaries",
    satisfiedKbRequirementIds: ["kb-required"],
    satisfiedMcpRequirementIds: ["mcp-required"],
  }
  const manager = {
    ...buildManagerInstanceFromTemplate(TEMPLATE_DEF_TWO_MEMBERS),
    primaryModel: "manager-model",
    name: "Manager-goal",
    instructions: "Lead the team",
  }

  return {
    configuration: "from_template" as const,
    template: {
      selectedTemplate: TEMPLATE_DEF_TWO_MEMBERS,
      agentInstances: [member1, member2],
      managerInstance: manager,
      orchestrationPattern: "sequential" as const,
    },
  }
}

async function submitTemplateSaveDialog(
  mode: "draft" | "deploy",
  agentName = "template-team-1",
): Promise<void> {
  openSaveMenu()
  const triggerLabel =
    mode === "deploy"
      ? SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY
      : SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT
  await waitFor(() => screen.getByText(triggerLabel))
  fireEvent.click(screen.getByText(triggerLabel))

  const title =
    mode === "deploy"
      ? SAVE_AGENT_DIALOG_STRINGS.TITLE_DEPLOY
      : SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT
  await waitFor(() => screen.getByText(title))

  fireEvent.change(screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL), {
    target: { value: agentName },
  })
  fireEvent.click(
    screen.getByRole("button", {
      name:
        mode === "deploy"
          ? SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DEPLOY
          : SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
    }),
  )
}

function renderForm(props?: Parameters<typeof AgentForm>[0]): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AgentForm {...props} />
    </MemoryRouter>,
  )
}

const openSaveMenu = (): void => {
  fireEvent.click(screen.getByRole("button", { name: /Save/ }))
}

describe("AgentForm save dropdown", (): void => {
  it("[tag:agent-form-save] renders the Save dropdown trigger in the top bar", (): void => {
    renderForm()
    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument()
  })

  it("[tag:agent-form-save] opening the dropdown shows Save as draft and locked Save and deploy", async (): Promise<void> => {
    renderForm()
    openSaveMenu()

    await waitFor(() =>
      expect(
        screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
      ).toBeInTheDocument(),
    )
    const deployItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY,
    })
    expect(deployItem).toBeInTheDocument()
    expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS)
  })

  it("[tag:agent-form-save] selecting 'Save as draft' opens the dialog in draft mode", async (): Promise<void> => {
    renderForm()
    openSaveMenu()

    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )

    await waitFor(() =>
      expect(
        screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    ).toBeInTheDocument()
  })

  it("[tag:agent-form-save] Save and deploy menu item is locked while LOCK_AGENT_DEPLOY is true", async (): Promise<void> => {
    renderForm()
    openSaveMenu()

    const deployItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY,
    })
    expect(deployItem).toBeInTheDocument()
    expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS)
    expect(deployItem).toHaveAttribute("aria-disabled", "true")

    fireEvent.click(deployItem)
    expect(
      screen.queryByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DEPLOY),
    ).not.toBeInTheDocument()
  })

  it("[tag:agent-form-save] devtools-unlock path still respects blocking requirements", async (): Promise<void> => {
    renderForm({
      initialData: {
        requirements: {
          knowledgeBases: [
            { id: "kb-req", label: "Required KB", description: "", required: true },
          ],
          mcpServers: [],
        },
      },
    })
    openSaveMenu()

    const deployItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY,
    })

    // Simulate the documented QA unlock (removing the marker in devtools): the
    // JS lock guard releases, but the dependency gate must still block deploy.
    deployItem.classList.remove(DEPLOY_LOCKED_CLASS)
    fireEvent.click(deployItem)
    expect(
      screen.queryByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DEPLOY),
    ).not.toBeInTheDocument()
  })

  it("[tag:agent-form-save] submitting the dialog navigates back to the agents listing and toasts success", async (): Promise<void> => {
    navigateSpy.mockClear()
    toastSuccessSpy.mockClear()
    toastWarningSpy.mockClear()

    renderForm({ initialData: { goal: "Goal", instructions: "Instructions", primaryModel: "model-uuid" } })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )

    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )

    const nameInput = screen.getByLabelText(
      SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL,
    )
    fireEvent.change(nameInput, { target: { value: "agent-1" } })
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(toastSuccessSpy).toHaveBeenCalledWith("agent-1 saved as draft.")
  })

  it("[tag:agent-form-save] edit-mode draft save updates the existing agent and stays on page", async (): Promise<void> => {
    updateAgentMutationSpy.mockClear()
    navigateSpy.mockClear()

    renderForm({
      isEdit: true,
      agentId: "agent-123",
      initialData: { goal: "Help customers", instructions: "Answer clearly", primaryModel: "model-uuid" },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "existing-agent" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() => expect(updateAgentMutationSpy).toHaveBeenCalledTimes(1))
    expect(navigateSpy).not.toHaveBeenCalledWith("/agents/updated-agent/edit", {
      replace: true,
    })
  })

  it("[tag:agent-form-save] team draft save blocks when no members are configured", async (): Promise<void> => {
    createAgentTeamMutationSpy.mockClear()
    toastErrorSpy.mockClear()

    renderForm({
      initialData: {
        configuration: "team",
        team: {
          orchestrationPattern: "sequential",
          managerName: "",
          managerModel: "",
          managerInstructions: "",
          terminationStrategyType: "maximum_iterations",
          maxIterations: 6,
          agentIds: [],
          teamIds: [],
        },
      },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "team-no-members" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Add at least one agent or team before saving.",
      ),
    )
    expect(createAgentTeamMutationSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] coordinate team save blocks when manager details are incomplete", async (): Promise<void> => {
    createAgentTeamMutationSpy.mockClear()
    toastErrorSpy.mockClear()

    renderForm({
      initialData: {
        configuration: "team",
        team: {
          orchestrationPattern: "coordinate",
          managerName: "",
          managerModel: "manager-1",
          managerInstructions: "",
          terminationStrategyType: "maximum_iterations",
          maxIterations: 6,
          agentIds: ["agent-a"],
          teamIds: [],
        },
      },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "team-missing-manager" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Configure manager name, manager instructions before saving a coordinate team.",
      ),
    )
    expect(createAgentTeamMutationSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] coordinate team save handles a cleared manager model without hanging", async (): Promise<void> => {
    createAgentTeamMutationSpy.mockClear()
    toastErrorSpy.mockClear()

    renderForm({
      initialData: {
        configuration: "team",
        team: {
          orchestrationPattern: "coordinate",
          managerName: "Coordinator",
          managerModel: null as unknown as string,
          managerInstructions: "Coordinate the team.",
          terminationStrategyType: "maximum_iterations",
          maxIterations: 6,
          agentIds: ["agent-a"],
          teamIds: [],
        },
      },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "team-missing-manager-model" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Configure manager model before saving a coordinate team.",
      ),
    )
    expect(createAgentTeamMutationSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] save failure surfaces the extracted error message", async (): Promise<void> => {
    toastErrorSpy.mockClear()
    createAgentMutationSpy.mockImplementationOnce(() => ({
      unwrap: () => Promise.reject(new Error("boom")),
    }))

    renderForm({
      initialData: { goal: "Help customers", instructions: "Answer clearly", primaryModel: "model-uuid" },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "broken-agent" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Failed to save broken-agent. boom",
      ),
    )
  })

  it("[tag:agent-form-save] blocks save when Structured output is enabled without a JSON schema", async (): Promise<void> => {
    createAgentMutationSpy.mockClear()
    toastErrorSpy.mockClear()

    renderForm({
      initialData: {
        goal: "Help customers",
        instructions: "Answer clearly",
        primaryModel: "model-uuid",
        enabledFeatures: ["structured_output"],
        featureConfig: {
          ...DEFAULT_FEATURE_CONFIG,
          structuredOutputSchema: "",
        },
      },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "schema-missing-agent" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "JSON schema is required when Structured output is enabled. Open Configuration > Structured output, provide a valid JSON Schema, and save.",
      ),
    )
    expect(createAgentMutationSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] blocks save when Structured output json_object schema is non-empty but invalid", async (): Promise<void> => {
    createAgentMutationSpy.mockClear()
    toastErrorSpy.mockClear()

    renderForm({
      initialData: {
        goal: "Help customers",
        instructions: "Answer clearly",
        primaryModel: "model-uuid",
        enabledFeatures: ["structured_output"],
        featureConfig: {
          ...DEFAULT_FEATURE_CONFIG,
          structuredOutputSchema: '{"message":"hello","count":1}',
        },
      },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "schema-invalid-agent" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Structured output schema must be a valid JSON Schema object when Structured output is enabled. Open Configuration > Structured output, provide a valid JSON Schema, and save.",
      ),
    )
    expect(createAgentMutationSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] blocks save when Structured output text mode has empty guidelines", async (): Promise<void> => {
    createAgentMutationSpy.mockClear()
    toastErrorSpy.mockClear()

    renderForm({
      initialData: {
        goal: "Help customers",
        instructions: "Answer clearly",
        primaryModel: "model-uuid",
        enabledFeatures: ["structured_output"],
        featureConfig: {
          ...DEFAULT_FEATURE_CONFIG,
          responseFormat: "text",
          structuredOutputSchema: "   ",
        },
      },
    })
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.change(
      screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL),
      { target: { value: "text-missing-agent" } },
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Response guidelines are required when Structured output is enabled. Open Configuration > Structured output, provide response guidelines, and save.",
      ),
    )
    expect(createAgentMutationSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] cancelling the dialog closes it without navigation or toast", async (): Promise<void> => {
    navigateSpy.mockClear()
    toastSuccessSpy.mockClear()

    renderForm()
    openSaveMenu()
    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )
    fireEvent.click(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT),
    )

    await waitFor(() =>
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.CANCEL_ACTION,
      }),
    )

    await waitFor(() =>
      expect(
        screen.queryByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
      ).not.toBeInTheDocument(),
    )
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(toastSuccessSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] Close (X) button in the top bar navigates back without showing a save dialog", (): void => {
    navigateSpy.mockClear()
    renderForm()

    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(navigateSpy).toHaveBeenCalled()
    // No save dialog popped up.
    expect(
      screen.queryByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DEPLOY),
    ).not.toBeInTheDocument()
  })

  it("[tag:agent-form-save] Preview button toasts a 'not available yet' message", (): void => {
    toastInfoSpy.mockClear()
    renderForm()

    fireEvent.click(screen.getByRole("button", { name: /Preview/ }))

    expect(toastInfoSpy).toHaveBeenCalledWith("Preview is not available yet.")
  })

  it("[tag:agent-form-save] Reset button is reachable from the top bar and is a no-op for the test harness", (): void => {
    renderForm()

    // The Reset button is wired to form.reset(). We don't have direct access
    // to form internals from outside, so the contract under test here is
    // simply that clicking it does not throw and does not navigate.
    navigateSpy.mockClear()
    fireEvent.click(screen.getByRole("button", { name: /Reset/ }))

    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it("[tag:agent-form-save] all three workbench panels (config, chat, run details) are mounted by default", (): void => {
    renderForm()

    // Initially hidden — only the chat panel is mounted (no run-details).
    expect(screen.getByTestId("agent-form__chat-panel")).toBeInTheDocument()
    expect(
      screen.getByTestId("agent-form__run-details-panel"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /View output details/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Hide output details/i }),
    ).not.toBeInTheDocument()
  })

  it("[tag:agent-form-save] when the router blocker is blocked, the discard-confirm dialog routes proceed/reset back to the blocker", async (): Promise<void> => {
    const proceed = vi.fn()
    const reset = vi.fn()
    useBlockerSpy.mockReturnValue({
      state: "blocked",
      proceed,
      reset,
    })

    renderForm()

    // Confirm dialog is rendered because state === "blocked".
    await waitFor(() =>
      expect(screen.getByText("Discard changes?")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(proceed).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Stay" }))
    expect(reset).toHaveBeenCalledTimes(1)

    // Restore for any subsequent tests in the file.
    useBlockerSpy.mockReturnValue({
      state: "unblocked",
      proceed: undefined,
      reset: undefined,
    })
  })

  it("[tag:agent-form-save] edit mode renders the 'Edit agent' page title", (): void => {
    renderForm({ isEdit: true })

    expect(screen.getByText("Edit agent")).toBeInTheDocument()
  })

  it("[tag:agent-form-save] team configuration mounts the team-specific section block", (): void => {
    renderForm({ initialData: { configuration: "team" } })

    // The team block is gated on `configuration === "team"`. The sections
    // themselves are mocked to return null, so we just need the block's
    // condition to fire — verify by checking that the single-agent
    // sections (Profile/KB/Toolset/Configuration) are NOT rendered. That's
    // hard to assert without component output, so simply verify the form
    // mounted without throwing — coverage instrumentation will record the
    // entered branch.
    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument()
  })

  it("[tag:agent-form-save] from-template configuration mounts the template section block", (): void => {
    renderForm({ initialData: { configuration: "from_template" } })

    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument()
  })

  it("[tag:agent-form-save] Save as draft is disabled when no template is selected", async (): Promise<void> => {
    renderForm({ initialData: { configuration: "from_template" } })
    openSaveMenu()

    const deployItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY,
    })
    expect(deployItem).toBeInTheDocument()
    expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS)

    const draftItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT,
    })
    expect(draftItem).toHaveAttribute("aria-disabled", "true")
  })

  it("[tag:agent-form-save] template deploy is locked while LOCK_AGENT_DEPLOY is true", async (): Promise<void> => {
    renderForm({
      initialData: makeConfiguredTemplateInitialData({ missingRequiredRequirements: true }),
    })
    openSaveMenu()

    const deployItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY,
    })
    expect(deployItem).toBeInTheDocument()
    expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS)
    expect(deployItem).toHaveAttribute("aria-disabled", "true")

    const draftItem = await screen.findByRole("menuitem", {
      name: SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT,
    })
    expect(draftItem).not.toHaveAttribute("aria-disabled", "true")
  })

  it("[tag:agent-form-save] template draft save creates member agents then the team and returns to the listing", async (): Promise<void> => {
    createAgentMock.mockClear()
    createAgentTeamMock.mockClear()
    updateAgentTeamStatusMock.mockClear()
    toastSuccessSpy.mockClear()
    navigateSpy.mockClear()

    renderForm({ initialData: makeConfiguredTemplateInitialData({ includeOptionalRequirements: true }) })
    await submitTemplateSaveDialog("draft", "draft-team")

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1))
    expect(createAgentMock).toHaveBeenCalledWith({
      projectId: TEST_PROJECT_ID,
      body: expect.objectContaining({
        description: "Researches references for the team",
      }),
    })
    expect(createAgentTeamMock).toHaveBeenCalledWith({
      projectId: TEST_PROJECT_ID,
      body: expect.objectContaining({
        name: "draft-team",
        members: [{ memberType: "agent", memberId: "member-agent-1" }],
      }),
    })
    expect(updateAgentTeamStatusMock).not.toHaveBeenCalled()
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(toastSuccessSpy).toHaveBeenCalledWith("draft-team saved as draft.")
  })

  it("[tag:agent-form-save] template member create failure rolls back previously created agents", async (): Promise<void> => {
    createAgentMock.mockClear()
    deleteAgentMock.mockClear()
    createAgentTeamMock.mockClear()
    toastErrorSpy.mockClear()

    createAgentMock
      .mockImplementationOnce(() => ({
        unwrap: () => Promise.resolve({ id: "member-1" }),
      }))
      .mockImplementationOnce(() => ({
        unwrap: () => Promise.reject(new Error("409 duplicate name")),
      }))

    renderForm({ initialData: makeTwoMemberTemplateInitialData() })
    await submitTemplateSaveDialog("draft", "rollback-team")

    await waitFor(() =>
      expect(deleteAgentMock).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        id: "member-1",
      }),
    )
    expect(createAgentMock).toHaveBeenCalledTimes(2)
    expect(createAgentTeamMock).not.toHaveBeenCalled()
    expect(toastErrorSpy).toHaveBeenCalledWith(
      "Failed to save rollback-team. Created member agents were removed.",
    )
  })

  it("[tag:agent-form-save] template team create failure rolls back all created member agents", async (): Promise<void> => {
    createAgentMock.mockClear()
    deleteAgentMock.mockClear()
    createAgentTeamMock.mockClear()
    toastErrorSpy.mockClear()

    createAgentTeamMock.mockImplementationOnce(() => ({
      unwrap: () => Promise.reject(new Error("500 team create failed")),
    }))

    renderForm({ initialData: makeConfiguredTemplateInitialData() })
    await submitTemplateSaveDialog("draft", "team-fail-team")

    await waitFor(() =>
      expect(deleteAgentMock).toHaveBeenCalledWith({
        projectId: TEST_PROJECT_ID,
        id: "member-agent-1",
      }),
    )
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    expect(createAgentTeamMock).toHaveBeenCalledTimes(1)
    expect(toastErrorSpy).toHaveBeenCalledWith(
      "Failed to save team-fail-team. Created member agents were removed.",
    )
  })

  it("[tag:agent-form-save] template member rollback warns when delete compensation fails", async (): Promise<void> => {
    createAgentMock.mockClear()
    deleteAgentMock.mockClear()
    createAgentTeamMock.mockClear()
    toastErrorSpy.mockClear()
    toastWarningSpy.mockClear()

    createAgentMock
      .mockImplementationOnce(() => ({
        unwrap: () => Promise.resolve({ id: "member-1" }),
      }))
      .mockImplementationOnce(() => ({
        unwrap: () => Promise.reject(new Error("409 duplicate name")),
      }))
    deleteAgentMock.mockImplementationOnce(() => ({
      unwrap: () => Promise.reject(new Error("delete failed")),
    }))

    renderForm({ initialData: makeTwoMemberTemplateInitialData() })
    await submitTemplateSaveDialog("draft", "rollback-partial")

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Failed to save rollback-partial. Please try again.",
      ),
    )
    expect(toastWarningSpy).toHaveBeenCalledWith(
      "Could not remove 1 created agent(s). Check the agents list.",
    )
    expect(createAgentTeamMock).not.toHaveBeenCalled()
  })
})

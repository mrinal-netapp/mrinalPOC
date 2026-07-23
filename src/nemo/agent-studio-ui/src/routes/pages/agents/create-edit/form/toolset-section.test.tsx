import { useState, type ReactElement } from "react"
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"

import { ToolsetSection } from "./toolset-section"
import type { AgentAttachedToolset, AgentFormValues, AgentResourceRequirement } from "./agent-form.consts"
import type { ToolsetOption } from "../configure-dialogs/configure-dialogs.types"

// Keep section tests focused on parent state transitions; the dropdown itself
// has dedicated coverage in the ui-lib tests.
vi.mock("@/ui-lib/base-components/select-dropdown/select-dropdown", () => ({
  SelectDropdown: ({
    label,
    value,
    items,
    onValueChange,
  }: {
    label?: string
    value?: string | number | null
    items: Array<{ key: string; value: string | number; label: string }>
    onValueChange?: (next: string | number | null) => void
  }) => {
    const currentIndex = items.findIndex((item) => item.value === value)
    const nextItem = items[(currentIndex + 1) % items.length]
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => onValueChange?.(nextItem?.value ?? null)}
      >
        {label}: {String(value ?? "(none)")}
      </button>
    )
  },
}))

// The section loads its catalog from the live MCP-servers query; mock the hook
// so the test drives a deterministic catalog without a store / network.
const TOOLSET_FIXTURE: ToolsetOption[] = [
  {
    id: "ts-1",
    name: "Sample toolset",
    status: "healthy",
    labels: ["Staging"],
    tools: [{ id: "tool-a", name: "tool-a", description: "" }],
  },
]

const mockToolsetToolsState = vi.hoisted(() => ({
  tools: [] as ToolsetOption["tools"],
  isLoading: false,
  isError: false,
  isReady: false,
}))

// Mutable so individual tests can vary the catalog (e.g. a server allow-list).
const mockToolsetOptionsState = vi.hoisted(() => ({
  options: [] as ToolsetOption[],
}))

vi.mock("./use-toolset-options", () => ({
  useToolsetOptions: () => ({
    options: mockToolsetOptionsState.options,
    isLoading: false,
    isError: false,
  }),
}))

// The selected toolset's live tool catalog is fetched separately; stub it so
// the section doesn't reach for the store / network.
vi.mock("./use-toolset-tools", () => ({
  useToolsetTools: () => mockToolsetToolsState,
}))

vi.setConfig({ testTimeout: 60_000 })

function Harness({
  initial = [] as AgentAttachedToolset[],
  mcpRequirements,
  onConfigureToolset,
  onChange,
}: {
  initial?: AgentAttachedToolset[]
  mcpRequirements?: React.ComponentProps<typeof ToolsetSection>["mcpRequirements"]
  onConfigureToolset?: (id: string) => void
  onChange?: (values: Pick<AgentFormValues, "toolsets" | "requirements">) => void
}): ReactElement {
  const form = useTestForm({
    toolsets: initial,
    requirements: {
      knowledgeBases: [],
      mcpServers: mcpRequirements ?? [],
    },
  })
  const [, force] = useState(0)
  form.store.subscribe(() => {
    onChange?.(form.state.values as Pick<AgentFormValues, "toolsets" | "requirements">)
    force((v) => v + 1)
  })
  const values = form.state.values as Pick<AgentFormValues, "requirements">
  return (
    <ToolsetSection
      form={form}
      mcpRequirements={values.requirements.mcpServers}
      onConfigureToolset={onConfigureToolset}
    />
  )
}

const mockToolset: AgentAttachedToolset = {
  id: "ts-1",
  name: "Sample toolset",
  status: "healthy",
  account: "Sample account",
  authMethod: "OAuth2",
  tools: ["tool-a", "tool-b"],
}

describe("ToolsetSection", () => {
  beforeEach(() => {
    mockToolsetToolsState.tools = []
    mockToolsetToolsState.isLoading = false
    mockToolsetToolsState.isError = false
    mockToolsetToolsState.isReady = false
    mockToolsetOptionsState.options = TOOLSET_FIXTURE
  })

  it("[tag:toolset-section] renders the heading and the 'Add toolset' CTA", () => {
    render(<Harness />)
    expect(screen.getByText("Toolset")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Add toolset/ }),
    ).toBeInTheDocument()
  })

  it("[tag:toolset-section] renders an attached card per item in the form's toolsets array", () => {
    render(<Harness initial={[mockToolset]} />)
    // The name shows as both the card title and the (linked) Name row.
    expect(screen.getAllByText("Sample toolset").length).toBeGreaterThan(0)
    expect(screen.getByText("tool-a, tool-b")).toBeInTheDocument()
  })

  it("[tag:toolset-section] fills missing attached tools from the catalog", () => {
    render(<Harness initial={[{ ...mockToolset, tools: [] }]} />)

    expect(screen.getByText("tool-a")).toBeInTheDocument()
  })

  it("[tag:toolset-section] renders an unresolved requirement card when requirements has an MCP but toolsets is empty", () => {
    const requirement: AgentResourceRequirement = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      label: "Required MCP placeholder",
      description: "Connect an MCP server before deployment.",
      required: true,
    }
    render(<Harness mcpRequirements={[requirement]} />)

    expect(screen.getAllByText("Required MCP placeholder").length).toBeGreaterThan(0)
    expect(screen.getByText("Connect an MCP server before deployment.")).toBeInTheDocument()
    expect(
      screen.getByText(/Toolset "Required MCP placeholder" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("[tag:toolset-section] does not show a deploy-blocking alert for optional unresolved MCP requirements", () => {
    const requirement: AgentResourceRequirement = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      label: "Optional MCP placeholder",
      description: "Connect an MCP server when available.",
      required: false,
    }
    render(<Harness mcpRequirements={[requirement]} />)

    expect(screen.getAllByText("Optional MCP placeholder").length).toBeGreaterThan(0)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Toolset "Optional MCP placeholder" must be configured to deploy this agent\./),
    ).not.toBeInTheDocument()
  })

  it("[tag:toolset-section] clicking Remove from the actions menu clears an unresolved MCP requirement", () => {
    const onChange = vi.fn()
    const requirement: AgentResourceRequirement = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      label: "Optional MCP placeholder",
      description: "Connect an MCP server before deployment.",
      required: true,
    }
    render(<Harness mcpRequirements={[requirement]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    fireEvent.click(screen.getByText("Remove"))

    expect(screen.getByText("Remove unconfigured toolset?")).toBeInTheDocument()
    expect(screen.getByText(/You are removing the unconfigured toolset "Optional MCP placeholder"/)).toBeInTheDocument()
    // Requirement label appears in both the card header and body row; use getAllByText.
    expect(screen.getAllByText("Optional MCP placeholder").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "Remove" }))

    expect(screen.queryByText("Optional MCP placeholder")).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requirements: expect.objectContaining({ mcpServers: [] }),
      }),
    )
  })

  it("[tag:toolset-section] configuring an unresolved MCP requirement attaches a toolset and clears the requirement", () => {
    const onChange = vi.fn()
    const requirement: AgentResourceRequirement = {
      id: "ts-1",
      label: "Sample toolset",
      description: "Connect an MCP server before deployment.",
      required: true,
    }
    render(<Harness mcpRequirements={[requirement]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    expect(screen.getByText("Toolset: ts-1")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select tool tool-a" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [expect.objectContaining({ id: "ts-1" })],
        requirements: expect.objectContaining({ mcpServers: [] }),
      }),
    )
  })

  it("[tag:toolset-section] uses the selected toolset's live tools when they are ready", () => {
    mockToolsetToolsState.isReady = true
    mockToolsetToolsState.tools = [
      { id: "live-tool", name: "live-tool", description: "Live tool" },
    ]
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: /Add toolset/ }))
    fireEvent.click(screen.getByRole("button", { name: "Toolset" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select tool live-tool" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [expect.objectContaining({ tools: ["live-tool"] })],
      }),
    )
  })

  it("[tag:toolset-section] only offers live tools that are in the server's allow-list", () => {
    // Server permits only "allowed-tool"; the live catalog also exposes
    // "blocked-tool". The picker must offer only the allow-listed one.
    mockToolsetOptionsState.options = [
      {
        id: "ts-1",
        name: "Sample toolset",
        status: "healthy",
        labels: [],
        tools: [{ id: "allowed-tool", name: "allowed-tool", description: "" }],
        allowedToolNames: ["allowed-tool"],
      },
    ]
    mockToolsetToolsState.isReady = true
    mockToolsetToolsState.tools = [
      { id: "allowed-tool", name: "allowed-tool", description: "Allowed" },
      { id: "blocked-tool", name: "blocked-tool", description: "Not allowed by server" },
    ]
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: /Add toolset/ }))
    fireEvent.click(screen.getByRole("button", { name: "Toolset" }))

    expect(
      screen.getByRole("checkbox", { name: "Select tool allowed-tool" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("checkbox", { name: "Select tool blocked-tool" }),
    ).not.toBeInTheDocument()
  })

  it("[tag:toolset-section] treats a null allow-list as 'no restriction' and does not crash", () => {
    // config-service serializes a server with no allow-list as `allowedTools:
    // null` (a nullable column), not `undefined`. The picker must treat that as
    // "every live tool is allowed" — a naive `=== undefined` guard would call
    // `null.includes(...)` and throw during render (blank-screen crash).
    mockToolsetOptionsState.options = [
      {
        id: "ts-1",
        name: "Sample toolset",
        status: "healthy",
        labels: [],
        tools: [],
        allowedToolNames: null as unknown as string[] | undefined,
      },
    ]
    mockToolsetToolsState.isReady = true
    mockToolsetToolsState.tools = [
      { id: "live-tool", name: "live-tool", description: "Live tool" },
    ]
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: /Add toolset/ }))
    fireEvent.click(screen.getByRole("button", { name: "Toolset" }))

    expect(
      screen.getByRole("checkbox", { name: "Select tool live-tool" }),
    ).toBeInTheDocument()
  })

  it("[tag:toolset-section] cancelling unresolved MCP removal keeps the requirement card", () => {
    const requirement: AgentResourceRequirement = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      label: "Optional MCP placeholder",
      description: "Connect an MCP server before deployment.",
      required: true,
    }
    render(<Harness mcpRequirements={[requirement]} />)

    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    fireEvent.click(screen.getByText("Remove"))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    // Requirement label appears in both the card header and body row; use getAllByText.
    expect(screen.getAllByText("Optional MCP placeholder").length).toBeGreaterThan(0)
    expect(screen.queryByText("Remove unconfigured toolset?")).not.toBeInTheDocument()
  })

  it("[tag:toolset-section] clicking Remove from the actions menu clears an attached toolset", () => {
    const onChange = vi.fn()
    render(<Harness initial={[mockToolset]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    fireEvent.click(screen.getByText("Remove"))

    expect(screen.queryByText("Sample toolset")).not.toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [],
      }),
    )
  })

  it("[tag:toolset-section] non-healthy status renders the raw status string with the matching dot modifier", () => {
    // Use an id absent from the catalog so enrichWithCatalog leaves the
    // attached (unhealthy) status untouched.
    const { container } = render(
      <Harness initial={[{ ...mockToolset, id: "ts-x", status: "unhealthy" }]} />,
    )
    expect(screen.getByText("unhealthy")).toBeInTheDocument()
    expect(
      container.querySelector(".agent-form__status-dot--unhealthy"),
    ).not.toBeNull()
  })

  it("[tag:toolset-section] clicking the card's Configure button fires onConfigureToolset with the toolset id", () => {
    const onConfigure = vi.fn()
    render(<Harness initial={[mockToolset]} onConfigureToolset={onConfigure} />)
    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    expect(onConfigure).toHaveBeenCalledWith("ts-1")
  })

  it("[tag:toolset-section] clicking Configure on an attached toolset opens the dialog and saving edits in place", () => {
    const onChange = vi.fn()
    render(
      <Harness initial={[{ ...mockToolset, tools: ["tool-a"] }]} onChange={onChange} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    // Dialog opens (its Save/Cancel actions are present).
    expect(screen.getAllByRole("button", { name: /Cancel/i }).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: /Save/i }))

    // Edited in place (not appended): still a single entry with the same id.
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [expect.objectContaining({ id: "ts-1" })],
      }),
    )
  })

  it("[tag:toolset-section] clicking 'Add toolset' opens the toolset config dialog", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: /Add toolset/ }))
    // Dialog open: a Cancel button (or section heading inside the dialog) appears.
    expect(
      screen.getAllByRole("button", { name: /Cancel/i }).length,
    ).toBeGreaterThan(0)
  })

  it("[tag:toolset-section] shows the inline requirement error banner when the toolset id matches a requirement entry", () => {
    const requirement: AgentResourceRequirement = {
      id: "ts-1",
      label: "Sample toolset",
      description: "Auth token is missing.",
      required: true,
    }
    render(<Harness initial={[mockToolset]} mcpRequirements={[requirement]} />)
    expect(
      screen.getByText(/Toolset "Sample toolset" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("[tag:toolset-section] does not show the error banner when mcpRequirements is empty", () => {
    render(<Harness initial={[mockToolset]} mcpRequirements={[]} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("[tag:toolset-section] falls back to the toolset name in the message when a required requirement label is absent", () => {
    const requirement: AgentResourceRequirement = {
      id: "ts-1",
      label: "",
      description: "",
      required: true,
    }
    render(<Harness initial={[mockToolset]} mcpRequirements={[requirement]} />)
    expect(
      screen.getByText(/Toolset "Sample toolset" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
  })

  it("[tag:toolset-section] only shows the error banner on the card whose id matches, not on others", () => {
    const secondToolset: AgentAttachedToolset = {
      ...mockToolset,
      id: "ts-2",
      name: "Second toolset",
    }
    const requirement: AgentResourceRequirement = {
      id: "ts-2",
      label: "Second toolset",
      description: "Auth missing.",
      required: true,
    }
    render(<Harness initial={[mockToolset, secondToolset]} mcpRequirements={[requirement]} />)
    // Only one alert — only ts-2 has a requirement error.
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(
      screen.getByText(/Toolset "Second toolset" must be configured to deploy this agent\./),
    ).toBeInTheDocument()
  })

  it("[tag:toolset-section] cancelling the add-toolset dialog leaves the toolsets array unchanged", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /Add toolset/ }))
    fireEvent.click(screen.getAllByRole("button", { name: /Cancel/i })[0])
    // No toolset was appended.
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        toolsets: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String) }),
        ]),
      }),
    )
  })

  it("[tag:toolset-section] enriches the selected toolset catalog while configuring an attachment", () => {
    const onChange = vi.fn()
    render(<Harness initial={[mockToolset]} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    fireEvent.click(screen.getByRole("button", { name: /Save/i }))

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [expect.objectContaining({ id: "ts-1" })],
      }),
    )
  })

  it("[tag:toolset-section] renders a validation error message when provided", () => {
    function ErrorHarness(): ReactElement {
      const form = useTestForm({ toolsets: [] })
      return <ToolsetSection form={form} errorMessage="Configure toolsets to deploy" />
    }

    render(<ErrorHarness />)
    expect(screen.getByText("Configure toolsets to deploy")).toBeInTheDocument()
  })
})

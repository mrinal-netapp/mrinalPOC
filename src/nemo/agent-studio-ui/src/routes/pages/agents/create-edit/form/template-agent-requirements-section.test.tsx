import { useState, type ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useTestForm } from "@test/render";

import type { AgentTemplateAgentRequirements } from "./agent-templates.consts";
import {
  buildEmptyTemplateAgentInstance,
  type AgentAttachedKB,
  type AgentAttachedToolset,
  type AgentTemplateAgentInstanceValues,
} from "./agent-form.consts";
import { TemplateAgentRequirementsSection } from "./template-agent-requirements-section";
import type { KnowledgeBaseOption, ToolsetOption } from "../configure-dialogs/configure-dialogs.types";

const KB_FIXTURE: KnowledgeBaseOption[] = [
  { id: "kb-a", name: "KB A", status: "available", labels: ["prod"] },
];

const TOOLSET_FIXTURE: ToolsetOption[] = [
  {
    id: "ts-1",
    name: "GitHub",
    status: "healthy",
    labels: ["prod"],
    tools: [
      { id: "search", name: "search", description: "" },
      { id: "create", name: "create", description: "" },
    ],
  },
];

vi.mock("./use-knowledge-base-options", () => ({
  useKnowledgeBaseOptions: () => ({
    options: KB_FIXTURE,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("./use-toolset-options", () => ({
  useToolsetOptions: () => ({
    options: TOOLSET_FIXTURE,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("./use-toolset-tools", () => ({
  useToolsetTools: (toolsetId: string) => ({
    tools:
      toolsetId === "ts-1"
        ? [
            { id: "search", name: "search", description: "" },
            { id: "create", name: "create", description: "" },
          ]
        : [],
    isLoading: false,
    isError: false,
    isReady: toolsetId === "ts-1",
  }),
}));

vi.mock("@/ui-lib/base-components/select-dropdown/select-dropdown", () => ({
  SelectDropdown: ({
    label,
    value,
    items,
    onValueChange,
    disabled,
  }: {
    label?: string;
    value?: string | number | null;
    items: Array<{ key: string; value: string | number; label: string }>;
    onValueChange?: (next: string | number | null) => void;
    disabled?: boolean;
  }) => {
    const idx = items.findIndex((item) => item.value === value);
    const next = items[(idx + 1) % Math.max(items.length, 1)];
    return (
      <button
        type="button"
        aria-label={label}
        disabled={disabled || items.length === 0}
        onClick={() => onValueChange?.(next?.value ?? null)}
      >
        {label}: {String(value ?? "(none)")}
      </button>
    );
  },
}));

vi.setConfig({ testTimeout: 90_000 });

const FIELD_PREFIX = "template.agentInstances[0]";

const REQUIREMENTS: AgentTemplateAgentRequirements = {
  knowledgeBases: [
    { id: "kb-req", label: "Required KB", description: "", required: true },
    { id: "kb-opt", label: "Optional KB", description: "", required: false },
  ],
  mcpServers: [
    { id: "mcp-req", label: "Required MCP", description: "", required: true },
    { id: "mcp-opt", label: "Optional MCP", description: "", required: false },
  ],
};

function Harness({
  instance = buildEmptyTemplateAgentInstance(),
  knowledgeBasesError,
  toolsetsError,
  onChange,
}: {
  instance?: AgentTemplateAgentInstanceValues;
  knowledgeBasesError?: string;
  toolsetsError?: string;
  onChange?: (instance: AgentTemplateAgentInstanceValues) => void;
}): ReactElement {
  const form = useTestForm({
    template: {
      agentInstances: [instance],
    },
  });
  const [, force] = useState(0);
  form.store.subscribe(() => {
    onChange?.(form.state.values.template.agentInstances[0]);
    force((v) => v + 1);
  });

  return (
    <TemplateAgentRequirementsSection
      form={form}
      fieldPrefix={FIELD_PREFIX}
      requirements={REQUIREMENTS}
      knowledgeBasesError={knowledgeBasesError}
      toolsetsError={toolsetsError}
    />
  );
}

const configuredKb: AgentAttachedKB = {
  id: "kb-a",
  name: "KB A",
  status: "healthy",
  tier: "prod",
  remaining: "—",
  fileUsage: "Top K: 5",
};

const configuredToolset: AgentAttachedToolset = {
  id: "ts-1",
  name: "GitHub",
  status: "healthy",
  account: "GitHub",
  authMethod: "prod",
  tools: ["search"],
};

describe("TemplateAgentRequirementsSection", () => {
  it("renders section headings and add-resource actions", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Knowledge bases" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Toolset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add knowledge base/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add toolset/ })).toBeInTheDocument();
  });

  it("shows unconfigured required and optional requirement cards with deploy errors", () => {
    render(
      <Harness
        knowledgeBasesError="kb-error"
        toolsetsError="tool-error"
      />,
    );

    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Optional").length).toBe(2);
    expect(screen.getAllByText("Disabled").length).toBe(2);
    expect(
      screen.getByText(/Knowledge base .Required KB. must be configured or removed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Toolset .Required MCP. must be configured or removed/i),
    ).toBeInTheDocument();
  });

  it("renders configured requirement cards and extra attached resources", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          knowledgeBases: [
            configuredKb,
            {
              id: "kb-extra",
              name: "Extra KB",
              status: "healthy",
              tier: "qa",
              remaining: "—",
              fileUsage: "Top K: 3",
            },
          ],
          toolsets: [
            configuredToolset,
            {
              id: "ts-extra",
              name: "Extra toolset",
              status: "healthy",
              account: "Extra",
              authMethod: "token",
              tools: ["ping"],
            },
          ],
          satisfiedKbRequirementIds: ["kb-req"],
          satisfiedMcpRequirementIds: ["mcp-req"],
          kbRequirementAttachments: { "kb-req": "kb-a" },
          mcpRequirementAttachments: { "mcp-req": "ts-1" },
        }}
      />,
    );

    expect(screen.getByText("KB A")).toBeInTheDocument();
    expect(screen.getByText("Extra KB")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Extra toolset")).toBeInTheDocument();
  });

  it("saves a new knowledge base for a requirement and tracks satisfaction", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    const configureButtons = screen.getAllByRole("button", { name: "Configure" });
    fireEvent.click(configureButtons[0]);
    expect(screen.getByText("Configure knowledge base")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Knowledge base" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [expect.objectContaining({ id: "kb-a", name: "KB A" })],
        satisfiedKbRequirementIds: ["kb-req"],
        kbRequirementAttachments: { "kb-req": "kb-a" },
      }),
    );
  });

  it("removes a configured knowledge-base requirement and clears attachments", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          knowledgeBases: [configuredKb],
          toolsets: [configuredToolset],
          satisfiedKbRequirementIds: ["kb-req"],
          satisfiedMcpRequirementIds: ["mcp-req"],
          kbRequirementAttachments: { "kb-req": "kb-a" },
          mcpRequirementAttachments: { "mcp-req": "ts-1" },
        }}
        onChange={onChange}
      />,
    );

    const moreActions = screen.getAllByRole("button", { name: "More actions" });
    await user.click(moreActions[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        removedKbRequirementIds: ["kb-req"],
        satisfiedKbRequirementIds: [],
        knowledgeBases: [],
      }),
    );
  });

  it("configures and saves a required toolset requirement", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    const configureButtons = screen.getAllByRole("button", { name: "Configure" });
    fireEvent.click(configureButtons[2]);
    expect(screen.getByText("Configure toolset details")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toolset" }));
    await user.click(screen.getByRole("checkbox", { name: "Select all tools" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        satisfiedMcpRequirementIds: ["mcp-req"],
        mcpRequirementAttachments: { "mcp-req": "ts-1" },
      }),
    );
  });

  it("removes an extra attached knowledge base without touching template requirements", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          knowledgeBases: [
            configuredKb,
            {
              id: "kb-extra",
              name: "Extra KB",
              status: "healthy",
              tier: "qa",
              remaining: "—",
              fileUsage: "Top K: 3",
            },
          ],
          satisfiedKbRequirementIds: ["kb-req"],
          kbRequirementAttachments: { "kb-req": "kb-a" },
        }}
        onChange={onChange}
      />,
    );

    const extraCard = screen.getByText("Extra KB").closest(".card");
    expect(extraCard).not.toBeNull();
    const removeTrigger = within(extraCard as HTMLElement).getByRole("button", {
      name: "More actions",
    });
    await user.click(removeTrigger);
    await user.click((await screen.findAllByRole("menuitem", { name: "Remove" })).at(-1)!);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [configuredKb],
        satisfiedKbRequirementIds: ["kb-req"],
      }),
    );
  });

  it("closes the knowledge-base dialog without saving changes", async () => {
    const user = userEvent.setup();

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Add knowledge base/ }));
    expect(screen.getByText("Configure knowledge base")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByText("Configure knowledge base")).not.toBeInTheDocument();
  });

  it("updates an existing requirement knowledge base when re-configured", () => {
    const onChange = vi.fn();

    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          knowledgeBases: [configuredKb],
          satisfiedKbRequirementIds: ["kb-req"],
          kbRequirementAttachments: { "kb-req": "kb-a" },
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Configure" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [expect.objectContaining({ id: "kb-a" })],
        satisfiedKbRequirementIds: ["kb-req"],
      }),
    );
  });

  it("removes a configured toolset requirement and clears its attachment", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          knowledgeBases: [configuredKb],
          toolsets: [configuredToolset],
          satisfiedKbRequirementIds: ["kb-req"],
          satisfiedMcpRequirementIds: ["mcp-req"],
          kbRequirementAttachments: { "kb-req": "kb-a" },
          mcpRequirementAttachments: { "mcp-req": "ts-1" },
        }}
        onChange={onChange}
      />,
    );

    const toolsetSection = screen.getByRole("heading", { name: "Toolset" }).closest("section");
    expect(toolsetSection).not.toBeNull();
    const configuredCard = within(toolsetSection as HTMLElement)
      .getByText("GitHub")
      .closest(".card");
    expect(configuredCard).not.toBeNull();
    await user.click(
      within(configuredCard as HTMLElement).getByRole("button", { name: "More actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        removedMcpRequirementIds: ["mcp-req"],
        satisfiedMcpRequirementIds: [],
        toolsets: [],
      }),
    );
  });

  it("removes an optional unconfigured knowledge-base requirement", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    const kbSection = screen.getByRole("heading", { name: "Knowledge bases" }).closest("section");
    expect(kbSection).not.toBeNull();
    const optionalCard = within(kbSection as HTMLElement)
      .getByText("Optional")
      .closest(".agent-form__template-agent-summary-card");
    expect(optionalCard).not.toBeNull();
    await user.click(
      within(optionalCard as HTMLElement).getByRole("button", { name: "More actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        removedKbRequirementIds: ["kb-opt"],
      }),
    );
  });

  it("saves an extra knowledge base from Add without a requirement id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Add knowledge base/ }));
    await user.click(screen.getByRole("button", { name: "Knowledge base" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBases: [expect.objectContaining({ id: "kb-a" })],
        satisfiedKbRequirementIds: [],
      }),
    );
  });

  it("edits an existing toolset requirement in place", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          toolsets: [configuredToolset],
          satisfiedMcpRequirementIds: ["mcp-req"],
          mcpRequirementAttachments: { "mcp-req": "ts-1" },
        }}
        onChange={onChange}
      />,
    );

    const toolsetSection = screen.getByRole("heading", { name: "Toolset" }).closest("section");
    expect(toolsetSection).not.toBeNull();
    const configuredCard = within(toolsetSection as HTMLElement)
      .getByText("GitHub")
      .closest(".card");
    expect(configuredCard).not.toBeNull();
    await user.click(
      within(configuredCard as HTMLElement).getByRole("button", { name: "Configure" }),
    );
    await user.click(screen.getByRole("button", { name: /Save/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [expect.objectContaining({ id: "ts-1" })],
        satisfiedMcpRequirementIds: ["mcp-req"],
      }),
    );
  });

  it("removes an extra attached toolset without touching template requirements", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          toolsets: [
            configuredToolset,
            {
              id: "ts-extra",
              name: "Extra toolset",
              status: "healthy",
              account: "Extra",
              authMethod: "token",
              tools: ["ping"],
            },
          ],
          satisfiedMcpRequirementIds: ["mcp-req"],
          mcpRequirementAttachments: { "mcp-req": "ts-1" },
        }}
        onChange={onChange}
      />,
    );

    const extraCard = screen.getByText("Extra toolset").closest(".card");
    expect(extraCard).not.toBeNull();
    const removeTrigger = within(extraCard as HTMLElement).getByRole("button", {
      name: "More actions",
    });
    await user.click(removeTrigger);
    await user.click((await screen.findAllByRole("menuitem", { name: "Remove" })).at(-1)!);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [configuredToolset],
        satisfiedMcpRequirementIds: ["mcp-req"],
      }),
    );
  });

  it("saves an extra toolset from Add without a requirement id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Add toolset/ }));
    await user.click(screen.getByRole("button", { name: "Toolset" }));
    await user.click(screen.getByRole("checkbox", { name: "Select all tools" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolsets: [expect.objectContaining({ id: "ts-1" })],
        satisfiedMcpRequirementIds: [],
      }),
    );
  });

  it("closes the toolset dialog without saving changes", async () => {
    const user = userEvent.setup();

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Add toolset/ }));
    expect(screen.getByText("Configure toolset details")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByText("Configure toolset details")).not.toBeInTheDocument();
  });

  it("omits a configured KB requirement card when the attachment is missing from knowledgeBases", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          satisfiedKbRequirementIds: ["kb-req"],
          kbRequirementAttachments: { "kb-req": "kb-missing" },
        }}
      />,
    );

    expect(screen.queryByText("KB A")).not.toBeInTheDocument();
    expect(screen.getAllByText("Optional").length).toBeGreaterThan(0);
  });

  it("omits a configured toolset requirement card when the attachment is missing from toolsets", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          satisfiedMcpRequirementIds: ["mcp-req"],
          mcpRequirementAttachments: { "mcp-req": "ts-missing" },
        }}
      />,
    );

    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.getAllByText("Optional").length).toBeGreaterThan(0);
  });

  it("removes an optional unconfigured toolset requirement", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    const toolsetSection = screen.getByRole("heading", { name: "Toolset" }).closest("section");
    expect(toolsetSection).not.toBeNull();
    const optionalCard = within(toolsetSection as HTMLElement)
      .getAllByText("Optional")[0]
      .closest(".card");
    expect(optionalCard).not.toBeNull();
    const moreActions = within(optionalCard as HTMLElement).getByRole("button", {
      name: "More actions",
    });
    await user.click(moreActions);
    await user.click(
      (await screen.findAllByRole("menuitem", { name: "Remove" })).at(-1)!,
    );

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        removedMcpRequirementIds: ["mcp-opt"],
      }),
    );
  });
});

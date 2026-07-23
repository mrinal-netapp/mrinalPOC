import { useState, type ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useTestForm } from "@test/render";

import type { AgentTemplateAgentDefinition } from "./agent-templates.consts";
import {
  buildEmptyTemplateAgentInstance,
  type AgentTemplateAgentInstanceValues,
} from "./agent-form.consts";
import { TemplateAgentCard } from "./template-agent-card";

vi.mock("../configure-dialogs/template-agent-config-dialog/template-agent-config-dialog", () => ({
  TemplateAgentConfigDialog: ({ open }: { open: boolean }) =>
    open ? <div>Configure agent</div> : null,
}));

vi.setConfig({ testTimeout: 60_000 });

const FIELD_PREFIX = "template.agentInstances[0]";

const AGENT_DEF: AgentTemplateAgentDefinition = {
  name: "Researcher",
  role: "assistant",
  systemPrompt: "Find references",
  modelId: "model-a",
  requirements: {
    knowledgeBases: [{ id: "kb-req", label: "Docs KB", description: "", required: true }],
    mcpServers: [{ id: "mcp-req", label: "GitHub", description: "", required: true }],
  },
};

function Harness({
  instance = buildEmptyTemplateAgentInstance(),
  headerLabel,
  subtitle,
  hideResources = false,
  agentDefinition = AGENT_DEF,
  onRemove,
}: {
  instance?: AgentTemplateAgentInstanceValues;
  headerLabel?: string;
  subtitle?: string;
  hideResources?: boolean;
  agentDefinition?: AgentTemplateAgentDefinition;
  onRemove?: () => void;
}): ReactElement {
  const form = useTestForm({
    template: {
      agentInstances: [instance],
    },
  });
  const [, force] = useState(0);
  form.store.subscribe(() => force((v) => v + 1));

  return (
    <TemplateAgentCard
      form={form}
      fieldPrefix={FIELD_PREFIX}
      agentDefinition={agentDefinition}
      headerLabel={headerLabel}
      subtitle={subtitle}
      hideResources={hideResources}
      onRemove={onRemove}
    />
  );
}

describe("TemplateAgentCard", () => {
  it("shows Not configured until required fields and resources are satisfied", () => {
    render(<Harness />);
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("Knowledge base")).toBeInTheDocument();
    expect(screen.getByText("Toolsets")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("lists the template's unmet KB and toolset requirements so the user knows what to add", () => {
    render(<Harness />);

    // AGENT_DEF requires "Docs KB" and "GitHub"; neither is attached yet.
    expect(screen.getByText("Docs KB")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("marks a non-required requirement as optional and drops it once satisfied", () => {
    const agentDefinition: AgentTemplateAgentDefinition = {
      ...AGENT_DEF,
      requirements: {
        knowledgeBases: [
          { id: "kb-req", label: "Docs KB", description: "", required: true },
          { id: "kb-opt", label: "Extra KB", description: "", required: false },
        ],
        mcpServers: AGENT_DEF.requirements.mcpServers,
      },
    };

    render(
      <Harness
        agentDefinition={agentDefinition}
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          satisfiedKbRequirementIds: ["kb-req"],
        }}
      />,
    );

    expect(screen.queryByText("Docs KB")).not.toBeInTheDocument();
    expect(screen.getByText("Extra KB (optional)")).toBeInTheDocument();
  });

  it("shows Ready to deploy and linked resources when the instance is complete", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          primaryModel: "claude",
          name: "Researcher",
          instructions: "Find references",
          knowledgeBases: [
            {
              id: "kb-1",
              name: "Docs KB",
              status: "healthy",
              tier: "prod",
              remaining: "—",
              fileUsage: "Top K: 5",
            },
          ],
          toolsets: [
            {
              id: "ts-1",
              name: "GitHub",
              status: "healthy",
              account: "GitHub",
              authMethod: "OAuth",
              tools: ["search"],
            },
          ],
          satisfiedKbRequirementIds: ["kb-req"],
          satisfiedMcpRequirementIds: ["mcp-req"],
        }}
      />,
    );

    expect(screen.getByText("Ready to deploy")).toBeInTheDocument();
    expect(screen.getByText("Docs KB")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("uses the header label, subtitle, and hides resource rows for the manager card", () => {
    render(
      <Harness
        headerLabel="Manager agent"
        subtitle="Optional"
        hideResources
      />,
    );

    expect(screen.getByText("Manager agent")).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent name for Manager agent")).toBeInTheDocument();
    expect(screen.queryByText("Knowledge base")).not.toBeInTheDocument();
    expect(screen.queryByText("Toolsets")).not.toBeInTheDocument();
  });

  it("renders knowledge base and toolset links with detail hrefs", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          name: "Researcher",
          knowledgeBases: [
            {
              id: "kb-1",
              name: "Docs KB",
              status: "healthy",
              tier: "prod",
              remaining: "—",
              fileUsage: "Top K: 5",
            },
            {
              id: "kb-2",
              name: "Runbooks KB",
              status: "healthy",
              tier: "prod",
              remaining: "—",
              fileUsage: "Top K: 3",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Open Docs KB in a new tab" }),
    ).toHaveAttribute("href", "/knowledge-bases/kb-1");
    expect(
      screen.getByRole("link", { name: "Open Runbooks KB in a new tab" }),
    ).toHaveAttribute("href", "/knowledge-bases/kb-2");
  });

  it("allows editing the agent name inline on the summary card", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          name: "Researcher 20260701-143052",
        }}
      />,
    );

    const nameInput = screen.getByLabelText("Agent name for Researcher");
    expect(nameInput).toHaveValue("Researcher 20260701-143052");

    await user.clear(nameInput);
    await user.type(nameInput, "Custom agent name");
    expect(nameInput).toHaveValue("Custom agent name");
  });

  it("uses distinct name field labels per catalog agent when multiple cards are shown", () => {
    const writerDef: AgentTemplateAgentDefinition = {
      ...AGENT_DEF,
      name: "Writer",
      role: "writer",
    };

    function MultiCardHarness(): ReactElement {
      const form = useTestForm({
        template: {
          agentInstances: [
            buildEmptyTemplateAgentInstance(),
            buildEmptyTemplateAgentInstance(),
          ],
        },
      });

      return (
        <>
          <TemplateAgentCard
            form={form}
            fieldPrefix="template.agentInstances[0]"
            agentDefinition={AGENT_DEF}
            headerLabel="Single agent"
          />
          <TemplateAgentCard
            form={form}
            fieldPrefix="template.agentInstances[1]"
            agentDefinition={writerDef}
            headerLabel="Single agent"
          />
        </>
      );
    }

    render(<MultiCardHarness />);

    expect(screen.getByLabelText("Agent name for Researcher")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent name for Writer")).toBeInTheDocument();
  });

  it("opens the configure dialog and exposes Remove when onRemove is provided", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    render(<Harness onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(screen.getByText("Configure agent")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("renders role when the catalog defines one", () => {
    const { container } = render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          name: "Researcher",
        }}
      />,
    );

    const roleRow = within(container).getByText("Role").parentElement;
    expect(roleRow?.textContent).toContain("assistant");
  });

  it("shows description from the instance when provided", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          name: "Researcher",
          description: "Monitors compliance drift",
        }}
      />,
    );

    expect(screen.getByText("Monitors compliance drift")).toBeInTheDocument();
  });

  it("hides the description row on the manager card", () => {
    render(
      <Harness
        hideResources
        headerLabel="Manager agent"
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          name: "Coordinator",
          description: "Should not appear",
        }}
      />,
    );

    expect(screen.queryByText("Description")).not.toBeInTheDocument();
    expect(screen.queryByText("Should not appear")).not.toBeInTheDocument();
  });

  it("shows an em dash when there is no role", () => {
    render(
      <Harness
        instance={{
          ...buildEmptyTemplateAgentInstance(),
          name: "Researcher",
        }}
        agentDefinition={{ ...AGENT_DEF, role: "" }}
      />,
    );

    const roleRow = screen.getByText("Role").parentElement;
    expect(roleRow?.textContent).toContain("—");
  });
});

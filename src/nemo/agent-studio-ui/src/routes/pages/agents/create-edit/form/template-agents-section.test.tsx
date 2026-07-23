import { type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTestForm } from "@test/render";

import type { AgentTemplateDefinition } from "./agent-templates.consts";
import { TemplateAgentsSection } from "./template-agents-section";

vi.mock("./template-agent-card", () => ({
  TemplateAgentCard: ({
    headerLabel,
    onRemove,
  }: {
    headerLabel?: string;
    onRemove?: () => void;
  }) => (
    <div>
      <span>{headerLabel ?? "card"}</span>
      {onRemove && (
        <button type="button" onClick={onRemove}>
          Remove card
        </button>
      )}
    </div>
  ),
}));

vi.mock("./team-agents-section", () => ({
  TeamAgentsSection: () => <div>team-agents</div>,
}));

vi.mock("./team-teams-section", () => ({
  TeamTeamsSection: () => <div>team-teams</div>,
}));

const TEMPLATE: AgentTemplateDefinition = {
  id: "tmpl-1",
  name: "Template Name",
  description: "desc",
  capabilities: [],
  examples: [],
  instructions: "Template instructions",
  orchestrationPattern: "Sequential",
  model: "claude",
  role: "manager",
  agents: [
    {
      name: "Agent one",
      role: "assistant",
      systemPrompt: "A",
      modelId: "m1",
      requirements: { knowledgeBases: [], mcpServers: [] },
    },
    {
      name: "Agent two",
      role: "assistant",
      systemPrompt: "B",
      modelId: "m2",
      requirements: { knowledgeBases: [], mcpServers: [] },
    },
  ],
};

function Harness({
  selectedTemplate,
  orchestrationPattern = "sequential",
}: {
  selectedTemplate: AgentTemplateDefinition | null;
  orchestrationPattern?: string;
}): ReactElement {
  const form = useTestForm({
    template: {
      selectedTemplate,
      managerInstance: null,
      orchestrationPattern,
      agentInstances: selectedTemplate
        ? selectedTemplate.agents.map(() => ({
            primaryModel: "",
            primaryModelParams: { temperature: "0.5", topP: "0.7" },
            fallbackModel: "",
            fallbackModelParams: { temperature: "0.5", topP: "0.7" },
            name: "",
            instructions: "",
            knowledgeBases: [],
            toolsets: [],
            enabledFeatures: [],
            featureConfig: {},
            satisfiedKbRequirementIds: [],
            satisfiedMcpRequirementIds: [],
            kbRequirementAttachments: {},
            mcpRequirementAttachments: {},
            removedKbRequirementIds: [],
            removedMcpRequirementIds: [],
          }))
        : [],
    },
  });

  return <TemplateAgentsSection form={form} />;
}

describe("TemplateAgentsSection", () => {
  it("returns null when no template is selected", () => {
    const { container } = render(<Harness selectedTemplate={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders member sections and team sections when template exists", () => {
    render(<Harness selectedTemplate={TEMPLATE} orchestrationPattern="sequential" />);

    expect(screen.queryByText("Manager agent")).not.toBeInTheDocument();
    expect(screen.getByText("Single agents")).toBeInTheDocument();
    expect(screen.getByText("Team agents")).toBeInTheDocument();
    expect(screen.getByText("team-agents")).toBeInTheDocument();
    expect(screen.getByText("team-teams")).toBeInTheDocument();
  });

  it("renders the manager section for coordinate orchestration", () => {
    render(<Harness selectedTemplate={TEMPLATE} orchestrationPattern="coordinate" />);

    expect(screen.getByText("Manager agent")).toBeInTheDocument();
    expect(
      screen.getByText("At least one single agent or team agent must be added."),
    ).toBeInTheDocument();
  });

  it("removes only the selected single agent card", () => {
    render(<Harness selectedTemplate={TEMPLATE} orchestrationPattern="coordinate" />);
    const removeButtons = screen.getAllByRole("button", { name: "Remove card" });
    // First card is manager and has no remove; there should be one per member.
    expect(removeButtons).toHaveLength(2);

    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByRole("button", { name: "Remove card" })).toHaveLength(1);
  });

  it("shows termination controls in the manager section for coordinate orchestration", () => {
    render(<Harness selectedTemplate={TEMPLATE} orchestrationPattern="coordinate" />);

    expect(
      screen.getByRole("button", { name: /Termination strategy, maximum iterations/i }),
    ).toBeInTheDocument();
  });

  it("hides termination controls for non-coordinate orchestration", () => {
    render(<Harness selectedTemplate={TEMPLATE} orchestrationPattern="sequential" />);

    expect(
      screen.queryByRole("button", { name: /Termination strategy, maximum iterations/i }),
    ).not.toBeInTheDocument();
  });
});

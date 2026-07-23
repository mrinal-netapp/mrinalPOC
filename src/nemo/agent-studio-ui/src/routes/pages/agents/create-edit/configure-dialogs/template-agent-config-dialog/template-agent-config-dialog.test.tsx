import { useState, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTestForm } from "@test/render";

import type { AgentTemplateAgentDefinition } from "../../form/agent-templates.consts";
import {
  buildEmptyTemplateAgentInstance,
  type AgentTemplateAgentInstanceValues,
} from "../../form/agent-form.consts";
import type { TemplateAgentFieldErrors } from "../../form/template-agent.utils";
import { TemplateAgentConfigDialog } from "./template-agent-config-dialog";

vi.mock("@/ui-lib/base-components/dialog/dialog", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/ui-lib/base-components/dialog/dialog")
  >();

  return {
    ...actual,
    Dialog: ({
      children,
      onOpenChange,
      ...props
    }: React.ComponentProps<typeof actual.Dialog>) => (
      <actual.Dialog {...props} onOpenChange={onOpenChange}>
        <button
          type="button"
          aria-label="simulate dialog open"
          onClick={() => onOpenChange?.(true, undefined, undefined)}
        />
        {children}
      </actual.Dialog>
    ),
  };
});

const modelSectionSpy = vi.fn();

vi.mock("../../form/model-section", () => ({
  ModelSection: (props: {
    recommendedModel?: string;
    primaryModelError?: string;
  }) => {
    modelSectionSpy(props);
    return <div>model-section</div>;
  },
}));
vi.mock("../../form/profile-section", () => ({
  ProfileSection: () => <div>profile-section</div>,
}));
vi.mock("../../form/configuration-section", () => ({
  ConfigurationSection: () => <div>configuration-section</div>,
}));
vi.mock("../../form/template-agent-requirements-section", () => ({
  TemplateAgentRequirementsSection: () => <div>requirements-section</div>,
}));

vi.setConfig({ testTimeout: 60_000 });

const FIELD_PREFIX = "template.agentInstances[0]";

const AGENT_DEF: AgentTemplateAgentDefinition = {
  name: "Researcher",
  role: "assistant",
  systemPrompt: "Prompt",
  modelId: "model-a",
  requirements: {
    knowledgeBases: [],
    mcpServers: [],
  },
};

function Harness({
  open = true,
  initial,
  fieldPrefix = FIELD_PREFIX,
  hideResources = false,
  withSidePane = false,
  subtitle,
  recommendedModel,
  validationErrors,
  onClose = vi.fn(),
  onSave = vi.fn(),
  onReady,
}: {
  open?: boolean;
  initial?: AgentTemplateAgentInstanceValues;
  fieldPrefix?: string;
  hideResources?: boolean;
  withSidePane?: boolean;
  subtitle?: string;
  recommendedModel?: string;
  validationErrors?: TemplateAgentFieldErrors;
  onClose?: () => void;
  onSave?: () => void;
  onReady?: (form: ReturnType<typeof useTestForm>) => void;
}): ReactElement {
  const form = useTestForm({
    template: {
      agentInstances: [initial ?? buildEmptyTemplateAgentInstance()],
    },
  });
  const [, force] = useState(0);
  form.store.subscribe(() => force((v) => v + 1));
  onReady?.(form);

  return (
    <TemplateAgentConfigDialog
      open={open}
      form={form}
      fieldPrefix={fieldPrefix}
      agentDefinition={AGENT_DEF}
      hideResources={hideResources}
      withSidePane={withSidePane}
      subtitle={subtitle}
      recommendedModel={recommendedModel}
      validationErrors={validationErrors}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

function OpenOnDemandHarness({
  initial,
  onClose = vi.fn(),
  onReady,
}: {
  initial?: AgentTemplateAgentInstanceValues;
  onClose?: () => void;
  onReady?: (form: ReturnType<typeof useTestForm>) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Harness
        open={open}
        initial={initial}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        onReady={onReady}
      />
    </>
  );
}

describe("TemplateAgentConfigDialog", () => {
  it("uses the agent definition name when subtitle is omitted", () => {
    render(<Harness />);
    expect(screen.getByText("Researcher")).toBeInTheDocument();
    expect(screen.queryByText("Custom subtitle")).not.toBeInTheDocument();
  });

  it("forwards recommended model and validation errors to child sections", () => {
    modelSectionSpy.mockClear();
    const validationErrors: TemplateAgentFieldErrors = {
      primaryModel: "Pick a model",
      name: "Add a name",
      instructions: "Add instructions",
      knowledgeBases: "Attach a KB",
      toolsets: "Attach a toolset",
    };

    render(
      <Harness
        recommendedModel="model-b"
        validationErrors={validationErrors}
      />,
    );

    expect(modelSectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendedModel: "model-b",
        primaryModelError: "Pick a model",
      }),
    );
  });

  it("does not restore form values on cancel when no snapshot was captured", () => {
    const onClose = vi.fn();
    const initial = {
      ...buildEmptyTemplateAgentInstance(),
      name: "Original name",
    };
    let formApi: ReturnType<typeof useTestForm> | undefined;

    render(
      <Harness
        fieldPrefix="template.missingInstance"
        initial={initial}
        onClose={onClose}
        onReady={(form) => {
          formApi = form;
        }}
      />,
    );

    formApi?.setFieldValue(`${FIELD_PREFIX}.name`, "Changed name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(formApi?.state.values.template.agentInstances[0].name).toBe("Changed name");
  });

  it("captures a snapshot when the dialog opens from a closed state", () => {
    const onClose = vi.fn();
    const initial = {
      ...buildEmptyTemplateAgentInstance(),
      name: "Original name",
    };
    let formApi: ReturnType<typeof useTestForm> | undefined;

    render(
      <OpenOnDemandHarness
        initial={initial}
        onClose={onClose}
        onReady={(form) => {
          formApi = form;
        }}
      />,
    );

    expect(screen.queryByText("Configure agent")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(screen.getByText("Configure agent")).toBeInTheDocument();

    formApi?.setFieldValue(`${FIELD_PREFIX}.name`, "Changed name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(formApi?.state.values.template.agentInstances[0].name).toBe("Original name");
  });

  it("does not cancel changes when the dialog reports an open event", () => {
    const onClose = vi.fn();
    const initial = {
      ...buildEmptyTemplateAgentInstance(),
      name: "Original name",
    };
    let formApi: ReturnType<typeof useTestForm> | undefined;

    render(
      <Harness
        initial={initial}
        onClose={onClose}
        onReady={(form) => {
          formApi = form;
        }}
      />,
    );

    formApi?.setFieldValue(`${FIELD_PREFIX}.name`, "Changed name");
    fireEvent.click(
      screen.getByRole("button", { name: "simulate dialog open", hidden: true }),
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(formApi?.state.values.template.agentInstances[0].name).toBe("Changed name");
  });

  it("renders the dialog sections and hides requirements and configuration for the manager agent", () => {
    render(<Harness hideResources subtitle="Custom subtitle" />);

    expect(screen.getByText("Configure agent")).toBeInTheDocument();
    expect(screen.getByText("Custom subtitle")).toBeInTheDocument();
    expect(screen.getByText("model-section")).toBeInTheDocument();
    expect(screen.getByText("profile-section")).toBeInTheDocument();
    expect(screen.queryByText("configuration-section")).not.toBeInTheDocument();
    expect(screen.queryByText("requirements-section")).not.toBeInTheDocument();
  });

  it("shows the configuration section for member agents", () => {
    render(<Harness />);
    expect(screen.getByText("configuration-section")).toBeInTheDocument();
  });

  it("shows the requirements section for member agents", () => {
    render(<Harness />);
    expect(screen.getByText("requirements-section")).toBeInTheDocument();
  });

  it("restores the snapshot and closes when Cancel is clicked", () => {
    const onClose = vi.fn();
    const initial = {
      ...buildEmptyTemplateAgentInstance(),
      name: "Original name",
      instructions: "Original instructions",
    };
    let formApi: ReturnType<typeof useTestForm> | undefined;

    render(
      <Harness
        initial={initial}
        onClose={onClose}
        onReady={(form) => {
          formApi = form;
        }}
      />,
    );

    formApi?.setFieldValue(`${FIELD_PREFIX}.name`, "Changed name");
    expect(formApi?.state.values.template.agentInstances[0].name).toBe("Changed name");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(formApi?.state.values.template.agentInstances[0].name).toBe("Original name");
  });

  it("calls onSave and onClose when Save is clicked", () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(<Harness onClose={onClose} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies the side-pane layout class when withSidePane is set", () => {
    render(<Harness withSidePane />);
    expect(
      document.querySelector(".template-agent-config-dialog-popup--with-sidepane"),
    ).not.toBeNull();
  });

  it("omits the side-pane layout class when withSidePane is false", () => {
    render(<Harness />);
    expect(
      document.querySelector(".template-agent-config-dialog-popup--with-sidepane"),
    ).toBeNull();
  });

  it("restores the snapshot when the dialog is dismissed via Escape", () => {
    const onClose = vi.fn();
    const initial = {
      ...buildEmptyTemplateAgentInstance(),
      name: "Original name",
    };
    let formApi: ReturnType<typeof useTestForm> | undefined;

    render(
      <Harness
        initial={initial}
        onClose={onClose}
        onReady={(form) => {
          formApi = form;
        }}
      />,
    );

    formApi?.setFieldValue(`${FIELD_PREFIX}.name`, "Changed name");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(formApi?.state.values.template.agentInstances[0].name).toBe("Original name");
  });
});

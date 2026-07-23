import { useEffect, useState, type ReactElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types"

import type { AgentTemplateDefinition } from "./agent-templates.consts"
import { TemplateSection } from "./template-section"
import { TEMPLATE_SELECTION_STRINGS } from "../configure-dialogs/template-selection-dialog"

vi.setConfig({ testTimeout: 120_000 })

const TEMPLATES: AgentTemplateDefinition[] = [
  {
    id: "tmpl-a",
    name: "Template A",
    description: "First template description",
    capabilities: ["Knowledge bases", "Toolsets"],
    examples: [
      {
        title: "Example A",
        scenario: "First scenario",
        response: "First response",
      },
    ],
    instructions: "First template instructions",
    orchestrationPattern: "Sequential",
    model: "Claude Sonnet 4",
    role: "Template A manager",
    agents: [
      {
        name: "Template A agent",
        role: "assistant",
        systemPrompt: "You help with template A tasks.",
        modelId: "model-a",
        requirements: {
          knowledgeBases: [],
          mcpServers: [],
        },
      },
    ],
  },
  {
    id: "tmpl-b",
    name: "Template B",
    description: "Second template description",
    capabilities: ["Memory"],
    examples: [],
    instructions: "Second template instructions",
    orchestrationPattern: "Coordinate",
    model: "GPT-4.1",
    role: "Template B manager",
    agents: [
      {
        name: "Template B agent",
        role: "assistant",
        systemPrompt: "You help with template B tasks.",
        modelId: "model-b",
        requirements: {
          knowledgeBases: [],
          mcpServers: [],
        },
      },
    ],
  },
]

function Harness({
  initialTemplate = null,
  onChange,
  onFormReady,
  onOpenDetails = () => {},
}: {
  initialTemplate?: AgentTemplateDefinition | null
  onChange?: (selected: AgentTemplateDefinition | null) => void
  onFormReady?: (form: AnyReactFormApi) => void
  onOpenDetails?: (template: AgentTemplateDefinition, kind: "examples" | "instructions") => void
}): ReactElement {
  const form = useTestForm({
    template: {
      selectedTemplate: initialTemplate,
      agentInstances: [],
      managerInstance: null,
      orchestrationPattern: initialTemplate
        ? initialTemplate.orchestrationPattern.toLowerCase()
        : "",
    },
  })
  useEffect(() => {
    onFormReady?.(form)
  }, [form, onFormReady])
  const [, force] = useState(0)
  form.store.subscribe(() => {
    onChange?.(form.state.values.template.selectedTemplate)
    force((v) => v + 1)
  })
  return <TemplateSection form={form} templates={TEMPLATES} onOpenDetails={onOpenDetails} />
}

describe("TemplateSection", () => {
  it("[tag:template-section] renders the section title and a 'Select' button when nothing is picked", () => {
    render(<Harness />)

    expect(screen.getByText("Template")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Select" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Change template" }),
    ).not.toBeInTheDocument()
  })

  it("[tag:template-section] does NOT render the summary block when no template is picked", () => {
    const { container } = render(<Harness />)
    expect(
      container.querySelector(".agent-form__template-summary"),
    ).not.toBeInTheDocument()
  })

  it("[tag:template-section] clicking 'Select' opens the dialog with no row pre-selected", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: "Select" }))

    expect(
      screen.getByText(TEMPLATE_SELECTION_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    // Both radios are unchecked initially.
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every((r) => !r.checked)).toBe(true)
  })

  it("[tag:template-section] saving the dialog persists the selection into form values and renders the summary", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByRole("radio", { name: /Template A/ }))
    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    )

    // Summary is rendered with the selected template's data (Name +
    // Configuration = "Team").
    expect(screen.getByText("Template A")).toBeInTheDocument()
    expect(screen.getByText("Team")).toBeInTheDocument()

    // Button label flips to 'Change template'.
    expect(
      screen.getByRole("button", { name: "Change template" }),
    ).toBeInTheDocument()

    // Orchestration pattern dropdown is shown and seeded from the template.
    expect(screen.getByText("Orchestration pattern")).toBeInTheDocument()
    expect(screen.getByText("Sequential")).toBeInTheDocument()

    // Form state was updated.
    expect(onChange).toHaveBeenCalledWith(TEMPLATES[0])
  })

  it("[tag:template-section] cancelling discards the draft selection", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByRole("radio", { name: /Template A/ }))
    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.CLOSE_ACTION_LABEL,
      }),
    )

    expect(
      screen.queryByRole("button", { name: "Change template" }),
    ).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("[tag:template-section] reopening pre-selects the currently saved template id", () => {
    render(<Harness initialTemplate={TEMPLATES[1]} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Change template" }),
    )

    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    // Template B is at index 1 and should be pre-checked.
    expect(radios[0].checked).toBe(false)
    expect(radios[1].checked).toBe(true)
  })

  it("[tag:template-section] saving an unchanged selection is a safe no-op (Save still closes the dialog)", () => {
    const onChange = vi.fn()
    render(<Harness initialTemplate={TEMPLATES[0]} onChange={onChange} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Change template" }),
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    )

    // Dialog closed: title no longer in document.
    expect(
      screen.queryByText(TEMPLATE_SELECTION_STRINGS.DIALOG_TITLE),
    ).not.toBeInTheDocument()
    // Summary still shows Template A.
    expect(screen.getByText("Template A")).toBeInTheDocument()
  })

  it("[tag:template-section] saving a draft removed from the catalog is a no-op", () => {
    function StaleHarness({
      onTemplatesReady,
    }: {
      onTemplatesReady: (updateTemplates: (templates: AgentTemplateDefinition[]) => void) => void
    }): ReactElement {
      const [templates, setTemplates] = useState(TEMPLATES)
      const form = useTestForm({
        template: { selectedTemplate: null, agentInstances: [], orchestrationPattern: "" },
      })
      useEffect(() => {
        onTemplatesReady(setTemplates)
      }, [onTemplatesReady, setTemplates])
      return <TemplateSection form={form} templates={templates} onOpenDetails={() => {}} />
    }

    let updateTemplates!: (templates: AgentTemplateDefinition[]) => void
    render(<StaleHarness onTemplatesReady={(update) => (updateTemplates = update)} />)

    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByRole("radio", { name: /Template A/ }))
    act(() => updateTemplates([]))
    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    )

    expect(
      screen.queryByText(TEMPLATE_SELECTION_STRINGS.DIALOG_TITLE),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument()
  })

  it("[tag:template-section] shows the orchestration pattern in a separate Configuration section once a template is picked", () => {
    render(<Harness initialTemplate={TEMPLATES[0]} />)

    expect(screen.getByText("Orchestration pattern")).toBeInTheDocument()
    // Summary now shows only Name + Configuration ("Team"); no Examples/
    // Instructions "View" links live in the summary anymore.
    expect(screen.queryByText("View")).not.toBeInTheDocument()
  })

  it("[tag:template-section] keeps a Sequential template manager blank when changed to Coordinate", async () => {
    let form: AnyReactFormApi | undefined
    render(<Harness onFormReady={(api) => (form = api)} />)
    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByRole("radio", { name: /Template A/ }))
    fireEvent.click(
      screen.getByRole("button", { name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL }),
    )

    expect(form?.state.values.template.managerInstance).toMatchObject({
      primaryModel: "",
      name: "",
      instructions: "",
    })

    act(() => {
      form?.setFieldValue("template.managerInstance", {
        ...form?.state.values.template.managerInstance,
        primaryModel: "manual-model",
        name: "Manual-manager",
        instructions: "Manually supplied instructions",
      })
      form?.setFieldValue("template.orchestrationPattern", "coordinate")
    })

    await waitFor(() => {
      expect(form?.state.values.template.managerInstance).toMatchObject({
        primaryModel: "",
        name: "",
        instructions: "",
      })
    })
  })

  it("[tag:template-section] preserves a Coordinate template manager after switching away and back", async () => {
    let form: AnyReactFormApi | undefined
    render(<Harness onFormReady={(api) => (form = api)} />)
    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByRole("radio", { name: /Template B/ }))
    fireEvent.click(
      screen.getByRole("button", { name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL }),
    )

    const seededManager = form?.state.values.template.managerInstance
    expect(seededManager).toMatchObject({
      primaryModel: "",
      instructions: TEMPLATES[1].instructions,
    })
    expect(seededManager?.name).toBeTruthy()

    act(() => {
      form?.setFieldValue("template.orchestrationPattern", "sequential")
    })
    act(() => {
      form?.setFieldValue("template.orchestrationPattern", "coordinate")
    })

    await waitFor(() => {
      expect(form?.state.values.template.managerInstance).toEqual(seededManager)
    })
  })
})

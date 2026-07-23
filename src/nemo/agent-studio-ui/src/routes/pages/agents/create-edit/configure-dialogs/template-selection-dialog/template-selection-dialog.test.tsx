import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { AgentTemplateDefinition } from "../../form/agent-templates.consts"

import { TemplateSelectionDialog } from "./template-selection-dialog"
import { TEMPLATE_SELECTION_STRINGS } from "./template-selection-dialog.consts"

// Base UI's Dialog uses portals + tooltip primitives that pay a one-off
// jsdom mount cost on the first OPEN render of the file. The default 5s
// is fine on warm runs but flaky on cold ones — bump to keep CI stable.
vi.setConfig({ testTimeout: 120_000 })

const FIXTURES: AgentTemplateDefinition[] = [
  {
    id: "tmpl-a",
    name: "Template A",
    description: "First template description",
    capabilities: ["Knowledge bases"],
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
    capabilities: ["Toolsets"],
    examples: [],
    instructions: "Second template instructions",
    orchestrationPattern: "Route",
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

const handlers = () => ({
  onClose: vi.fn() as () => void,
  onSelectionChange: vi.fn() as (id: string) => void,
  onOpenDetails: vi.fn() as (template: AgentTemplateDefinition, kind: "examples" | "instructions") => void,
  onSave: vi.fn() as () => void,
})

function renderDialog(
  selectedTemplateId: string | null,
  templates: AgentTemplateDefinition[] = FIXTURES,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <TemplateSelectionDialog
      open
      templates={templates}
      selectedTemplateId={selectedTemplateId}
      {...h}
    />,
  )
  return { ...result, ...h }
}

describe("TemplateSelectionDialog", () => {
  it("[tag:template-selection-dialog] renders nothing when closed", () => {
    const { container } = render(
      <TemplateSelectionDialog
        open={false}
        templates={FIXTURES}
        selectedTemplateId={null}
        onClose={vi.fn()}
        onSelectionChange={vi.fn()}
        onOpenDetails={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(
      container.querySelector(".template-selection-dialog"),
    ).not.toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] renders title, description, and templates count", () => {
    renderDialog(null)

    expect(
      screen.getByText(TEMPLATE_SELECTION_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    expect(
      screen.getByText(TEMPLATE_SELECTION_STRINGS.DIALOG_DESCRIPTION),
    ).toBeInTheDocument()
    expect(screen.getByText("Templates (2)")).toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] hides templates flagged hidden and excludes them from the count", () => {
    const templatesWithHidden: AgentTemplateDefinition[] = [
      ...FIXTURES,
      { ...FIXTURES[0], id: "tmpl-hidden", name: "Hidden Template", hidden: true },
    ]
    renderDialog(null, templatesWithHidden)

    expect(screen.queryByText("Hidden Template")).not.toBeInTheDocument()
    expect(screen.getByText("Template A")).toBeInTheDocument()
    expect(screen.getByText("Template B")).toBeInTheDocument()
    expect(screen.getByText("Templates (2)")).toBeInTheDocument()
    expect(screen.getByText("1 - 2 of 2")).toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] renders all column headers", () => {
    renderDialog(null)

    expect(
      screen.getByText(TEMPLATE_SELECTION_STRINGS.COLUMN_NAME),
    ).toBeInTheDocument()
    expect(
      screen.getByText(TEMPLATE_SELECTION_STRINGS.COLUMN_DESCRIPTION),
    ).toBeInTheDocument()
    expect(
      screen.getByText(TEMPLATE_SELECTION_STRINGS.COLUMN_CAPABILITIES),
    ).toBeInTheDocument()
    expect(
      screen.getAllByText(TEMPLATE_SELECTION_STRINGS.COLUMN_EXAMPLES).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByText(TEMPLATE_SELECTION_STRINGS.COLUMN_INSTRUCTIONS).length,
    ).toBeGreaterThan(0)
  })

  it("[tag:template-selection-dialog] renders one row per template with name, description, capabilities", () => {
    renderDialog(null)

    expect(screen.getByText("Template A")).toBeInTheDocument()
    expect(screen.getByText("First template description")).toBeInTheDocument()
    expect(screen.getByText("Knowledge bases")).toBeInTheDocument()
    expect(screen.getByText("Template B")).toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] clicking a row emits onSelectionChange with that row's id", () => {
    const { onSelectionChange } = renderDialog(null)

    // Click anywhere in the row body (the description cell) and expect the
    // <tr>'s onClick to fire. fireEvent is enough — we don't need full
    // pointer-event simulation for click-target verification.
    fireEvent.click(screen.getByText("Second template description"))

    expect(onSelectionChange).toHaveBeenCalledWith("tmpl-b")
  })

  it("[tag:template-selection-dialog] clicking the radio fires onSelectionChange", () => {
    const { onSelectionChange } = renderDialog(null)

    fireEvent.click(screen.getByRole("radio", { name: /Template A/ }))

    expect(onSelectionChange).toHaveBeenCalledWith("tmpl-a")
  })

  it("[tag:template-selection-dialog] clicking details buttons does NOT trigger row selection", () => {
    const { onSelectionChange } = renderDialog(null)

    const exampleButtons = screen.getAllByRole("button", {
      name: TEMPLATE_SELECTION_STRINGS.EXAMPLES_VIEW_LABEL,
    })
    fireEvent.click(exampleButtons[0])

    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it("[tag:template-selection-dialog] clicking details forwards payload to parent callback", () => {
    const { onOpenDetails } = renderDialog(null)
    const row = screen.getByText("Template A").closest("tr")
    if (!row) throw new Error("Template A row not found")
    const rowViewButtons = within(row).getAllByRole("button", {
      name: TEMPLATE_SELECTION_STRINGS.INSTRUCTIONS_VIEW_LABEL,
    })
    fireEvent.click(rowViewButtons[1])
    expect(onOpenDetails).toHaveBeenCalledWith(FIXTURES[0], "instructions")
  })

  it("[tag:template-selection-dialog] reflects selectedTemplateId in the radio state", () => {
    renderDialog("tmpl-b")

    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios[0].checked).toBe(false)
    expect(radios[1].checked).toBe(true)
  })

  it("[tag:template-selection-dialog] Select button is disabled when nothing is selected", () => {
    renderDialog(null)

    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    ).toBeDisabled()
  })

  it("[tag:template-selection-dialog] Select button is enabled when a template is picked", () => {
    renderDialog("tmpl-a")

    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    ).not.toBeDisabled()
  })

  it("[tag:template-selection-dialog] Select with no selection does not fire onSave", () => {
    const { onSave } = renderDialog(null)

    // The button is disabled — but the handler is also internally guarded.
    // fireEvent bypasses pointer-events:none from the disabled CSS to
    // exercise the guard path.
    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    )

    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:template-selection-dialog] Select with a selection fires onSave once", () => {
    const { onSave } = renderDialog("tmpl-a")

    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
      }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:template-selection-dialog] Close button calls onClose", () => {
    const { onClose } = renderDialog("tmpl-a")

    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.CLOSE_ACTION_LABEL,
      }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:template-selection-dialog] ESC closes the dialog via onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderDialog("tmpl-a")

    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:template-selection-dialog] search filters visible template rows", async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog(null)

    await user.click(
      screen.getByRole("button", { name: TEMPLATE_SELECTION_STRINGS.SEARCH_ARIA_LABEL }),
    )

    const searchInput = screen.getByRole("textbox", {
      name: TEMPLATE_SELECTION_STRINGS.SEARCH_ARIA_LABEL,
    })
    await user.type(searchInput, "Second")

    expect(screen.queryByText("Template A")).not.toBeInTheDocument()
    expect(screen.getByText("Template B")).toBeInTheDocument()
    expect(screen.getByText("1 - 1 of 1")).toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] clicking a sortable header reorders rows", () => {
    renderDialog(null)

    const nameSortButton = screen.getByRole("button", {
      name: `${TEMPLATE_SELECTION_STRINGS.COLUMN_NAME}, ${TEMPLATE_SELECTION_STRINGS.SORT_ARIA_LABEL}`,
    })
    fireEvent.click(nameSortButton)
    fireEvent.click(nameSortButton)

    const rows = screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))
    expect(rows[0]).toContain("Template B")
    expect(rows[1]).toContain("Template A")
  })

  it("[tag:template-selection-dialog] search and pagination controls render with accessible labels", () => {
    renderDialog(null)

    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.SEARCH_ARIA_LABEL,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.PAGE_FIRST_ARIA_LABEL,
      }),
    ).toBeDisabled()
    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.PAGE_PREV_ARIA_LABEL,
      }),
    ).toBeDisabled()
    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.PAGE_NEXT_ARIA_LABEL,
      }),
    ).toBeDisabled()
    expect(
      screen.getByRole("button", {
        name: TEMPLATE_SELECTION_STRINGS.PAGE_LAST_ARIA_LABEL,
      }),
    ).toBeDisabled()
  })

  it("[tag:template-selection-dialog] pagination range reads '1 - N of N' for non-empty catalogs", () => {
    renderDialog(null)
    expect(screen.getByText("1 - 2 of 2")).toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] pagination range reads '0 - 0 of 0' when catalog is empty", () => {
    renderDialog(null, [])
    expect(screen.getByText("0 - 0 of 0")).toBeInTheDocument()
    expect(screen.getByText("Templates (0)")).toBeInTheDocument()
    expect(screen.getByText(TEMPLATE_SELECTION_STRINGS.EMPTY_CATALOG_MESSAGE)).toBeInTheDocument()
  })

  it("[tag:template-selection-dialog] details callback still fires when examples are empty", () => {
    const { onOpenDetails } = renderDialog(null)
    const row = screen.getByText("Template B").closest("tr")
    if (!row) throw new Error("Template B row not found")
    const rowViewButtons = within(row).getAllByRole("button", {
      name: TEMPLATE_SELECTION_STRINGS.EXAMPLES_VIEW_LABEL,
    })
    fireEvent.click(rowViewButtons[0])
    expect(onOpenDetails).toHaveBeenCalledWith(FIXTURES[1], "examples")
  })
})

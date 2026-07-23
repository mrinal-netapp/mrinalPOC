import { useState, type ReactElement } from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SaveAgentDialog } from "./save-agent-dialog"
import {
  DEFAULT_SAVE_AGENT_VALUES,
  SAVE_AGENT_DIALOG_STRINGS,
  type SaveAgentMode,
  type SaveAgentValues,
} from "./save-agent-dialog.consts"

vi.setConfig({ testTimeout: 120_000 })

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

const handlers = () => ({
  onClose: vi.fn() as () => void,
  onSubmit: vi.fn() as (
    values: SaveAgentValues,
    mode: SaveAgentMode,
  ) => void | Promise<void>,
})

function renderDialog(
  mode: SaveAgentMode = "draft",
  initialValues: SaveAgentValues = DEFAULT_SAVE_AGENT_VALUES,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <SaveAgentDialog
      open
      mode={mode}
      initialValues={initialValues}
      {...h}
    />,
  )
  return { ...result, ...h }
}

const getNameInput = (): HTMLInputElement =>
  screen.getByLabelText(SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL) as HTMLInputElement

const getDescriptionInput = (): HTMLInputElement =>
  screen.getByLabelText(
    SAVE_AGENT_DIALOG_STRINGS.DESCRIPTION_LABEL,
  ) as HTMLInputElement

const getLabelsTrigger = (): HTMLElement => {
  const dialog = document.querySelector(".save-agent-dialog")
  const trigger = dialog?.querySelector('[data-slot="select-dropdown-trigger"]')
  if (!trigger) throw new Error("Labels dropdown trigger not found")
  return trigger as HTMLElement
}

const getLabelsField = (): HTMLElement => {
  const field = getLabelsTrigger().closest(".select-dropdown-wrapper")
  if (!field) throw new Error("Labels dropdown wrapper not found")
  return field as HTMLElement
}

async function addLabelViaDropdown(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(getLabelsTrigger())

  const searchInput = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(".select-dropdown-searchbar__input")
    if (!el) throw new Error("Labels search input not found")
    return el
  })

  await user.type(searchInput, label)
  await user.click(await screen.findByRole("button", { name: "Add new item" }))
}

describe("SaveAgentDialog", () => {
  it("[tag:save-agent-dialog] renders nothing when closed", () => {
    const { container } = render(
      <SaveAgentDialog
        open={false}
        mode="draft"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(container.querySelector(".save-agent-dialog")).not.toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] draft mode renders draft-specific title and primary label", () => {
    renderDialog("draft")

    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    ).toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] deploy mode renders deploy-specific title, primary label, and stripe modifier", () => {
    renderDialog("deploy")

    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.TITLE_DEPLOY),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DEPLOY,
      }),
    ).toBeInTheDocument()
    expect(
      document.querySelector(".save-agent-dialog--deploy"),
    ).not.toBeNull()
  })

  it("[tag:save-agent-dialog] always renders shared description and the three labelled fields", () => {
    renderDialog()
    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.DESCRIPTION),
    ).toBeInTheDocument()
    expect(getNameInput()).toBeInTheDocument()
    expect(getDescriptionInput()).toBeInTheDocument()
    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.LABELS_LABEL),
    ).toBeInTheDocument()
    expect(getLabelsTrigger()).toBeInTheDocument()
    expect(
      document.querySelector(".select-dropdown-header-tooltip-icon"),
    ).toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] typing in Name updates the visible draft value", () => {
    renderDialog()

    fireEvent.change(getNameInput(), { target: { value: "my-agent" } })

    expect(getNameInput()).toHaveValue("my-agent")
  })

  it("[tag:save-agent-dialog] typing in Description updates the visible draft value", () => {
    renderDialog()

    fireEvent.change(getDescriptionInput(), {
      target: { value: "fast retrieval" },
    })

    expect(getDescriptionInput()).toHaveValue("fast retrieval")
  })

  it("[tag:save-agent-dialog] adds a label via the labels dropdown", async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog()

    await addLabelViaDropdown(user, "Staging")

    expect(screen.getByRole("button", { name: "Remove Staging" })).toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] deduplicates labels when adding the same value twice", async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog("draft", { ...DEFAULT_SAVE_AGENT_VALUES, labels: ["NFS"] })

    await user.click(getLabelsTrigger())

    const searchInput = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(".select-dropdown-searchbar__input")
      if (!el) throw new Error("Labels search input not found")
      return el
    })
    await user.type(searchInput, "NFS")

    const addBtn = screen.queryByRole("button", { name: "Add new item" })
    if (addBtn) {
      expect(addBtn).toBeDisabled()
    }

    expect(screen.getAllByRole("button", { name: "Remove NFS" })).toHaveLength(1)
  })

  it("[tag:save-agent-dialog] clicking a chip's remove button drops only that chip", () => {
    renderDialog("draft", {
      ...DEFAULT_SAVE_AGENT_VALUES,
      labels: ["Staging", "NFS"],
    })

    fireEvent.click(screen.getByRole("button", { name: "Remove Staging" }))

    expect(screen.queryByRole("button", { name: "Remove Staging" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove NFS" })).toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] clear selection wipes every chip in one click", async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog("draft", {
      ...DEFAULT_SAVE_AGENT_VALUES,
      labels: ["Staging", "NFS"],
    })

    await user.click(within(getLabelsField()).getByRole("button", { name: "Clear selection" }))

    expect(screen.queryByRole("button", { name: "Remove Staging" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove NFS" })).not.toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] Save with empty name shows error and does NOT call onSubmit", () => {
    const { onSubmit } = renderDialog("draft")

    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.NAME_REQUIRED_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] Save with whitespace-only name is treated as empty", () => {
    const { onSubmit } = renderDialog("draft")

    fireEvent.change(getNameInput(), { target: { value: "   " } })
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.NAME_REQUIRED_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:save-agent-dialog] Save passes trimmed values + mode to onSubmit", () => {
    const onSubmit = vi.fn()
    renderDialog(
      "deploy",
      {
        name: "  agent-1  ",
        description: "a desc",
        labels: ["Staging"],
      },
      { onSubmit },
    )

    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DEPLOY,
      }),
    )

    expect(onSubmit).toHaveBeenCalledWith(
      {
        name: "agent-1",
        description: "a desc",
        labels: ["Staging"],
      },
      "deploy",
    )
  })

  it("[tag:save-agent-dialog] Cancel calls onClose without submitting", () => {
    const { onClose, onSubmit } = renderDialog("draft", {
      ...DEFAULT_SAVE_AGENT_VALUES,
      name: "valid",
    })

    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.CANCEL_ACTION,
      }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("[tag:save-agent-dialog] draft mode warns but still submits unresolved dependencies", () => {
    const onSubmit = vi.fn()
    render(
      <SaveAgentDialog
        open
        mode="draft"
        initialValues={{ name: "agent-a", description: "", labels: [] }}
        unresolvedDependencies={[
          { type: "Knowledge base", label: "capacity_planning_kb" },
          { type: "Toolset", label: "Approval workflow API" },
        ]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )

    expect(
      screen.getByText(SAVE_AGENT_DIALOG_STRINGS.UNRESOLVED_DRAFT_WARNING_INTRO),
    ).toBeInTheDocument()
    expect(screen.getByText("Knowledge base: capacity_planning_kb")).toBeInTheDocument()
    expect(screen.getByText("Toolset: Approval workflow API")).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT,
      }),
    )

    expect(onSubmit).toHaveBeenCalledWith(
      { name: "agent-a", description: "", labels: [] },
      "draft",
    )
  })

  it("[tag:save-agent-dialog] deploy mode does not render unresolved warning or acknowledgement", () => {
    const onSubmit = vi.fn()
    render(
      <SaveAgentDialog
        open
        mode="deploy"
        initialValues={{ name: "agent-a", description: "", labels: [] }}
        unresolvedDependencies={[
          { type: "Knowledge base", label: "Required KB placeholder" },
        ]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )

    expect(
      screen.queryByText(SAVE_AGENT_DIALOG_STRINGS.UNRESOLVED_DRAFT_WARNING_INTRO),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Knowledge base: Required KB placeholder")).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DEPLOY,
      }),
    )

    expect(onSubmit).toHaveBeenCalledWith(
      { name: "agent-a", description: "", labels: [] },
      "deploy",
    )
  })

  it("[tag:save-agent-dialog] renders unresolved dependency warning after the labels field", () => {
    render(
      <SaveAgentDialog
        open
        mode="draft"
        initialValues={{ name: "agent-a", description: "", labels: [] }}
        unresolvedDependencies={[
          { type: "Knowledge base", label: "Required KB placeholder" },
        ]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    const labelsField = getLabelsField()
    const warning = screen
      .getByText(SAVE_AGENT_DIALOG_STRINGS.UNRESOLVED_DRAFT_WARNING_INTRO)
      .closest(".save-agent-dialog__unresolved-warning")

    expect(labelsField).not.toBeNull()
    expect(warning).not.toBeNull()
    expect(
      labelsField!.compareDocumentPosition(warning!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("[tag:save-agent-dialog] ESC calls onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderDialog("draft")

    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:save-agent-dialog] re-opens re-seed the draft from the parent's latest initialValues", () => {
    function Harness(): ReactElement {
      const [open, setOpen] = useState(true)
      const [identity, setIdentity] = useState<SaveAgentValues>({
        name: "first",
        description: "",
        labels: [],
      })
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setIdentity({ name: "second", description: "", labels: [] })
              setOpen(true)
            }}
          >
            reopen-with-second
          </button>
          <SaveAgentDialog
            key={open ? identity.name : "closed"}
            open={open}
            mode="draft"
            initialValues={identity}
            onClose={() => setOpen(false)}
            onSubmit={vi.fn()}
          />
        </>
      )
    }

    render(<Harness />)

    expect(getNameInput()).toHaveValue("first")

    fireEvent.change(getNameInput(), { target: { value: "stray-edit" } })
    fireEvent.click(
      screen.getByRole("button", {
        name: SAVE_AGENT_DIALOG_STRINGS.CANCEL_ACTION,
      }),
    )
    fireEvent.click(screen.getByText("reopen-with-second"))

    expect(getNameInput()).toHaveValue("second")
  })
})

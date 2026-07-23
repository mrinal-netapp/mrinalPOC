import React, { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

// Stub SelectDropdown: a labelled button that cycles through items on click.
// Avoids dragging @base-ui/react popover positioning into jsdom.
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
    const currentIndex = items.findIndex((i) => i.value === value)
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

import {
  DEFAULT_TOOLSET_CONFIG,
  TOOLSET_CONFIG_STRINGS,
} from "./configure-dialogs.consts"
import type { ToolsetConfig, ToolsetOption } from "./configure-dialogs.types"
import { ToolsetConfigDialog } from "./toolset-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: ToolsetConfig,
  toolsets: ToolsetOption[] = FIXTURE,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <ToolsetConfigDialog open draft={draft} toolsets={toolsets} {...h} />,
  )
  return { ...result, ...h }
}

const FIXTURE: ToolsetOption[] = [
  {
    id: "ts-1",
    name: "Toolset One",
    status: "healthy",
    labels: ["Staging", "Sales"],
    tools: [
      { id: "create_issue", name: "create_issue", description: "Create issue" },
      { id: "update_issue", name: "update_issue", description: "Update issue" },
      { id: "delete_issue", name: "delete_issue", description: "Delete issue" },
    ],
  },
  {
    id: "ts-2",
    name: "Toolset Two",
    status: "degraded",
    labels: ["Production"],
    tools: [
      { id: "send_message", name: "send_message", description: "Send a message" },
    ],
  },
]

describe("ToolsetConfigDialog", () => {
  it("[tag:toolset-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <ToolsetConfigDialog
        open={false}
        draft={DEFAULT_TOOLSET_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(container.querySelector(".toolset-config-dialog")).not.toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] renders title, section headings, and Toolset dropdown", () => {
    renderDialog(DEFAULT_TOOLSET_CONFIG)

    expect(screen.getByText(TOOLSET_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(TOOLSET_CONFIG_STRINGS.TOOLSET_SECTION_TITLE)).toBeInTheDocument()
    expect(screen.getByText(TOOLSET_CONFIG_STRINGS.TOOLS_SECTION_TITLE)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Toolset" })).toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] shows 'Select a toolset' guidance until one is picked", () => {
    renderDialog(DEFAULT_TOOLSET_CONFIG)

    expect(
      screen.getByText(TOOLSET_CONFIG_STRINGS.SELECT_TOOLSET_FIRST_MESSAGE),
    ).toBeInTheDocument()
    expect(screen.queryByRole("grid")).not.toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] renders Status, Labels, selection banner, and table once a toolset is picked", () => {
    renderDialog(
      { toolsetId: "ts-1", selectedToolIds: ["create_issue", "update_issue"] },
      FIXTURE,
    )

    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("Staging, Sales")).toBeInTheDocument()
    expect(screen.getByText("2 out of 3 tools are selected.")).toBeInTheDocument()
    expect(screen.getByText("Tools (3)")).toBeInTheDocument()
    expect(screen.getByText("create_issue")).toBeInTheDocument()
    expect(screen.getByText("update_issue")).toBeInTheDocument()
    expect(screen.getByText("delete_issue")).toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] tool checkboxes reflect the controlled selection state", () => {
    renderDialog({ toolsetId: "ts-1", selectedToolIds: ["create_issue"] }, FIXTURE)

    expect(screen.getByRole("checkbox", { name: "Select tool create_issue" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Select tool update_issue" })).not.toBeChecked()
  })

  it("[tag:toolset-config-dialog] selecting a different toolset clears prior tool selections", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog(
      { toolsetId: "ts-1", selectedToolIds: ["create_issue", "update_issue"] },
      FIXTURE,
      { onDraftChange },
    )

    await user.click(screen.getByRole("button", { name: "Toolset" }))

    expect(onDraftChange).toHaveBeenCalledWith({
      toolsetId: "ts-2",
      selectedToolIds: [],
    })
  })

  it("[tag:toolset-config-dialog] toggling a row checkbox lifts the new id up via onDraftChange", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog(
      { toolsetId: "ts-1", selectedToolIds: ["create_issue"] },
      FIXTURE,
      { onDraftChange },
    )

    await user.click(screen.getByRole("checkbox", { name: "Select tool update_issue" }))

    expect(onDraftChange).toHaveBeenLastCalledWith({
      selectedToolIds: ["create_issue", "update_issue"],
    })
  })

  it("[tag:toolset-config-dialog] header checkbox bulk-selects every visible tool", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog(
      { toolsetId: "ts-1", selectedToolIds: [] },
      FIXTURE,
      { onDraftChange },
    )

    await user.click(screen.getByRole("checkbox", { name: "Select all tools" }))

    expect(onDraftChange).toHaveBeenLastCalledWith({
      selectedToolIds: ["create_issue", "update_issue", "delete_issue"],
    })
  })

  it("[tag:toolset-config-dialog] blocks Save when no toolset has been chosen", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(DEFAULT_TOOLSET_CONFIG, FIXTURE, { onSave })

    await user.click(screen.getByRole("button", { name: TOOLSET_CONFIG_STRINGS.SAVE_ACTION_LABEL }))

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(TOOLSET_CONFIG_STRINGS.TOOLSET_REQUIRED_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] blocks Save when a toolset is picked but no tools are selected", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(
      { toolsetId: "ts-1", selectedToolIds: [] },
      FIXTURE,
      { onSave },
    )

    await user.click(screen.getByRole("button", { name: TOOLSET_CONFIG_STRINGS.SAVE_ACTION_LABEL }))

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(TOOLSET_CONFIG_STRINGS.NO_TOOLS_SELECTED_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] fires onSave when toolset and at least one tool are selected", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(
      { toolsetId: "ts-1", selectedToolIds: ["create_issue"] },
      FIXTURE,
      { onSave },
    )

    await user.click(screen.getByRole("button", { name: TOOLSET_CONFIG_STRINGS.SAVE_ACTION_LABEL }))

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:toolset-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()

    renderDialog(DEFAULT_TOOLSET_CONFIG, FIXTURE, { onClose })

    await user.click(screen.getByRole("button", { name: TOOLSET_CONFIG_STRINGS.CANCEL_ACTION_LABEL }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:toolset-config-dialog] sorting by Name toggles ascending then descending", async () => {
    const user = userEvent.setup({ delay: null })

    renderDialog({ toolsetId: "ts-1", selectedToolIds: [] }, FIXTURE)

    const nameHeader = screen.getByRole("button", {
      name: TOOLSET_CONFIG_STRINGS.TOOLS_COLUMN_NAME,
    })

    await user.click(nameHeader)
    const ascRows = within(screen.getByRole("grid"))
      .getAllByRole("checkbox", { name: /^Select tool/i })
      .map((cb) => cb.getAttribute("aria-label"))
    expect(ascRows).toEqual([
      "Select tool create_issue",
      "Select tool delete_issue",
      "Select tool update_issue",
    ])

    await user.click(nameHeader)
    const descRows = within(screen.getByRole("grid"))
      .getAllByRole("checkbox", { name: /^Select tool/i })
      .map((cb) => cb.getAttribute("aria-label"))
    expect(descRows).toEqual([
      "Select tool update_issue",
      "Select tool delete_issue",
      "Select tool create_issue",
    ])
  })

  it("[tag:toolset-config-dialog] search filters the visible tool rows", async () => {
    const user = userEvent.setup({ delay: null })

    renderDialog({ toolsetId: "ts-1", selectedToolIds: [] }, FIXTURE)

    await user.click(
      screen.getByRole("button", { name: TOOLSET_CONFIG_STRINGS.TOOLS_SEARCH_ARIA_LABEL }),
    )
    const searchInput = screen.getByLabelText(TOOLSET_CONFIG_STRINGS.TOOLS_SEARCH_ARIA_LABEL)
    await user.type(searchInput, "update")

    expect(screen.getByText("update_issue")).toBeInTheDocument()
    expect(screen.queryByText("create_issue")).not.toBeInTheDocument()
    expect(screen.queryByText("delete_issue")).not.toBeInTheDocument()
  })

  it("[tag:toolset-config-dialog] state-managed integration: checking a row updates banner + checked state", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<ToolsetConfig>({
        toolsetId: "ts-1",
        selectedToolIds: [],
      })
      return (
        <ToolsetConfigDialog
          open
          draft={draft}
          toolsets={FIXTURE}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)

    expect(screen.getByText("0 out of 3 tools are selected.")).toBeInTheDocument()

    await user.click(screen.getByRole("checkbox", { name: "Select tool create_issue" }))

    expect(screen.getByText("1 out of 3 tools are selected.")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Select tool create_issue" })).toBeChecked()
  })
})

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  GOAL_MAX_LENGTH,
  INSTRUCTIONS_MAX_LENGTH,
} from "../../form/agent-form.consts"

import { AgentProfileConfigDialog } from "./agent-profile-config-dialog"
import {
  AGENT_PROFILE_CONFIG_STRINGS,
  DEFAULT_AGENT_PROFILE_DRAFT,
  type AgentProfileDraft,
} from "./agent-profile-config-dialog.consts"

vi.setConfig({ testTimeout: 120_000 })

const handlers = () => ({
  onClose: vi.fn() as () => void,
  onDraftChange: vi.fn() as (next: Partial<AgentProfileDraft>) => void,
  onSave: vi.fn() as () => void,
})

function renderDialog(
  draft: AgentProfileDraft = DEFAULT_AGENT_PROFILE_DRAFT,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <AgentProfileConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

const getGoalTextarea = (): HTMLTextAreaElement => {
  // The dialog has two textareas. The first one (Goal) follows the Goal
  // label in DOM order. Pull both and pick by their max-length attribute.
  const all = screen.getAllByRole("textbox") as HTMLTextAreaElement[]
  const goal = all.find(
    (t) => t.maxLength === GOAL_MAX_LENGTH,
  )
  if (!goal) throw new Error("Goal textarea not found in test DOM.")
  return goal
}

const getInstructionsTextarea = (): HTMLTextAreaElement => {
  const all = screen.getAllByRole("textbox") as HTMLTextAreaElement[]
  const instr = all.find(
    (t) => t.maxLength === INSTRUCTIONS_MAX_LENGTH,
  )
  if (!instr) throw new Error("Instructions textarea not found in test DOM.")
  return instr
}

describe("AgentProfileConfigDialog", () => {
  it("[tag:agent-profile-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <AgentProfileConfigDialog
        open={false}
        draft={DEFAULT_AGENT_PROFILE_DRAFT}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(
      container.querySelector(".agent-profile-config-dialog"),
    ).not.toBeInTheDocument()
  })

  it("[tag:agent-profile-config-dialog] renders title, section heading, description, and both fields", () => {
    renderDialog()

    expect(
      screen.getByText(AGENT_PROFILE_CONFIG_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    expect(
      screen.getByText(AGENT_PROFILE_CONFIG_STRINGS.SECTION_TITLE),
    ).toBeInTheDocument()
    expect(
      screen.getByText(AGENT_PROFILE_CONFIG_STRINGS.SECTION_DESCRIPTION),
    ).toBeInTheDocument()
    expect(
      screen.getByText(AGENT_PROFILE_CONFIG_STRINGS.GOAL_LABEL),
    ).toBeInTheDocument()
    expect(
      screen.getByText(AGENT_PROFILE_CONFIG_STRINGS.INSTRUCTIONS_LABEL),
    ).toBeInTheDocument()
  })

  it("[tag:agent-profile-config-dialog] renders both counters seeded from the draft length", () => {
    renderDialog({ goal: "abc", instructions: "abcdefghij" })
    expect(screen.getByText(`3/${GOAL_MAX_LENGTH}`)).toBeInTheDocument()
    expect(
      screen.getByText(`10/${INSTRUCTIONS_MAX_LENGTH}`),
    ).toBeInTheDocument()
  })

  it("[tag:agent-profile-config-dialog] respects the maxLength attribute on each textarea", () => {
    renderDialog()
    expect(getGoalTextarea()).toHaveAttribute("maxlength", String(GOAL_MAX_LENGTH))
    expect(getInstructionsTextarea()).toHaveAttribute(
      "maxlength",
      String(INSTRUCTIONS_MAX_LENGTH),
    )
  })

  it("[tag:agent-profile-config-dialog] typing in Goal lifts the new value via onDraftChange", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_AGENT_PROFILE_DRAFT, { onDraftChange })

    fireEvent.change(getGoalTextarea(), { target: { value: "be helpful" } })

    expect(onDraftChange).toHaveBeenCalledWith({ goal: "be helpful" })
  })

  it("[tag:agent-profile-config-dialog] typing in Instructions lifts the new value via onDraftChange", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_AGENT_PROFILE_DRAFT, { onDraftChange })

    fireEvent.change(getInstructionsTextarea(), {
      target: { value: "always cite sources" },
    })

    expect(onDraftChange).toHaveBeenCalledWith({
      instructions: "always cite sources",
    })
  })

  it("[tag:agent-profile-config-dialog] Save fires onSave once", () => {
    const { onSave } = renderDialog()

    fireEvent.click(
      screen.getByRole("button", {
        name: AGENT_PROFILE_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:agent-profile-config-dialog] Cancel fires onClose without onSave", () => {
    const { onClose, onSave } = renderDialog()

    fireEvent.click(
      screen.getByRole("button", {
        name: AGENT_PROFILE_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
      }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:agent-profile-config-dialog] ESC fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const { onClose } = renderDialog()

    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalled()
  })
})

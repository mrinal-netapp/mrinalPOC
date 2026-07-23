import { useState, type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useTestForm } from "@test/render"

import { ProfileSection } from "./profile-section"
import { AGENT_PROFILE_CONFIG_STRINGS } from "../configure-dialogs/agent-profile-config-dialog"

vi.setConfig({ testTimeout: 120_000 })

type ProfileValues = { goal: string; instructions: string }

function Harness({
  initial,
  onChange,
}: {
  initial?: Partial<ProfileValues>
  onChange?: (values: ProfileValues) => void
}): ReactElement {
  const form = useTestForm({
    goal: "",
    instructions: "",
    ...initial,
  })
  // Surface form values to assertions without coupling tests to internals.
  const [, force] = useState(0)
  form.store.subscribe(() => {
    onChange?.(form.state.values as ProfileValues)
    force((v) => v + 1)
  })
  return <ProfileSection form={form} />
}

describe("ProfileSection", () => {
  it("[tag:profile-section] renders the section header with title and description", () => {
    render(<Harness />)

    expect(screen.getByText("Profile")).toBeInTheDocument()
    expect(
      screen.getByText("Define the agent's goal and instructions."),
    ).toBeInTheDocument()
  })

  it("[tag:profile-section] shows 'Not configured' when both goal and instructions are empty", () => {
    render(<Harness />)

    expect(screen.getByText("Status")).toBeInTheDocument()
    expect(screen.getByText("Not configured")).toBeInTheDocument()
    expect(screen.queryByText("Goal")).not.toBeInTheDocument()
    expect(screen.queryByText("Instructions")).not.toBeInTheDocument()
  })

  it("[tag:profile-section] treats whitespace-only fields as 'Not configured'", () => {
    render(<Harness initial={{ goal: "   ", instructions: "\t\n" }} />)

    expect(screen.getByText("Not configured")).toBeInTheDocument()
  })

  it("[tag:profile-section] shows configured values when goal is filled", () => {
    render(<Harness initial={{ goal: "be helpful" }} />)

    expect(screen.getByText("Goal")).toBeInTheDocument()
    expect(screen.getByText("be helpful")).toBeInTheDocument()
    expect(screen.getByText("Instructions")).toBeInTheDocument()
    // Empty instructions render as the em-dash placeholder.
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.queryByText("Not configured")).not.toBeInTheDocument()
  })

  it("[tag:profile-section] shows configured values when only instructions is filled", () => {
    render(<Harness initial={{ instructions: "always cite sources" }} />)

    expect(screen.getByText("Goal")).toBeInTheDocument()
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText("always cite sources")).toBeInTheDocument()
  })

  it("[tag:profile-section] clicking Configure opens the dialog seeded from current form values", () => {
    render(<Harness initial={{ goal: "existing goal", instructions: "" }} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))

    // Dialog now visible with the seeded title.
    expect(
      screen.getByText(AGENT_PROFILE_CONFIG_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    // Goal textarea is seeded with the form's current goal value.
    expect(screen.getByDisplayValue("existing goal")).toBeInTheDocument()
  })

  it("[tag:profile-section] saving the dialog persists draft into form values and re-renders the card", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))

    // Find the Goal and Instructions textareas by maxLength to disambiguate.
    // maxLength values must match GOAL_MAX_LENGTH / INSTRUCTIONS_MAX_LENGTH in
    // `agent-form.consts.ts` — the instructions cap was raised from 500 to
    // 5000 since this test was first written.
    const textareas = screen.getAllByRole(
      "textbox",
    ) as HTMLTextAreaElement[]
    const goal = textareas.find((t) => t.maxLength === 100)
    const instructions = textareas.find((t) => t.maxLength === 5000)
    if (!goal || !instructions) throw new Error("Textareas not found.")

    fireEvent.change(goal, { target: { value: "new goal" } })
    fireEvent.change(instructions, { target: { value: "new instructions" } })

    fireEvent.click(
      screen.getByRole("button", {
        name: AGENT_PROFILE_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )

    // Card now displays the new values.
    expect(screen.getByText("Goal")).toBeInTheDocument()
    expect(screen.getByText("new goal")).toBeInTheDocument()
    expect(screen.getByText("new instructions")).toBeInTheDocument()
    // Form values were updated.
    expect(onChange).toHaveBeenCalledWith({
      goal: "new goal",
      instructions: "new instructions",
    })
  })

  it("[tag:profile-section] clearing profile details from the actions menu resets the form values", () => {
    const onChange = vi.fn()
    render(
      <Harness
        initial={{
          goal: "Answer support questions",
          instructions: "Use concise responses",
        }}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Agent profile options" }))
    fireEvent.click(screen.getByText("Clear profile"))

    expect(onChange).toHaveBeenLastCalledWith({
      goal: "",
      instructions: "",
    })
  })

  it("[tag:profile-section] cancelling the dialog discards unsaved draft edits", () => {
    render(<Harness initial={{ goal: "saved goal" }} />)

    fireEvent.click(screen.getByRole("button", { name: "Configure" }))

    const goal = screen
      .getAllByRole("textbox")
      .find((t) => (t as HTMLTextAreaElement).maxLength === 100) as
      | HTMLTextAreaElement
      | undefined
    if (!goal) throw new Error("Goal textarea not found.")
    fireEvent.change(goal, { target: { value: "stray edit" } })

    fireEvent.click(
      screen.getByRole("button", {
        name: AGENT_PROFILE_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
      }),
    )

    // Card still shows the saved value, not the discarded draft.
    expect(screen.getByText("saved goal")).toBeInTheDocument()
    expect(screen.queryByText("stray edit")).not.toBeInTheDocument()

    // Re-opening also re-seeds the dialog from the (still unchanged) form
    // value — this proves the draft was reset, not just visually hidden.
    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    expect(screen.getByDisplayValue("saved goal")).toBeInTheDocument()
  })
})

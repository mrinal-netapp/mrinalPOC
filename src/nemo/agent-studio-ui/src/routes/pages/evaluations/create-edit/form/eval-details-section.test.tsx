import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { EvalDetailsSection } from "./eval-details-section"

function setup(props: Partial<Parameters<typeof EvalDetailsSection>[0]> = {}) {
  const onNameChange = vi.fn()
  const onDescriptionChange = vi.fn()
  const onLabelsChange = vi.fn()
  const onAddLabel = vi.fn()
  const utils = renderWithProviders(
    <EvalDetailsSection
      name=""
      description=""
      labelItems={[{ key: "staging", value: "staging", label: "staging" }]}
      selectedLabels={[]}
      submitted={false}
      onNameChange={onNameChange}
      onDescriptionChange={onDescriptionChange}
      onLabelsChange={onLabelsChange}
      onAddLabel={onAddLabel}
      {...props}
    />,
  )
  return { onNameChange, onDescriptionChange, onLabelsChange, onAddLabel, ...utils }
}

describe("EvalDetailsSection", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:eval] shows a required error when submitted with an empty name", () => {
    setup({ submitted: true, name: "" })
    expect(screen.getByText("Name is required.")).toBeInTheDocument()
  })

  it("[tag:eval] does not show the error when a name is present", () => {
    setup({ submitted: true, name: "RAG eval" })
    expect(screen.queryByText("Name is required.")).not.toBeInTheDocument()
  })

  it("[tag:eval] shows a pattern error for invalid characters when submitted", () => {
    setup({ submitted: true, name: "eval@#!$" })
    expect(screen.getByText("Name may only contain letters, numbers, spaces, hyphens, and underscores.")).toBeInTheDocument()
  })

  it("[tag:eval] forwards name and description edits", async () => {
    const user = userEvent.setup()
    const { onNameChange, onDescriptionChange } = setup()

    await user.type(screen.getByPlaceholderText("e.g. RAG Validation"), "A")
    expect(onNameChange).toHaveBeenCalledWith("A")

    await user.type(screen.getByPlaceholderText(/Help reviewers/), "B")
    expect(onDescriptionChange).toHaveBeenCalledWith("B")
  })

  it("[tag:eval] selects an existing label", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onLabelsChange } = setup()

    await user.click(document.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')!)
    await user.click(await screen.findByText("staging"))
    expect(onLabelsChange).toHaveBeenCalled()
  })
})

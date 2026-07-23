import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { JudgeConfigDialog, JUDGE_DIMENSIONS } from "./judge-config-dialog"

const MODELS = [
  { id: "m1", name: "gpt-4o", displayName: "GPT-4o" },
  { id: "m2", name: "claude" },
  { id: "m3" },
]
const PROJECT_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Project 1", role: null },
  },
}

describe("JudgeConfigDialog", () => {
  beforeEach(() => { mockFetchSuccess(MODELS) })
  afterEach(() => { restoreAllMocks() })

  function setup(props: Partial<Parameters<typeof JudgeConfigDialog>[0]> = {}) {
    const onOpenChange = vi.fn()
    const onSave = vi.fn()
    const utils = renderWithProviders(
      <JudgeConfigDialog
        open
        onOpenChange={onOpenChange}
        selectedModel=""
        selectedDimensionIds={["helpfulness"]}
        onSave={onSave}
        {...props}
      />,
      { preloadedState: PROJECT_STATE },
    )
    return { onOpenChange, onSave, ...utils }
  }

  it("[tag:eval] renders the dialog with every judge dimension", () => {
    setup()

    expect(screen.getByText("Configure AI judge")).toBeInTheDocument()
    JUDGE_DIMENSIONS.forEach((dim) => {
      expect(screen.getByText(dim.title)).toBeInTheDocument()
    })
  })

  it("[tag:eval] toggles a single dimension off and back on", async () => {
    const user = userEvent.setup()
    const { onSave, onOpenChange } = setup()

    const helpfulness = screen.getByRole("checkbox", { name: "Select Helpfulness" })
    expect(helpfulness).toBeChecked()
    await user.click(helpfulness) // remove
    expect(helpfulness).not.toBeChecked()
    await user.click(helpfulness) // add back

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("", ["helpfulness"])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("[tag:eval] select-all checkbox selects then clears every dimension", async () => {
    const user = userEvent.setup()
    const { onSave } = setup()

    const selectAll = screen.getByRole("checkbox", { name: "Select all dimensions" })
    await user.click(selectAll) // select all
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenLastCalledWith("", JUDGE_DIMENSIONS.map((d) => d.id))
  })

  it("[tag:eval] clears all dimensions when select-all is toggled off from a full selection", async () => {
    const user = userEvent.setup()
    const { onSave } = setup({ selectedDimensionIds: JUDGE_DIMENSIONS.map((d) => d.id) })

    await user.click(screen.getByRole("checkbox", { name: "Select all dimensions" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenLastCalledWith("", [])
  })

  it("[tag:eval] picks a model from the dropdown and saves it", async () => {
    // The trigger briefly has pointer-events: none while models load.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onSave } = setup()

    const trigger = document.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')!
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: "GPT-4o" }))

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", ["helpfulness"])
  })

  it("[tag:eval] cancel closes without saving", async () => {
    const user = userEvent.setup()
    const { onOpenChange, onSave } = setup()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:eval] resets draft state when transitioning from closed to open", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const { rerender } = renderWithProviders(
      <JudgeConfigDialog open={false} onOpenChange={vi.fn()} selectedModel="" selectedDimensionIds={[]} onSave={onSave} />,
      { preloadedState: PROJECT_STATE },
    )

    rerender(
      <JudgeConfigDialog open onOpenChange={vi.fn()} selectedModel="m1" selectedDimensionIds={["coherence"]} onSave={onSave} />,
    )
    // Closing and reopening verifies that the effect resets draft state from props.
    rerender(
      <JudgeConfigDialog open={false} onOpenChange={vi.fn()} selectedModel="m1" selectedDimensionIds={["coherence"]} onSave={onSave} />,
    )
    rerender(
      <JudgeConfigDialog open onOpenChange={vi.fn()} selectedModel="m1" selectedDimensionIds={["coherence"]} onSave={onSave} />,
    )

    expect(await screen.findByRole("checkbox", { name: "Select Coherence" })).toBeChecked()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", ["coherence"])
  })
})

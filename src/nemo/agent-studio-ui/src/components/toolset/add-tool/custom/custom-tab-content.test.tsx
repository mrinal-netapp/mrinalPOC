import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ADD_TOOL_DEFAULT_LABEL_ITEMS } from "../add-tool.consts"
import { CustomTabContent } from "./custom-tab-content"

describe("CustomTabContent", () => {
  const defaultProps = {
    name: "",
    description: "",
    labelItems: ADD_TOOL_DEFAULT_LABEL_ITEMS,
    selectedLabels: [] as string[],
    onNameChange: vi.fn(),
    onDescriptionChange: vi.fn(),
    onLabelChange: vi.fn(),
    onAddLabel: vi.fn(),
  }

  it("[tag:custom-tab] shows name validation after blur", async () => {
    const user = userEvent.setup({ delay: null })
    render(<CustomTabContent {...defaultProps} />)

    await user.click(screen.getByLabelText("Name"))
    fireEvent.blur(screen.getByLabelText("Name"))

    expect(screen.getByText("Name is required")).toBeInTheDocument()
  })

  it("[tag:custom-tab] shows name validation when showValidation is true", () => {
    render(<CustomTabContent {...defaultProps} showValidation />)
    expect(screen.getByText("Name is required")).toBeInTheDocument()
  })

  it("[tag:custom-tab] calls change handlers", async () => {
    const onNameChange = vi.fn()
    const onDescriptionChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(
      <CustomTabContent
        {...defaultProps}
        onNameChange={onNameChange}
        onDescriptionChange={onDescriptionChange}
      />,
    )

    await user.type(screen.getByLabelText("Name"), "my-tool")
    await user.type(screen.getByLabelText("Description"), "desc")

    expect(onNameChange).toHaveBeenCalled()
    expect(onDescriptionChange).toHaveBeenCalled()
  })

  it("[tag:custom-tab] disables name input when isNameDisabled", () => {
    render(<CustomTabContent {...defaultProps} name="locked" isNameDisabled />)
    expect(screen.getByLabelText("Name")).toBeDisabled()
  })
})

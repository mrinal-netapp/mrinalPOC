import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { TableSearch } from "./tableSearch"

function makeProps(overrides: Partial<Parameters<typeof TableSearch>[0]> = {}) {
  return {
    value: "",
    onChange: vi.fn(),
    isOpen: false,
    onToggle: vi.fn(),
    isEnabled: true,
    ...overrides,
  }
}

describe("TableSearch", () => {
  it("renders the search toggle button", () => {
    render(<TableSearch {...makeProps()} />)
    expect(screen.getByLabelText("Open search")).toBeInTheDocument()
  })

  it("shows 'Close search' label when open", () => {
    render(<TableSearch {...makeProps({ isOpen: true })} />)
    expect(screen.getByLabelText("Close search")).toBeInTheDocument()
  })

  it("calls onToggle when icon is clicked and enabled", () => {
    const onToggle = vi.fn()
    render(<TableSearch {...makeProps({ onToggle })} />)
    fireEvent.click(screen.getByLabelText("Open search"))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it("does not call onToggle when disabled", () => {
    const onToggle = vi.fn()
    render(<TableSearch {...makeProps({ onToggle, disabled: true })} />)
    fireEvent.click(screen.getByLabelText("Open search"))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("does not call onToggle when not enabled", () => {
    const onToggle = vi.fn()
    render(<TableSearch {...makeProps({ onToggle, isEnabled: false })} />)
    fireEvent.click(screen.getByLabelText("Open search"))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("shows visible clear button when open and has value", () => {
    const { container } = render(<TableSearch {...makeProps({ isOpen: true, value: "test" })} />)
    expect(container.querySelector(".dt-search__clear--visible")).toBeInTheDocument()
  })

  it("hides clear button when closed even with value", () => {
    const { container } = render(<TableSearch {...makeProps({ value: "test" })} />)
    expect(container.querySelector(".dt-search__clear--visible")).toBeNull()
  })

  it("hides clear button when open but empty", () => {
    const { container } = render(<TableSearch {...makeProps({ isOpen: true, value: "" })} />)
    expect(container.querySelector(".dt-search__clear--visible")).toBeNull()
  })

  it("calls onChange with empty string when clear is clicked", () => {
    const onChange = vi.fn()
    render(<TableSearch {...makeProps({ onChange, isOpen: true, value: "test" })} />)
    fireEvent.click(screen.getByLabelText("Clear search"))
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("applies active class when open", () => {
    const { container } = render(<TableSearch {...makeProps({ isOpen: true })} />)
    expect(container.querySelector(".dt-search__icon--active")).toBeInTheDocument()
  })

  it("applies active class when enabled (even if closed)", () => {
    const { container } = render(<TableSearch {...makeProps({ isEnabled: true })} />)
    expect(container.querySelector(".dt-search__icon--active")).toBeInTheDocument()
  })

  it("applies not-enabled class when disabled", () => {
    const { container } = render(<TableSearch {...makeProps({ isEnabled: false })} />)
    expect(container.querySelector(".dt-search__icon--not-enabled")).toBeInTheDocument()
  })

  it("applies open modifier class when isOpen", () => {
    const { container } = render(<TableSearch {...makeProps({ isOpen: true })} />)
    expect(container.querySelector(".dt-search--open")).toBeInTheDocument()
  })

  it("applies disabled modifier class when disabled", () => {
    const { container } = render(<TableSearch {...makeProps({ disabled: true })} />)
    expect(container.querySelector(".dt-search--disabled")).toBeInTheDocument()
  })

  it("sets tabIndex -1 on input when closed", () => {
    render(<TableSearch {...makeProps()} />)
    const input = screen.getByPlaceholderText("Search...")
    expect(input).toHaveAttribute("tabindex", "-1")
  })

  it("sets tabIndex 0 on input when open", () => {
    render(<TableSearch {...makeProps({ isOpen: true })} />)
    const input = screen.getByPlaceholderText("Search...")
    expect(input).toHaveAttribute("tabindex", "0")
  })

  it("does not call onToggle when both disabled and not enabled", () => {
    const onToggle = vi.fn()
    render(<TableSearch {...makeProps({ onToggle, disabled: true, isEnabled: false })} />)
    fireEvent.click(screen.getByLabelText("Open search"))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("disables the search button when isEnabled is false", () => {
    render(<TableSearch {...makeProps({ isEnabled: false })} />)
    expect(screen.getByLabelText("Open search")).toBeDisabled()
  })

  it("disables the search button when disabled is true", () => {
    render(<TableSearch {...makeProps({ disabled: true })} />)
    expect(screen.getByLabelText("Open search")).toBeDisabled()
  })

  it("calls onChange when typing in input", () => {
    const onChange = vi.fn()
    render(<TableSearch {...makeProps({ onChange, isOpen: true })} />)
    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "hello" } })
    expect(onChange).toHaveBeenCalledWith("hello")
  })
})

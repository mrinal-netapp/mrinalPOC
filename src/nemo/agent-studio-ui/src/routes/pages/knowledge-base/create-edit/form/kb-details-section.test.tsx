import { screen, waitFor, within } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { KBDetailsSection } from "./kb-details-section"
import { TestFormWrapper } from "./test-helpers"

const defaultLabelItems = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "production", value: "production", label: "Production" },
]

describe("KBDetailsSection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  const defaultProps = {
    isEdit: false,
    labelItems: defaultLabelItems,
    onAddLabel: vi.fn(),
    nameValidatorSync: vi.fn(),
    nameValidatorAsync: vi.fn().mockResolvedValue(undefined),
  }

  it("[tag:kb-details-section] renders section header", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDetailsSection form={form} {...defaultProps} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Details")).toBeInTheDocument()
    expect(screen.getByText(/Provide identifying information/)).toBeInTheDocument()
  })

  it("[tag:kb-details-section] renders Name field", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDetailsSection form={form} {...defaultProps} />}</TestFormWrapper>,
    )
    expect(screen.getByPlaceholderText("Enter knowledge base name")).toBeInTheDocument()
  })

  it("[tag:kb-details-section] renders Description field", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDetailsSection form={form} {...defaultProps} />}</TestFormWrapper>,
    )
    expect(screen.getByPlaceholderText("Enter description")).toBeInTheDocument()
  })

  it("[tag:kb-details-section] renders Labels dropdown", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDetailsSection form={form} {...defaultProps} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Labels")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /labels/i })).toBeInTheDocument()
  })

  it("[tag:kb-details-section] selects a label from the dropdown", async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <TestFormWrapper>{(form) => <KBDetailsSection form={form} {...defaultProps} />}</TestFormWrapper>,
    )

    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
    const labelTrigger = within(labelsRow).getByRole("combobox", { name: /labels/i })
    await user.click(labelTrigger)
    await user.click(await screen.findByRole("option", { name: "Staging" }))

    await waitFor(() => {
      expect(within(labelsRow).getByRole("button", { name: /Remove Staging/i })).toBeInTheDocument()
    })
  })

  it("[tag:kb-details-section] renders pipeline toggle (disabled)", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDetailsSection form={form} {...defaultProps} />}</TestFormWrapper>,
    )
    expect(screen.getByText(/Use same details for an execution/)).toBeInTheDocument()
  })
})

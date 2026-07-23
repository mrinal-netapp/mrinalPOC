import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { SummaryDetailsTemplate } from "./summary-details-template"
import type { SummaryField, TabPanel } from "./summary-details-template.types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY_FIELDS: SummaryField[] = [
  { label: "Name", value: "test-model-01" },
  { label: "Type", value: "LLM" },
]

const TAB_PANELS: TabPanel[] = [
  { tab: { id: "overview", label: "Overview" }, content: <div>Overview content</div> },
  { tab: { id: "activity", label: "Activity" }, content: <div>Activity content</div> },
  { tab: { id: "disabled-tab", label: "Disabled", isDisabled: true }, content: <div>Should not show</div> },
]

function renderTemplate(overrides?: Partial<React.ComponentProps<typeof SummaryDetailsTemplate>>) {
  return renderWithProviders(
    <SummaryDetailsTemplate
      title="Test title"
      breadcrumbs={[{ label: "Models", href: "/models" }, { label: "test-model-01", href: "/models/test-model-01" }]}
      actions={<button type="button">Edit</button>}
      summaryFields={SUMMARY_FIELDS}
      tabPanels={TAB_PANELS}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SummaryDetailsTemplate", () => {
  it("[tag:summary-details-template] renders the page title", () => {
    renderTemplate()
    expect(screen.getByText("Test title")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders breadcrumb labels", () => {
    renderTemplate()
    expect(screen.getByText("Models")).toBeInTheDocument()
    // "test-model-01" appears in both the breadcrumb and the summary bar Name field
    expect(screen.getAllByText("test-model-01").length).toBeGreaterThanOrEqual(1)
  })

  it("[tag:summary-details-template] renders action buttons", () => {
    renderTemplate()
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders summary field labels and values", () => {
    renderTemplate()
    expect(screen.getByText("Name")).toBeInTheDocument()
    // "test-model-01" appears in both the breadcrumb and the Name summary field
    expect(screen.getAllByText("test-model-01").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Type")).toBeInTheDocument()
    expect(screen.getByText("LLM")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] split layout groups trailing fields on the right", () => {
    const { container } = renderTemplate({
      summaryStripLayout: "split",
      summaryFields: [
        { label: "Name", value: "tool-mcp-01" },
        { label: "Status", value: "Healthy" },
        { label: "Type", value: "Custom" },
        { label: "Associated agents", value: "agent-sample-name" },
      ],
    })

    expect(container.querySelector(".summary-details-template__summary-grid--split")).toBeInTheDocument()
    expect(container.querySelector(".summary-details-template__summary-trailing")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] first non-disabled tab is active by default", () => {
    renderTemplate()
    expect(screen.getByText("Overview content")).toBeInTheDocument()
    expect(screen.queryByText("Activity content")).not.toBeInTheDocument()
  })

  it("[tag:summary-details-template] switching tabs shows the correct content", async () => {
    renderTemplate()
    const user = userEvent.setup({ delay: null })

    await user.click(screen.getByRole("tab", { name: "Activity" }))

    expect(screen.getByText("Activity content")).toBeInTheDocument()
    expect(screen.queryByText("Overview content")).not.toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders tab buttons for all panels including disabled", () => {
    renderTemplate()
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Disabled" })).toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders placeholder when tab content is null", () => {
    renderTemplate({
      tabPanels: [
        { tab: { id: "empty", label: "Empty tab" }, content: null },
      ],
    })
    expect(screen.getByText(/Content for "Empty tab" goes here/)).toBeInTheDocument()
  })

  it("[tag:summary-details-template] applies custom className to root element", () => {
    const { container } = renderTemplate({ className: "my-custom-class" })
    expect(container.querySelector(".summary-details-template.my-custom-class")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] falls back to first tab when all tabs are disabled", () => {
    renderTemplate({
      tabPanels: [
        { tab: { id: "a", label: "Tab A", isDisabled: true }, content: <div>Content A</div> },
        { tab: { id: "b", label: "Tab B", isDisabled: true }, content: <div>Content B</div> },
      ],
    })
    // First tab is selected as fallback — its content is visible
    expect(screen.getByText("Content A")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders without breadcrumbs when not provided", () => {
    renderTemplate({ breadcrumbs: undefined })
    expect(screen.getByText("Test title")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders without actions when not provided", () => {
    renderTemplate({ actions: undefined })
    expect(screen.getByText("Test title")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] renders without crashing when tabPanels is empty", () => {
    renderTemplate({ tabPanels: [] })
    expect(screen.getByText("Test title")).toBeInTheDocument()
  })

  it("[tag:summary-details-template] selects the first enabled tab when panels load later", () => {
    const { rerender } = renderWithProviders(
      <SummaryDetailsTemplate
        title="Test title"
        summaryFields={SUMMARY_FIELDS}
        tabPanels={[]}
      />,
    )

    rerender(
      <SummaryDetailsTemplate
        title="Test title"
        summaryFields={SUMMARY_FIELDS}
        tabPanels={TAB_PANELS}
      />,
    )

    expect(screen.getByText("Overview content")).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // Summary-strip behaviour (inlined from the former SummaryBar component).
  // Covers the mixed string/number/ReactNode rendering branch and divider
  // layout so the strip is exercised without a separate test file.
  // -------------------------------------------------------------------------

  it("[tag:summary-details-template][tag:summary-strip] renders string field values", () => {
    renderTemplate()
    expect(screen.getByText("LLM")).toBeInTheDocument()
  })

  it("[tag:summary-details-template][tag:summary-strip] renders number field values", () => {
    renderTemplate({
      summaryFields: [
        { label: "Associated resources", value: 3 },
      ],
    })
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("[tag:summary-details-template][tag:summary-strip] renders ReactNode field values as-is", () => {
    renderTemplate({
      summaryFields: [
        { label: "Status", value: <span data-testid="custom-status">Healthy</span> },
      ],
    })
    expect(screen.getByTestId("custom-status")).toBeInTheDocument()
  })

  it("[tag:summary-details-template][tag:summary-strip] renders a divider between adjacent fields", () => {
    const { container } = renderTemplate({
      summaryFields: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
        { label: "C", value: "c" },
      ],
    })
    expect(
      container.querySelectorAll(".summary-details-template__summary-divider").length,
    ).toBe(2)
  })

  it("[tag:summary-details-template] falls back to the first enabled tab when the active tab becomes disabled", async () => {
    const { rerender } = renderTemplate()
    const user = userEvent.setup({ delay: null })

    await user.click(screen.getByRole("tab", { name: "Activity" }))
    expect(screen.getByText("Activity content")).toBeInTheDocument()

    rerender(
      <SummaryDetailsTemplate
        title="Test title"
        summaryFields={SUMMARY_FIELDS}
        tabPanels={[
          { tab: { id: "overview", label: "Overview" }, content: <div>Overview content</div> },
          { tab: { id: "activity", label: "Activity", isDisabled: true }, content: <div>Activity content</div> },
        ]}
      />,
    )

    expect(screen.getByText("Overview content")).toBeInTheDocument()
    expect(screen.queryByText("Activity content")).not.toBeInTheDocument()
  })
})

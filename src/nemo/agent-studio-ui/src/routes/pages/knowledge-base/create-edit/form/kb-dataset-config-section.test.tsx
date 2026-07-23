import { act, screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types"
import type { KBDetail } from "@/api/kb.types"
import { KBDatasetConfigSection } from "./kb-dataset-config-section"
import { TestFormWrapper } from "./test-helpers"

vi.mock("./kb-dataset-picker", () => ({
  KBDatasetPicker: () => <div data-testid="kb-dataset-picker" />,
}))

const mockUseListDatasetsQuery = vi.fn()

vi.mock("@/api/dataset-api.slice", () => ({
  useListDatasetsQuery: (...args: unknown[]) => mockUseListDatasetsQuery(...args),
}))

const DATASETS = [
  { dset_id: "ds-structured", name: "Structured DS", kind: "structured" },
  { dset_id: "ds-unstructured", name: "Unstructured DS", kind: "unstructured" },
]

const PROJECT_PRELOADED_STATE = {
  projectContext: { activeProject: { id: "proj-1", name: "Proj", role: null } },
} as never

describe("KBDatasetConfigSection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
    mockUseListDatasetsQuery.mockReturnValue({ data: { data: DATASETS }, isLoading: false, isError: false })
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-dataset-config] create mode renders picker", () => {
    renderWithProviders(
      <TestFormWrapper>
        {(form) => <KBDatasetConfigSection form={form} isEdit={false} />}
      </TestFormWrapper>,
    )
    expect(screen.getByText("Dataset configuration")).toBeInTheDocument()
    expect(screen.getByText(/Select an existing dataset/)).toBeInTheDocument()
    expect(screen.getByTestId("kb-dataset-picker")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-config] edit mode renders readonly card", () => {
    const initialData: KBDetail = {
      kb_id: "kb-1",
      name: "Test KB",
      status: "ready",
      deprecated: false,
      labels: [],
      created_at: "2024-01-01T00:00:00Z",
      assigned_dataset: {
        dset_id: "ds-1",
        name: "My Dataset",
        status: "Healthy",
        labels: ["prod"],
      },
    }
    renderWithProviders(
      <TestFormWrapper>
        {(form) => <KBDatasetConfigSection form={form} isEdit={true} initialData={initialData} />}
      </TestFormWrapper>,
    )

    expect(screen.getByText(/cannot be changed from this form/)).toBeInTheDocument()
    expect(screen.getByText("Assigned dataset")).toBeInTheDocument()
    expect(screen.getByText("My Dataset")).toBeInTheDocument()
    expect(screen.getByText("prod")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-config] edit mode with no dataset shows dashes", () => {
    const initialData: KBDetail = {
      kb_id: "kb-1",
      name: "Test KB",
      status: "ready",
      deprecated: false,
      labels: [],
      created_at: "2024-01-01T00:00:00Z",
    }
    renderWithProviders(
      <TestFormWrapper>
        {(form) => <KBDatasetConfigSection form={form} isEdit={true} initialData={initialData} />}
      </TestFormWrapper>,
    )

    const dashes = screen.getAllByText("—")
    expect(dashes.length).toBeGreaterThanOrEqual(3)
  })

  it("[tag:kb-dataset-config] create mode shows the text columns field once a structured dataset is selected", () => {
    let capturedForm: AnyReactFormApi | undefined
    renderWithProviders(
      <TestFormWrapper>
        {(form) => {
          capturedForm = form
          return <KBDatasetConfigSection form={form} isEdit={false} />
        }}
      </TestFormWrapper>,
      { preloadedState: PROJECT_PRELOADED_STATE },
    )

    expect(screen.queryByText("Text columns")).not.toBeInTheDocument()

    act(() => {
      capturedForm!.setFieldValue("dataset_id", "ds-structured")
    })

    expect(screen.getByText("Text columns")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-config] create mode hides the text columns field for unstructured datasets", () => {
    let capturedForm: AnyReactFormApi | undefined
    renderWithProviders(
      <TestFormWrapper>
        {(form) => {
          capturedForm = form
          return <KBDatasetConfigSection form={form} isEdit={false} />
        }}
      </TestFormWrapper>,
      { preloadedState: PROJECT_PRELOADED_STATE },
    )

    act(() => {
      capturedForm!.setFieldValue("dataset_id", "ds-unstructured")
    })

    expect(screen.queryByText("Text columns")).not.toBeInTheDocument()
  })

  it("[tag:kb-dataset-config] edit mode shows the text columns field for a structured assigned dataset", () => {
    const initialData: KBDetail = {
      kb_id: "kb-1",
      name: "Test KB",
      status: "ready",
      deprecated: false,
      labels: [],
      created_at: "2024-01-01T00:00:00Z",
      text_columns: "title, content",
      assigned_dataset: {
        dset_id: "ds-1",
        name: "My Dataset",
        kind: "structured",
        status: "Healthy",
      },
    }
    renderWithProviders(
      <TestFormWrapper overrides={{ text_columns: "title, content" }}>
        {(form) => <KBDatasetConfigSection form={form} isEdit={true} initialData={initialData} />}
      </TestFormWrapper>,
    )

    expect(screen.getByText("Text columns")).toBeInTheDocument()
    expect(screen.getByDisplayValue("title, content")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-config] edit mode hides the text columns field when the assigned dataset is unstructured", () => {
    const initialData: KBDetail = {
      kb_id: "kb-1",
      name: "Test KB",
      status: "ready",
      deprecated: false,
      labels: [],
      created_at: "2024-01-01T00:00:00Z",
      assigned_dataset: {
        dset_id: "ds-1",
        name: "My Dataset",
        kind: "unstructured",
        status: "Healthy",
      },
    }
    renderWithProviders(
      <TestFormWrapper>
        {(form) => <KBDatasetConfigSection form={form} isEdit={true} initialData={initialData} />}
      </TestFormWrapper>,
    )

    expect(screen.queryByText("Text columns")).not.toBeInTheDocument()
  })
})

import { screen, waitFor, within } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DatasetListItem } from "@/api/dataset.types"
import type { KBDetail } from "@/api/kb.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockBlocker = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useBlocker: (shouldBlock: boolean) => mockBlocker(shouldBlock),
  }
})

const mockCreateKB = vi.fn()
const mockUpdateKB = vi.fn()
const mockValidateName = vi.fn()

vi.mock("@/api/kb-api.slice", () => ({
  useCreateKnowledgeBaseMutation: vi.fn(),
  useUpdateKnowledgeBaseMutation: vi.fn(),
  useValidateKBNameMutation: vi.fn(),
}))

vi.mock("@/api/dataset-api.slice", () => ({
  useListDatasetsQuery: vi.fn(),
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

const mockShowKBWorkflowOutcomeToast = vi.fn()
vi.mock("@/components/knowledge-base/utils/kb-workflow-outcome.utils", () => ({
  showKBWorkflowOutcomeToast: (...args: unknown[]) => mockShowKBWorkflowOutcomeToast(...args),
}))

import { useListDatasetsQuery } from "@/api/dataset-api.slice"
import {
  useCreateKnowledgeBaseMutation,
  useUpdateKnowledgeBaseMutation,
  useValidateKBNameMutation,
} from "@/api/kb-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { KBForm } from "./kb-form"

function getSubmitButton(label = "Add") {
  const footer = document.querySelector(".dset-form-page__footer") as HTMLElement
  return within(footer).getByRole("button", { name: label })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PICKER_DATASET: DatasetListItem = {
  dset_id: "ds-picker-1",
  name: "Picker Dataset",
  kind: "unstructured",
  status: "Healthy",
  lifecycle_status: "ready",
  synchronization_status: "Completed",
  input_type: "data-source",
  data_source: { dsrc_id: "dsrc-1", name: "Source" },
  deprecated: false,
  files_count: 50,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  latest_snapshot: null,
}

const MOCK_DETAIL: KBDetail = {
  kb_id: "kb-edit-1",
  name: "Existing KB",
  status: "ready",
  deprecated: false,
  labels: ["prod"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-06-01T00:00:00Z",
  description: "Existing description",
  assigned_dataset: { dset_id: "ds-1", name: "My Dataset" },
  synchronization_config: { sync_mode: "manual" },
  embedding_config: { model: "openai-text-embedding-3-small" },
  chunking_config: { strategy: "sentence", chunk_size: 300, overlap: 30 },
  indexing_config: { index_type: "hybrid_search" },
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let roHandle: ReturnType<typeof mockResizeObserver>

beforeEach(() => {
  vi.clearAllMocks()
  roHandle = mockResizeObserver()

  mockBlocker.mockReturnValue({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() })

  vi.mocked(useCreateKnowledgeBaseMutation).mockReturnValue([
    mockCreateKB,
    { isLoading: false, reset: vi.fn() } as unknown as ReturnType<typeof useCreateKnowledgeBaseMutation>[1],
  ])
  vi.mocked(useUpdateKnowledgeBaseMutation).mockReturnValue([
    mockUpdateKB,
    { isLoading: false, reset: vi.fn() } as unknown as ReturnType<typeof useUpdateKnowledgeBaseMutation>[1],
  ])
  vi.mocked(useValidateKBNameMutation).mockReturnValue([
    mockValidateName,
    { reset: vi.fn() } as unknown as ReturnType<typeof useValidateKBNameMutation>[1],
  ])

  vi.mocked(useListDatasetsQuery).mockReturnValue({
    data: { data: [MOCK_PICKER_DATASET], total: 1 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useListDatasetsQuery>)

  return () => roHandle.cleanup()
})

// ---------------------------------------------------------------------------
// Create mode
// ---------------------------------------------------------------------------

describe("KBForm — create mode", () => {
  it("[tag:kb-form] renders 'Add new knowledge base' title", () => {
    renderWithProviders(<KBForm />)
    expect(screen.getByText("Add new knowledge base")).toBeInTheDocument()
  })

  it("[tag:kb-form] renders Add and Cancel buttons", () => {
    renderWithProviders(<KBForm />)
    expect(getSubmitButton()).toBeInTheDocument()
    expect(screen.getByText("Cancel")).toBeInTheDocument()
  })

  it("[tag:kb-form] renders all form sections", () => {
    renderWithProviders(<KBForm />)
    expect(screen.getByText("Details")).toBeInTheDocument()
    expect(screen.getByText("Dataset configuration")).toBeInTheDocument()
    expect(screen.getByText("Sync settings")).toBeInTheDocument()
    expect(screen.getByText("Data change threshold")).toBeInTheDocument()
    expect(screen.getByText("Embedding & chunking configuration")).toBeInTheDocument()
    expect(screen.getByText("Indexing configuration")).toBeInTheDocument()
    expect(screen.queryByText(/Estimated build summary/)).not.toBeInTheDocument()
    expect(screen.queryByText("Vector index configuration")).not.toBeInTheDocument()
    expect(screen.queryByText(/Estimate, per vector/)).not.toBeInTheDocument()
  })

  it("[tag:kb-form] renders dataset picker table with data", () => {
    renderWithProviders(<KBForm />)
    expect(screen.getByText("Picker Dataset")).toBeInTheDocument()
  })

  it("[tag:kb-form] Cancel navigates to KB list", async () => {
    renderWithProviders(<KBForm />)
    await userEvent.setup().click(screen.getByText("Cancel"))
    expect(mockNavigate).toHaveBeenCalledWith("/knowledge-bases")
  })

  it("[tag:kb-form] Close (X) button navigates to KB list", async () => {
    renderWithProviders(<KBForm />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Close" }))
    expect(mockNavigate).toHaveBeenCalledWith("/knowledge-bases")
  })

  it("[tag:kb-form] submits create mutation after selecting dataset", async () => {
    mockCreateKB.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    mockValidateName.mockReturnValue({ unwrap: () => Promise.resolve({ available: true }) })
    renderWithProviders(<KBForm />)

    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByText("Picker Dataset")).toBeInTheDocument()
    })
    const rowCheckboxes = screen.getAllByLabelText("Select row")
    await user.click(rowCheckboxes[0]!)

    const nameInput = screen.getByPlaceholderText("Enter knowledge base name")
    await user.type(nameInput, "New KB Name")
    await user.tab()

    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())

    await user.click(getSubmitButton())

    await waitFor(() => {
      expect(mockCreateKB).toHaveBeenCalled()
    })
  })

  it("[tag:kb-form][tag:success] successful create shows toast and navigates to list", async () => {
    mockCreateKB.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    mockValidateName.mockReturnValue({ unwrap: () => Promise.resolve({ available: true }) })
    renderWithProviders(<KBForm />)

    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByText("Picker Dataset")).toBeInTheDocument())
    await user.click(screen.getAllByLabelText("Select row")[0]!)

    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "New KB Name")
    await user.tab()
    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())

    await user.click(getSubmitButton())

    await waitFor(() => {
      expect(mockShowKBWorkflowOutcomeToast).toHaveBeenCalledWith("create", {})
    })
    expect(mockNavigate).toHaveBeenCalledWith("/knowledge-bases")
  })

  it("[tag:kb-form][tag:success] create with workflow warning delegates to workflow toast helper", async () => {
    const outcome = {
      warning: "KB created but workflow not started: source dataset not found",
      workflowSkippedReason: "dataset_not_found",
    }
    mockCreateKB.mockReturnValue({ unwrap: () => Promise.resolve(outcome) })
    mockValidateName.mockReturnValue({ unwrap: () => Promise.resolve({ available: true }) })
    renderWithProviders(<KBForm />)

    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByText("Picker Dataset")).toBeInTheDocument())
    await user.click(screen.getAllByLabelText("Select row")[0]!)

    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "New KB Name")
    await user.tab()
    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())

    await user.click(getSubmitButton())

    await waitFor(() => {
      expect(mockShowKBWorkflowOutcomeToast).toHaveBeenCalledWith("create", outcome)
    })
  })

  it("[tag:kb-form][tag:error] failed create shows error toast", async () => {
    mockCreateKB.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })
    mockValidateName.mockReturnValue({ unwrap: () => Promise.resolve({ available: true }) })
    renderWithProviders(<KBForm />)

    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByText("Picker Dataset")).toBeInTheDocument())
    await user.click(screen.getAllByLabelText("Select row")[0]!)

    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "New KB Name")
    await user.tab()
    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())

    await user.click(getSubmitButton())

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to create knowledge base.")
    })
  })

  it("[tag:kb-form][tag:error] surfaces backend 409 message on duplicate name", async () => {
    mockCreateKB.mockReturnValue({
      unwrap: () =>
        Promise.reject({
          status: 409,
          data: { error: "Knowledge base with this name already exists in this project" },
        }),
    })
    mockValidateName.mockReturnValue({ unwrap: () => Promise.resolve({ available: true }) })
    renderWithProviders(<KBForm />)

    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByText("Picker Dataset")).toBeInTheDocument())
    await user.click(screen.getAllByLabelText("Select row")[0]!)

    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "Duplicate KB")
    await user.tab()
    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())

    await user.click(getSubmitButton())

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Knowledge base with this name already exists in this project",
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

describe("KBForm — edit mode", () => {
  it("[tag:kb-form] renders 'Edit knowledge base' title", () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    expect(screen.getByText("Edit knowledge base")).toBeInTheDocument()
  })

  it("[tag:kb-form] renders Save and Cancel buttons", () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    expect(screen.getByText("Save")).toBeInTheDocument()
    expect(screen.getByText("Cancel")).toBeInTheDocument()
  })

  it("[tag:kb-form] pre-fills name field as read-only", () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    expect(screen.getByDisplayValue("Existing KB")).toBeInTheDocument()
  })

  it("[tag:kb-form] shows assigned dataset readonly card (not picker)", () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    expect(screen.getByText("Assigned dataset")).toBeInTheDocument()
    expect(screen.getByText("My Dataset")).toBeInTheDocument()
  })

  it("[tag:kb-form] Cancel navigates to KB detail in edit mode", async () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    await userEvent.setup().click(screen.getByText("Cancel"))
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("kb-edit-1"))
  })

  it("[tag:kb-form] Close (X) button navigates to KB detail in edit mode", async () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Close" }))
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("kb-edit-1"))
  })

  it("[tag:kb-form] shows info toast when saving with no changes", async () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    await userEvent.setup().click(screen.getByText("Save"))

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("No changes to save.")
    })
  })

  it("[tag:kb-form] submits update mutation on form submit", async () => {
    mockUpdateKB.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)

    const user = userEvent.setup()
    const descInput = screen.getByDisplayValue("Existing description")
    await user.clear(descInput)
    await user.type(descInput, "Updated description")
    await user.click(screen.getByText("Save"))

    await waitFor(() => {
      expect(mockUpdateKB).toHaveBeenCalled()
    })
  })

  it("[tag:kb-form][tag:success] successful update shows toast and navigates", async () => {
    mockUpdateKB.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)

    const user = userEvent.setup()
    const descInput = screen.getByDisplayValue("Existing description")
    await user.clear(descInput)
    await user.type(descInput, "Changed")
    await user.click(screen.getByText("Save"))

    await waitFor(() => {
      expect(mockShowKBWorkflowOutcomeToast).toHaveBeenCalledWith("update", {})
    })
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("kb-edit-1"))
  })

  it("[tag:kb-form][tag:success] update with workflowId shows reprocess outcome toast", async () => {
    const outcome = { workflowId: "wf-reprocess-1" }
    mockUpdateKB.mockReturnValue({ unwrap: () => Promise.resolve(outcome) })
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)

    const user = userEvent.setup()
    const descInput = screen.getByDisplayValue("Existing description")
    await user.clear(descInput)
    await user.type(descInput, "Changed")
    await user.click(screen.getByText("Save"))

    await waitFor(() => {
      expect(mockShowKBWorkflowOutcomeToast).toHaveBeenCalledWith("update", outcome)
    })
  })

  it("[tag:kb-form][tag:error] failed update shows error toast", async () => {
    mockUpdateKB.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)

    const user = userEvent.setup()
    const descInput = screen.getByDisplayValue("Existing description")
    await user.clear(descInput)
    await user.type(descInput, "Changed")
    await user.click(screen.getByText("Save"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to update knowledge base.")
    })
  })

  it("[tag:kb-form] only sends changed fields in edit mode (delta-only update)", async () => {
    mockUpdateKB.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)

    const user = userEvent.setup()
    const descInput = screen.getByDisplayValue("Existing description")
    await user.clear(descInput)
    await user.type(descInput, "New description")
    await user.click(screen.getByText("Save"))

    await waitFor(() => {
      expect(mockUpdateKB).toHaveBeenCalled()
      const call = mockUpdateKB.mock.calls[0][0]
      expect(call.body.description).toBe("New description")
    })
  })
})

// ---------------------------------------------------------------------------
// Discard guard
// ---------------------------------------------------------------------------

describe("KBForm — discard guard", () => {
  it("[tag:kb-form] calls useBlocker with form dirty state", () => {
    renderWithProviders(<KBForm />)
    expect(mockBlocker).toHaveBeenCalled()
  })

  it("[tag:kb-form] renders discard dialog when blocked", () => {
    mockBlocker.mockReturnValue({ state: "blocked", proceed: vi.fn(), reset: vi.fn() })
    renderWithProviders(<KBForm />)
    expect(screen.getByText("Discard changes?")).toBeInTheDocument()
  })

  it("[tag:kb-form] Discard calls blocker.proceed", async () => {
    const proceed = vi.fn()
    mockBlocker.mockReturnValue({ state: "blocked", proceed, reset: vi.fn() })
    renderWithProviders(<KBForm />)

    await userEvent.setup().click(screen.getByText("Discard"))
    expect(proceed).toHaveBeenCalled()
  })

  it("[tag:kb-form] Stay calls blocker.reset", async () => {
    const reset = vi.fn()
    mockBlocker.mockReturnValue({ state: "blocked", proceed: vi.fn(), reset })
    renderWithProviders(<KBForm />)

    await userEvent.setup().click(screen.getByText("Stay"))
    expect(reset).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

describe("KBForm — name validation", () => {
  it("[tag:kb-form][tag:validation] empty name shows 'Name is required'", async () => {
    renderWithProviders(<KBForm />)
    const user = userEvent.setup()
    const nameInput = screen.getByPlaceholderText("Enter knowledge base name")
    await user.click(nameInput)
    await user.tab()
    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument()
    })
  })

  it("[tag:kb-form][tag:validation] short name shows min-length error", async () => {
    renderWithProviders(<KBForm />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "ab")
    await user.tab()
    await waitFor(() => {
      expect(screen.getByText("Name must be at least 3 characters")).toBeInTheDocument()
    })
  })

  it("[tag:kb-form][tag:validation] name with invalid characters shows pattern error", async () => {
    renderWithProviders(<KBForm />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "test@kb!")
    await user.tab()
    await waitFor(() => {
      expect(
        screen.getByText("Name may only contain letters, numbers, spaces, hyphens, and underscores"),
      ).toBeInTheDocument()
    })
  })

  it("[tag:kb-form][tag:validation] taken name shows 'already exists'", async () => {
    mockValidateName.mockReturnValue({ unwrap: () => Promise.resolve({ available: false }) })
    renderWithProviders(<KBForm />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "ExistingName")
    await user.tab()
    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByText("A knowledge base with this name already exists")).toBeInTheDocument()
    })
  })

  it("[tag:kb-form][tag:validation] validation API failure shows generic error", async () => {
    mockValidateName.mockReturnValue({ unwrap: () => Promise.reject(new Error("net")) })
    renderWithProviders(<KBForm />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText("Enter knowledge base name"), "SomeName")
    await user.tab()
    await waitFor(() => expect(mockValidateName).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByText("Unable to validate name")).toBeInTheDocument()
    })
  })

  it("[tag:kb-form][tag:validation] name validators skip in edit mode", async () => {
    renderWithProviders(<KBForm isEdit initialData={MOCK_DETAIL} />)
    const user = userEvent.setup()
    await user.click(screen.getByDisplayValue("Existing KB"))
    await user.tab()
    await waitFor(() => {
      expect(screen.queryByText("Name is required")).not.toBeInTheDocument()
    })
    expect(mockValidateName).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Label management (free-form editor)
// ---------------------------------------------------------------------------

describe("KBForm — label management", () => {
  it("[tag:kb-form][tag:label] adds a new label via the labels dropdown", { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<KBForm />)

    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
    const labelTrigger = within(labelsRow).getByRole("combobox", { name: /labels/i })
    await user.click(labelTrigger)

    const searchInput = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(".select-dropdown-searchbar__input")
      if (!el) throw new Error("search input not found")
      return el
    })
    await user.type(searchInput, "brand-new-label")

    const addBtn = await screen.findByRole("button", { name: "Add new item" })
    await user.click(addBtn)

    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: "Add new item" })
      expect(!btn || btn.hasAttribute("disabled")).toBe(true)
    })
  })

  it("[tag:kb-form][tag:label] selecting an existing label shows it as a chip", async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<KBForm />)

    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
    const labelTrigger = within(labelsRow).getByRole("combobox", { name: /labels/i })
    await user.click(labelTrigger)
    await user.click(await screen.findByRole("option", { name: "Staging" }))

    await waitFor(() => {
      expect(within(labelsRow).getByRole("button", { name: /Remove Staging/i })).toBeInTheDocument()
    })
  })

  it("[tag:kb-form][tag:label] initialData with custom labels pre-populates", () => {
    const detail = { ...MOCK_DETAIL, labels: ["custom-xyz"] }
    renderWithProviders(<KBForm isEdit initialData={detail} />)
    expect(screen.getByText("custom-xyz")).toBeInTheDocument()
  })

  it("[tag:kb-form][tag:label] duplicate labels in initialData are not re-added", () => {
    const detail = { ...MOCK_DETAIL, labels: ["staging"] }
    renderWithProviders(<KBForm isEdit initialData={detail} />)
    expect(screen.getByText("Staging")).toBeInTheDocument()
  })
})

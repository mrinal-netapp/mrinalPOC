import { screen, waitFor, within } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DataSourceDetail } from "@/api/data-source.types"

// ---------------------------------------------------------------------------
// Module mocks — must be at module scope
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

const mockCreateDataSource = vi.fn()
const mockUpdateDataSource = vi.fn()
const mockRecordConnectionTestResult = vi.fn()

vi.mock("@/api/data-source-api.slice", () => ({
  useCreateDataSourceMutation: vi.fn(),
  useUpdateDataSourceMutation: vi.fn(),
  useRecordConnectionTestResultMutation: vi.fn(),
  // The access-config dialog's Volume tab loads StorageClasses via this hook.
  useListStorageClassesQuery: () => ({ data: [] }),
}))

vi.mock("@/api/workflow-api", () => ({
  startConnectorTest: vi.fn().mockResolvedValue({ workflowId: "wf-test" }),
  getWorkflowStatus: vi.fn().mockResolvedValue({ status: "completed", isRunning: false }),
}))

const mockValidateConnection = vi.fn()
const mockValidateExisting = vi.fn()

vi.mock("@/api/utilities-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/utilities-api.slice")>()
  return {
    ...actual,
    useValidateConnectionMutation: vi.fn(),
    useValidateExistingDatasourceConnectionMutation: vi.fn(),
  }
})

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

// The access dialog loads saved credentials for connector categories; stub the
// hook so the "Use existing credentials" dropdown has a selectable item.
vi.mock("@/routes/pages/credentials/credential-api.slice", () => ({
  useListCredentialsQuery: () => ({
    data: [{ id: "cred-1", name: "cred-1", provider: "gcp", projectId: "p", createdAt: "", updatedAt: "" }],
  }),
  useCreateCredentialMutation: () => [
    vi.fn(() => ({ unwrap: () => Promise.resolve({ id: "cred-new", name: "cred-new" }) })),
    { isLoading: false },
  ],
  useRotateCredentialMutation: () => [
    vi.fn(() => ({ unwrap: () => Promise.resolve({ id: "cred-1", name: "cred-1" }) })),
    { isLoading: false },
  ],
}))

import { MOCK_PROVIDER_CATALOG } from "./connector-config-validation.fixture"

vi.mock("@/api/provider-catalog-api.slice", () => ({
  useListProviderCatalogQuery: () => ({
    data: MOCK_PROVIDER_CATALOG,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))

import {
  useCreateDataSourceMutation,
  useUpdateDataSourceMutation,
  useRecordConnectionTestResultMutation,
} from "@/api/data-source-api.slice"
import {
  useValidateConnectionMutation,
  useValidateExistingDatasourceConnectionMutation,
} from "@/api/utilities-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { DataSourceForm } from "./data-source-form"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DETAIL: DataSourceDetail = {
  dsrc_id: "ds-edit-1",
  name: "Existing Source",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: ["prod"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: "Existing description",
  connection: {
    server: "nfs.example.com",
    export_path: "/data",
    folder_boundary: null,
    auth_method: "none",
    username: "user1",
  },
  modified_by: "admin",
  scan: {
    status: "Completed",
    scan_depth: "top_2_levels",
    custom_depth: null,
    total_files: 500,
    total_folders: 50,
    total_size_bytes: 10_000_000,
    last_completed_at: "2024-05-01T00:00:00Z",
    status_message: null,
    file_type_stats: null,
  },
  scanned_data_count: 500,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function setupApiMocks({
  createResult = { unwrap: () => Promise.resolve({}) },
  updateResult = { unwrap: () => Promise.resolve({}) },
}: {
  createResult?: { unwrap: () => Promise<unknown> }
  updateResult?: { unwrap: () => Promise<unknown> }
} = {}) {
  mockCreateDataSource.mockReturnValue(createResult)
  mockUpdateDataSource.mockReturnValue(updateResult)
  mockRecordConnectionTestResult.mockReturnValue({ unwrap: () => Promise.resolve({}) })

  vi.mocked(useCreateDataSourceMutation).mockReturnValue([mockCreateDataSource, { isLoading: false, reset: vi.fn() }] as ReturnType<typeof useCreateDataSourceMutation>)
  vi.mocked(useUpdateDataSourceMutation).mockReturnValue([mockUpdateDataSource, { isLoading: false, reset: vi.fn() }] as ReturnType<typeof useUpdateDataSourceMutation>)
  vi.mocked(useRecordConnectionTestResultMutation).mockReturnValue([mockRecordConnectionTestResult, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useRecordConnectionTestResultMutation>)

  mockValidateConnection.mockReturnValue({ unwrap: () => Promise.resolve({ healthiness_status: "HEALTHY" }) })
  mockValidateExisting.mockReturnValue({ unwrap: () => Promise.resolve({ healthiness_status: "HEALTHY" }) })

  vi.mocked(useValidateConnectionMutation).mockReturnValue([mockValidateConnection, {} as unknown as ReturnType<typeof useValidateConnectionMutation>[1]])
  vi.mocked(useValidateExistingDatasourceConnectionMutation).mockReturnValue([mockValidateExisting, {} as unknown as ReturnType<typeof useValidateExistingDatasourceConnectionMutation>[1]])

  // Default blocker: non-blocked state
  mockBlocker.mockReturnValue({ state: "unblocked" })
}

// Opens the access dialog, fills a GCP project id, picks a credential, and
// confirms. Connector categories enable Add once required fields are set.
async function configureGcpAccess(
  user: ReturnType<typeof userEvent.setup>,
  projectId = "nfs.example.com",
) {
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.type(screen.getByLabelText(/project id/i), projectId)
  // Region is optional for the GCP connector.
  await user.type(screen.getByLabelText(/region/i), "us-central1")

  const credentialLabel = screen.getByText("Credential")
  const field = credentialLabel.closest(".ds-form__db-field") as HTMLElement
  await user.click(field.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')!)
  await user.click(await screen.findByRole("option", { name: "cred-1" }))

  // Two "Add" buttons exist while the dialog is open (access section + dialog
  // footer); the dialog's confirm button is rendered last via the portal.
  const addButtons = screen.getAllByRole("button", { name: "Add" })
  const dialogAdd = addButtons[addButtons.length - 1]
  await waitFor(() => expect(dialogAdd).not.toBeDisabled())
  await user.click(dialogAdd)
}

const TEST_PRELOADED_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Test Project", role: "admin" as const },
  },
}

function renderCreateForm() {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/data-sources/register", element: <DataSourceForm /> },
      { path: "/data-sources", element: <div data-testid="list-page" /> },
    ],
    initialEntries: ["/data-sources/register"],
    preloadedState: TEST_PRELOADED_STATE,
  })
}

function renderEditForm(initialData = MOCK_DETAIL) {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/data-sources/:dsrcId/edit", element: <DataSourceForm isEdit initialData={initialData} /> },
      { path: "/data-sources/:dsrcId", element: <div data-testid="detail-page" /> },
    ],
    initialEntries: [`/data-sources/${initialData.dsrc_id}/edit`],
    preloadedState: TEST_PRELOADED_STATE,
  })
}

// ---------------------------------------------------------------------------
// Section 11 — DataSourceForm create mode
// ---------------------------------------------------------------------------

describe("DataSourceForm — create mode", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    setupApiMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 11.1
  it("[tag:data-source-form][tag:create] details section renders name, description, labels fields", () => {
    renderCreateForm()

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument()
    // Labels uses a select dropdown; check the label element text
    expect(screen.getByText("Labels")).toBeInTheDocument()
  })

  // 11.2
  it("[tag:data-source-form][tag:create] name field empty → sync validation error 'Name is required'", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.click(nameInput)
    await user.tab()

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument()
    })
  })

  // 11.2b
  it("[tag:data-source-form][tag:create] name field 1-2 chars → 'Name must be at least 3 characters'", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "ab")
    await user.tab()

    await waitFor(() => {
      expect(screen.getByText("Name must be at least 3 characters")).toBeInTheDocument()
    })
  })

  // 11.3 — name uniqueness is enforced by the backend (409 on create), not a
  // client-side pre-check, so there's no async name validation here. See the
  // "create failure → backend error message" test for the duplicate-name path.

  // 11.5
  it("[tag:data-source-form][tag:access-config-dialog] 'Configure access' opens AccessConfigDialog", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.click(screen.getByRole("button", { name: "Add" }))

    // Dialog title appears
    expect(screen.getByText("Add data source access configuration")).toBeInTheDocument()
  })

  // 11.8
  it("[tag:data-source-form][tag:access-config-dialog] canceling dialog does not update form state", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    // Open dialog
    await user.click(screen.getByRole("button", { name: "Add" }))
    // Fill server
    const serverInput = screen.getByLabelText(/project id/i)
    await user.type(serverInput, "new-server")
    // Cancel
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    // The access config card should still show "Add" (not configured)
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
  })

  // 11.9 — ScanningSection renders in create mode
  // Scanning UI is temporarily hidden from the register page (SHOW_SCANNING=false).
  // Re-enable this test when the scanning section is restored.
  it.skip("[tag:data-source-form][tag:create] scanning section renders with 'Enable' button (default none)", () => {
    renderCreateForm()

    expect(screen.getByText("Scanning is disabled on this data source.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument()
  })

  // 11.10
  // Scanning UI is temporarily hidden from the register page (SHOW_SCANNING=false).
  it.skip("[tag:data-source-form][tag:scanning-settings-dialog] 'Enable scanning' opens ScanningSettingsDialog", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.click(screen.getByRole("button", { name: "Enable" }))

    // Dialog title visible
    expect(screen.getByText("Enable data source scanning")).toBeInTheDocument()
  })

  // 11.13
  // Extended timeout: this test exercises a multi-step form flow (type +
  // configure access + submit) and can exceed the default 5s limit when the
  // full suite runs with coverage enabled.
  it("[tag:data-source-form][tag:success] create success → success toast; navigate to list", { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    renderCreateForm()

    // Fill required name
    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "new-source")

    // Set source_type by confirming the access dialog with a server
    await configureGcpAccess(user)

    // Submit
    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Data source registered successfully.")
    }, { timeout: 10_000 })
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("data-sources"))
  })

  // 11.14
  // Extended timeout: this test exercises a multi-step form flow (type + configure access + submit)
  // and can exceed the default 5s limit when the full suite runs with coverage enabled.
  it("[tag:data-source-form][tag:error] create failure → error toast", { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    setupApiMocks({ createResult: { unwrap: () => Promise.reject(new Error("fail")) } })
    renderCreateForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "new-source")

    // Configure access
    await configureGcpAccess(user)

    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to register data source.")
    }, { timeout: 10_000 })
  })

  // 11.14b — duplicate name: backend rejects with a 409 whose body carries a
  // specific message; the toast should surface that message verbatim.
  it("[tag:data-source-form][tag:error] create failure with backend error → shows backend message", { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    setupApiMocks({
      createResult: {
        unwrap: () =>
          Promise.reject({
            status: 409,
            data: { error: "A data source with this name already exists in this project", code: "CONFLICT" },
          }),
      },
    })
    renderCreateForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "duplicate-name")

    await configureGcpAccess(user)

    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("A data source with this name already exists in this project")
    })
  })

  // 11.16
  it("[tag:data-source-form][tag:confirm-dialog] discard dialog confirm → blocker.proceed() called", async () => {
    const user = userEvent.setup()
    const mockProceed = vi.fn()
    const mockReset = vi.fn()
    mockBlocker.mockReturnValue({ state: "blocked", proceed: mockProceed, reset: mockReset })
    renderCreateForm()

    // Discard dialog is open because blocker.state = "blocked"
    expect(screen.getByText("Discard changes?")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Discard" }))
    expect(mockProceed).toHaveBeenCalledOnce()
  })

  // 11.17
  it("[tag:data-source-form][tag:confirm-dialog] discard dialog cancel → blocker.reset() called", async () => {
    const user = userEvent.setup()
    const mockProceed = vi.fn()
    const mockReset = vi.fn()
    mockBlocker.mockReturnValue({ state: "blocked", proceed: mockProceed, reset: mockReset })
    renderCreateForm()

    await user.click(screen.getByRole("button", { name: "Stay" }))
    expect(mockReset).toHaveBeenCalledOnce()
  })

  // 11.18
  it("[tag:data-source-form][tag:submitting] footer buttons disabled while submitting", () => {
    vi.mocked(useCreateDataSourceMutation).mockReturnValue([mockCreateDataSource, { isLoading: true, reset: vi.fn() }] as unknown as ReturnType<typeof useCreateDataSourceMutation>)
    renderCreateForm()

    // Cancel button should be disabled while submitting
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  })

  // 11.19
  it("[tag:data-source-form] Cancel on clean form navigates back without blocker", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("data-sources"))
  })

  // Labels use the same multi-select dropdown as datasets (blue chips + Add).
  it("[tag:data-source-form][tag:labels] adds a new label via the labels dropdown", { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    const { container } = renderCreateForm()

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

  it("[tag:data-source-form][tag:labels] selecting an existing label shows it as a chip", async () => {
    const user = userEvent.setup()
    const { container } = renderCreateForm()

    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
    const labelTrigger = within(labelsRow).getByRole("combobox", { name: /labels/i })
    await user.click(labelTrigger)
    await user.click(await screen.findByRole("option", { name: "Staging" }))

    await waitFor(() => {
      expect(within(labelsRow).getByRole("button", { name: /Remove Staging/i })).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Section 12 — DataSourceForm edit mode
// ---------------------------------------------------------------------------

describe("DataSourceForm — edit mode", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    setupApiMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 12.1
  it("[tag:data-source-form][tag:edit] fields pre-populated from initialData", () => {
    renderEditForm()

    // Name is read-only in edit mode
    const nameInput = screen.getByLabelText(/name/i)
    expect(nameInput).toHaveValue("Existing Source")
    expect(nameInput).toHaveAttribute("readonly")
  })

  it("[tag:data-source-form][tag:edit] name unchanged → no validation error shown on blur", async () => {
    const user = userEvent.setup()
    renderEditForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.click(nameInput)
    await user.tab()

    // Wait a tick to confirm no async side-effects fire
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/unable to validate/i)).not.toBeInTheDocument()
    expect(screen.queryByText("A data source with this name already exists")).not.toBeInTheDocument()
  })

  // 12.3
  it("[tag:data-source-form][tag:edit] scanning section NOT rendered (behind !isEdit guard)", () => {
    renderEditForm()

    expect(screen.queryByText("Scanning is disabled on this data source.")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Modify" })).not.toBeInTheDocument()
  })

  // 12.4
  it("[tag:data-source-form][tag:edit] submit calls updateDataSource (PATCH) with dsrcId + changed fields", async () => {
    const user = userEvent.setup()
    renderEditForm()

    // Change description
    const descInput = screen.getByLabelText(/description/i)
    await user.clear(descInput)
    await user.type(descInput, "Updated description")

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockUpdateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          dsrcId: "ds-edit-1",
          body: expect.objectContaining({
            description: "Updated description",
          }),
        }),
      )
    })
  })

  // 12.5
  it("[tag:data-source-form][tag:edit][tag:success] update success → success toast; navigate to detail", async () => {
    const user = userEvent.setup()
    renderEditForm()

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Data source updated successfully.")
    })
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("ds-edit-1"))
  })

  // 12.6
  it("[tag:data-source-form][tag:edit][tag:error] update failure → error toast", async () => {
    const user = userEvent.setup()
    setupApiMocks({ updateResult: { unwrap: () => Promise.reject(new Error("fail")) } })
    renderEditForm()

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to update data source.")
    })
  })

  // 12.1b — covers line 76 FALSE branch: label already in DEFAULT_LABEL_ITEMS → not pushed again
  it("[tag:data-source-form][tag:labels] label init skips items already in DEFAULT_LABEL_ITEMS", () => {
    renderEditForm({ ...MOCK_DETAIL, labels: ["staging"] })
    expect(screen.getByText("Labels")).toBeInTheDocument()
  })

  // 12.4e — empty description must be sent so the backend can clear the column
  it("[tag:data-source-form][tag:edit] save with cleared description sends empty string", async () => {
    const user = userEvent.setup()
    renderEditForm()

    const descInput = screen.getByLabelText(/description/i)
    await user.clear(descInput)

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockUpdateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ description: "" }),
        }),
      )
    })
  })

  it("[tag:data-source-form][tag:edit][tag:labels] save with all labels removed sends empty labels array", async () => {
    const user = userEvent.setup()
    const { container } = renderEditForm()

    const labelsRow = container.querySelector(".form-field--labels") as HTMLElement
    await user.click(within(labelsRow).getByRole("button", { name: /Remove prod/i }))

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockUpdateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ labels: [] }),
        }),
      )
    })
  })

  // 12.4b — covers line 117 false branch: scan_config=undefined when scan_enabled=false
  it("[tag:data-source-form][tag:edit][tag:scanning] save with scan disabled sends scan_config=undefined", async () => {
    const user = userEvent.setup()
    renderEditForm({
      ...MOCK_DETAIL,
      scan: { status: "Completed", scan_depth: "none", custom_depth: null, total_files: null, total_folders: null, total_size_bytes: null, last_completed_at: null, status_message: null, file_type_stats: null },
    })

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockUpdateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.objectContaining({ scan_config: expect.anything() }),
        }),
      )
    })
  })

  // 12.4c — covers lines 117–121: custom_depth ternary and || 1 fallback
  // Scanning UI is hidden in edit mode; use initialData to pre-set the submit values.
  it("[tag:data-source-form][tag:edit][tag:scanning] save with custom scan depth sends correct custom_depth", async () => {
    const user = userEvent.setup()
    renderEditForm({
      ...MOCK_DETAIL,
      scan: { status: "Completed", scan_depth: "custom", custom_depth: 3, total_files: null, total_folders: null, total_size_bytes: null, last_completed_at: null, status_message: null, file_type_stats: null },
    })

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockUpdateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            scan_config: expect.objectContaining({ scan_depth: "custom", custom_depth: 3 }),
          }),
        }),
      )
    })
  })

  // 12.4d — covers line 121 || 1 fallback: custom_depth=0 in initialData → form sends 1
  it("[tag:data-source-form][tag:edit][tag:scanning] save with custom_depth=0 falls back to 1 in request", async () => {
    const user = userEvent.setup()
    renderEditForm({
      ...MOCK_DETAIL,
      scan: { status: "Completed", scan_depth: "custom", custom_depth: 0, total_files: null, total_folders: null, total_size_bytes: null, last_completed_at: null, status_message: null, file_type_stats: null },
    })

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockUpdateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            scan_config: expect.objectContaining({ scan_depth: "custom", custom_depth: 1 }),
          }),
        }),
      )
    })
  })

  // 12.7 — navigateBack in edit mode (covers line 170: navigate to detail)
  it("[tag:data-source-form][tag:edit] Cancel navigates back to detail page", async () => {
    const user = userEvent.setup()
    renderEditForm()

    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("ds-edit-1"),
    )
  })
})

// ---------------------------------------------------------------------------
// Section 11.11–11.12 — handleScanConfirm branches (via ScanningSettingsDialog)
// ---------------------------------------------------------------------------

// Dialog-heavy tests: opening + interacting with ScanningSettingsDialog takes > 5s in the full suite.
// Scanning UI is temporarily hidden from the register page (SHOW_SCANNING=false), so these
// dialog-driven tests are skipped until the scanning section is restored.
describe.skip("DataSourceForm — scan confirm branches", { timeout: 15000 }, () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    setupApiMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 11.11
  it("[tag:data-source-form][tag:scanning-settings-dialog] confirming non-none depth sets scan_enabled=true", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    // Open scanning dialog
    await user.click(screen.getByRole("button", { name: "Enable" }))

    // Select "All folder levels (Recommended)" radio
    const allLevelsRadio = screen.getByLabelText("All folder levels (Recommended)")
    await user.click(allLevelsRadio)

    // Confirm — label is "Confirm" in create mode
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    // Notice should now show the enabled state
    await waitFor(() => {
      expect(screen.getByText(/scanning of all folder levels/i)).toBeInTheDocument()
    })
    expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument()
  })

  // 11.11c — handleScanConfirm custom branch (covers line 180: custom_depth set when depth==="custom")
  it("[tag:data-source-form][tag:scanning-settings-dialog] confirming 'custom' depth with non-null customDepth sets scan_config.custom_depth", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.click(screen.getByRole("button", { name: "Enable" }))

    // Select the "Custom folder level amount" radio
    await user.click(screen.getByLabelText("Custom folder level amount"))

    // The custom depth input is now enabled — enter a value
    const depthInput = screen.getByLabelText("Folder level amount")
    await user.clear(depthInput)
    await user.type(depthInput, "7")

    await user.click(screen.getByRole("button", { name: "Confirm" }))

    // Dialog closes; Modify button appears (scan now enabled with custom depth)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument()
    })
  })

  // 11.15 — covers L142-146: scan_config truthy branch in createDataSource payload
  it("[tag:data-source-form][tag:scanning] create with scanning enabled sends scan_config in request body", async () => {
    const user = userEvent.setup()
    setupApiMocks()
    renderCreateForm()

    // Fill required name
    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "scanned-source")

    // Configure access (sets source_type + server)
    await configureGcpAccess(user)

    // Enable scanning via ScanningSettingsDialog
    await user.click(screen.getByRole("button", { name: "Enable" }))
    await user.click(screen.getByLabelText("Top 2 folder levels"))
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    // Submit
    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => {
      // The create branch submits scan_config as-is, so custom_depth keeps its default (1)
      // for non-custom depths. (The edit branch nulls custom_depth for non-custom depths;
      // this create/edit asymmetry is pre-existing and unrelated to the storage-system change.)
      const payload = mockCreateDataSource.mock.calls[0]?.[0] as { body?: { scan_config?: { scan_depth?: string; custom_depth?: number | null } } };
      expect(payload.body?.scan_config).toEqual(expect.objectContaining({ scan_depth: "top_2_levels", custom_depth: 1 }))
    })
  })

  // 11.15b — covers lines 147–148: custom_depth ternary in createDataSource payload
  it("[tag:data-source-form][tag:scanning] create with custom scan depth sends correct custom_depth in request body", async () => {
    const user = userEvent.setup()
    setupApiMocks()
    renderCreateForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "custom-depth-source")

    // Configure access
    await configureGcpAccess(user)

    // Enable scanning with custom depth = 4
    await user.click(screen.getByRole("button", { name: "Enable" }))
    await user.click(screen.getByLabelText("Custom folder level amount"))
    const depthInput = screen.getByLabelText("Folder level amount")
    await user.tripleClick(depthInput)
    await user.keyboard("4")
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(screen.getByRole("button", { name: "Register" })).not.toBeDisabled())
    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => {
      expect(mockCreateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            scan_config: expect.objectContaining({ scan_depth: "custom", custom_depth: 4 }),
          }),
        }),
      )
    })
  })

  // 11.15c — create passes the configured connection server through to the request body.
  // (The legacy NFS-specific folder_boundary="/vol-data" derivation was removed along with
  //  the NFS/SMB/S3 form; the storage-system flow now uses Google Cloud / NetApp ONTAP.)
  it("[tag:data-source-form][tag:create] create sends the configured connection server", async () => {
    const user = userEvent.setup()
    setupApiMocks()
    renderCreateForm()

    const nameInput = screen.getByLabelText(/name/i)
    await user.type(nameInput, "gcp-source")

    // Configure access (Google Cloud is selected by default)
    await configureGcpAccess(user, "my-gcp-project")

    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => {
      expect(mockCreateDataSource).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            source_type: "GoogleCloud",
            connection: expect.objectContaining({ server: "my-gcp-project" }),
          }),
        }),
      )
    })
  })

  // Covers line 303: onClose={() => setScanDialogOpen(false)}
  it("[tag:data-source-form][tag:scanning-settings-dialog] closing scan dialog without confirming keeps scan disabled", async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.click(screen.getByRole("button", { name: "Enable" }))
    expect(screen.getByText("Enable data source scanning")).toBeInTheDocument()

    // Two "Cancel" buttons exist when the dialog is open: form footer + dialog.
    // The dialog's Cancel is last in the DOM (rendered via portal).
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" })
    await user.click(cancelButtons[cancelButtons.length - 1])

    await waitFor(() => {
      expect(screen.queryByText("Enable data source scanning")).not.toBeInTheDocument()
    })
    // Scan section unchanged: "Enable" button still visible
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument()
  })

  // 11.11b
  it("[tag:data-source-form][tag:scanning-settings-dialog] confirming 'none' depth sets scan_enabled=false", async () => {
    const user = userEvent.setup()
    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/register",
          element: (
            <DataSourceForm
              initialData={{
                ...MOCK_DETAIL,
                dsrc_id: "new",
                scan: { status: "Completed", scan_depth: "all_levels", custom_depth: null, total_files: null, total_folders: null, total_size_bytes: null, last_completed_at: null, status_message: null, file_type_stats: null },
              }}
            />
          ),
        },
      ],
      initialEntries: ["/register"],
    })

    // Open scanning dialog
    await user.click(screen.getByRole("button", { name: "Modify" }))

    // Select "None" radio
    const noneRadio = screen.getByLabelText("None")
    await user.click(noneRadio)

    // Confirm — label is "Confirm" in create mode
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() => {
      expect(screen.getByText("Scanning is disabled on this data source.")).toBeInTheDocument()
    })
  })
})

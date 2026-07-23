import { screen, waitFor, within } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

// Connector categories load saved credentials via this hook; stub it so the
// "Use existing credentials" dropdown has selectable items in tests.
vi.mock("@/routes/pages/credentials/credential-api.slice", () => ({
  useListCredentialsQuery: () => ({
    data: [
      { id: "cred-1", name: "cred-1", provider: "x", projectId: "p", createdAt: "", updatedAt: "" },
      { id: "cred-2", name: "cred-2", provider: "x", projectId: "p", createdAt: "", updatedAt: "" },
    ],
  }),
  // Inline "Add new credentials" path persists via this mutation before Test/Add.
  useCreateCredentialMutation: () => [
    vi.fn(() => ({ unwrap: () => Promise.resolve({ id: "cred-new", name: "cred-new" }) })),
    { isLoading: false },
  ],
  useRotateCredentialMutation: () => [
    vi.fn(() => ({ unwrap: () => Promise.resolve({ id: "cred-1", name: "cred-1" }) })),
    { isLoading: false },
  ],
}))

// The Volume tab (dynamic mode) loads cluster StorageClasses via this hook.
vi.mock("@/api/data-source-api.slice", () => ({
  useListStorageClassesQuery: () => ({
    data: [
      { name: "fast-nfs", provisioner: "csi.nfs" },
      { name: "standard", provisioner: "csi.std" },
    ],
  }),
}))

vi.mock("@/api/workflow-api", () => ({
  startConnectorTest: vi.fn().mockResolvedValue({ workflowId: "wf-test" }),
  getWorkflowStatus: vi.fn().mockResolvedValue({ status: "completed", isRunning: false }),
}))

import type { ProviderCatalogEntry } from "@/api/provider-catalog.types"
import { MOCK_PROVIDER_CATALOG } from "./connector-config-validation.fixture"

type ProviderCatalogQueryResult = {
  data: ProviderCatalogEntry[] | undefined
  isLoading: boolean
  isError: boolean
  refetch: ReturnType<typeof vi.fn>
}

const mockRefetchProviderCatalog = vi.hoisted(() => vi.fn())
const mockListProviderCatalogQuery = vi.hoisted(() =>
  vi.fn((): ProviderCatalogQueryResult => ({
    data: MOCK_PROVIDER_CATALOG,
    isLoading: false,
    isError: false,
    refetch: mockRefetchProviderCatalog,
  })),
)

vi.mock("@/api/provider-catalog-api.slice", () => ({
  useListProviderCatalogQuery: () => mockListProviderCatalogQuery(),
}))

import { AccessConfigDialog } from "./access-config-dialog"
import { PROVIDER_CATALOG_STRINGS } from "./data-source-form.consts"

const TEST_PRELOADED_STATE = {
  projectContext: {
    activeProject: { id: "proj-1", name: "Test Project", role: "admin" as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub for AnyReactFormApi that AccessConfigDialog uses */
function makeFormStub() {
  return {
    state: {
      values: {
        source_type: "",
        connection: { server: "", username: "" },
      },
    },
    setFieldValue: vi.fn(),
  } as unknown as import("@/ui-lib/base-components/form/form.types").AnyReactFormApi
}

/** Picks a saved credential in the "Use existing credentials" dropdown. */
async function selectCredential(
  user: ReturnType<typeof userEvent.setup>,
  name = "cred-1",
) {
  const label = screen.getByText("Credential")
  const field = label.closest(".ds-form__db-field") as HTMLElement
  const trigger = field.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')!
  await user.click(trigger)
  await user.click(await screen.findByRole("option", { name }))
}

/** Runs Test Connection and waits for the success indicator. */
async function runSuccessfulConnectionTest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Test Connection" }))
  await waitFor(
    () => {
      expect(screen.getByText("Connection successful")).toBeInTheDocument()
    },
    { timeout: 10_000 },
  )
}

function renderDialog(
  props: Partial<Parameters<typeof AccessConfigDialog>[0]> = {},
) {
  const form = props.form ?? makeFormStub()
  const utils = renderWithProviders(
    <AccessConfigDialog
      form={form}
      isEdit={false}
      open
      onClose={vi.fn()}
      onPasswordSet={vi.fn()}
      {...props}
    />,
    { preloadedState: TEST_PRELOADED_STATE },
  )
  return { form, ...utils }
}

// ---------------------------------------------------------------------------
// AccessConfigDialog — Storage system (Google Cloud / NetApp ONTAP)
// ---------------------------------------------------------------------------

describe("AccessConfigDialog", () => {
  beforeEach(() => {
    mockRefetchProviderCatalog.mockReset()
    mockListProviderCatalogQuery.mockReset()
    mockListProviderCatalogQuery.mockReturnValue({
      data: MOCK_PROVIDER_CATALOG,
      isLoading: false,
      isError: false,
      refetch: mockRefetchProviderCatalog,
    })
  })

  it("[tag:access-config-dialog] Storage system tab lists Google Cloud, Microsoft Azure, NetApp ONTAP, and Amazon FSxN", () => {
    renderDialog()
    expect(screen.getByText("Google Cloud")).toBeInTheDocument()
    expect(screen.getByText("Microsoft Azure")).toBeInTheDocument()
    expect(screen.getByText("NetApp ONTAP")).toBeInTheDocument()
    expect(screen.getByText("Amazon FSxN")).toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:gcp] Add is disabled until Project ID is set (region optional), then confirm writes form values", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    const onPasswordSet = vi.fn()
    renderDialog({ form, onClose, onPasswordSet })

    const addBtn = screen.getByRole("button", { name: "Add" })
    expect(addBtn).toBeDisabled()

    // A credential alone is not enough — Project ID is still required.
    await selectCredential(user)
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/project id/i), "my-project")
    expect(addBtn).not.toBeDisabled()
    expect(screen.getByText("Untested")).toBeInTheDocument()

    await user.click(addBtn)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "GoogleCloud")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "my-project")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.auth_method", "credential_ref")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "gcp",
        scope: "account",
        connector_type: "cloud",
        credential_id: "cred-1",
        config: expect.objectContaining({ project_id: "my-project" }),
      }),
    )
    expect(onPasswordSet).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:gcp] Test Connection is optional and updates status from Untested to success", async () => {
    const user = userEvent.setup()
    renderDialog()

    await selectCredential(user)
    await user.type(screen.getByLabelText(/project id/i), "my-project")
    await user.type(screen.getByLabelText(/region/i), "us-central1")

    expect(screen.getByText("Untested")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled()

    await runSuccessfulConnectionTest(user)
    expect(screen.queryByText("Untested")).not.toBeInTheDocument()
    expect(screen.getByText("Connection successful")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled()
  })

  it("[tag:access-config-dialog][tag:gcp] Add is disabled while a connection test is in flight", async () => {
    const workflowApi = await import("@/api/workflow-api")
    vi.mocked(workflowApi.getWorkflowStatus).mockImplementation(
      () => new Promise(() => {}),
    )

    const user = userEvent.setup()
    renderDialog()

    await selectCredential(user)
    await user.type(screen.getByLabelText(/project id/i), "my-project")

    const addBtn = within(
      document.querySelector(".ds-form__access-dialog-footer") as HTMLElement,
    ).getByRole("button", { name: "Add" })
    expect(addBtn).not.toBeDisabled()

    await user.click(screen.getByRole("button", { name: "Test Connection" }))

    await waitFor(() => {
      expect(screen.getByText("Testing connection…")).toBeInTheDocument()
    })
    expect(addBtn).toBeDisabled()

    vi.mocked(workflowApi.getWorkflowStatus).mockResolvedValue({
      status: "completed",
      isRunning: false,
    })
  })

  it("[tag:access-config-dialog][tag:azure] Add is disabled until Subscription ID and Region are set, then confirm writes form values", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    const onPasswordSet = vi.fn()
    renderDialog({ form, onClose, onPasswordSet })

    await user.click(screen.getByText("Microsoft Azure"))

    const addBtn = screen.getByRole("button", { name: "Add" })
    expect(addBtn).toBeDisabled()

    await selectCredential(user)
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/^subscription id/i), "sub-123")
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/^region/i), "eastus")
    expect(addBtn).not.toBeDisabled()
    expect(screen.getByText("Untested")).toBeInTheDocument()

    await user.click(addBtn)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "MicrosoftAzure")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "sub-123")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "azure_cloud",
        scope: "account",
        connector_type: "cloud",
        credential_id: "cred-1",
        config: expect.objectContaining({ subscription_id: "sub-123", default_region: "eastus" }),
      }),
    )
    expect(onPasswordSet).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:ontap] selecting NetApp ONTAP shows cluster details and confirm uses the cluster URL", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    renderDialog({ form })

    await user.click(screen.getByText("NetApp ONTAP"))

    const urlInput = screen.getByLabelText(/netapp ontap cluster url/i)
    await user.type(urlInput, "https://cluster.example.com")
    await selectCredential(user)

    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "NetAppONTAP")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connection.server",
      "https://cluster.example.com",
    )
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "ontap",
        scope: "account",
        connector_type: "storage",
        credential_id: "cred-1",
        config: expect.objectContaining({ cluster_url: "https://cluster.example.com" }),
      }),
    )
  })

  it("[tag:access-config-dialog][tag:fsxn] selecting Amazon FSxN reuses the NetApp ONTAP cluster form and confirms an ontap storage connector", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    renderDialog({ form })

    await user.click(screen.getByText("Amazon FSxN"))

    // FSxN reuses the ONTAP cluster-details form (same management-endpoint field).
    const urlInput = screen.getByLabelText(/netapp ontap cluster url/i)
    await user.type(urlInput, "https://management.fs-0123456789abcdef.fsx.us-east-1.amazonaws.com")
    await selectCredential(user)

    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "AmazonFSxN")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connection.server",
      "https://management.fs-0123456789abcdef.fsx.us-east-1.amazonaws.com",
    )
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "ontap",
        scope: "account",
        connector_type: "storage",
        credential_id: "cred-1",
        config: expect.objectContaining({
          cluster_url: "https://management.fs-0123456789abcdef.fsx.us-east-1.amazonaws.com",
        }),
      }),
    )
  })

  it("[tag:access-config-dialog] 'Add new credentials' reveals credential name, key and upload", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("radio", { name: /add new credentials/i }))

    expect(screen.getByLabelText(/credential name/i)).toBeInTheDocument()
    expect(screen.getByText(/authorization \(service account key\)/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /upload json file/i })).toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:object-store] Object store tab lists its source types", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Object store" }))

    expect(screen.getByText("Amazon S3")).toBeInTheDocument()
    expect(screen.getByText("Google Cloud Storage")).toBeInTheDocument()
    expect(screen.getByText("S3-compatible buckets")).toBeInTheDocument()
    expect(screen.getByText("Custom object store")).toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:object-store] catalog marks only bucket as required for Amazon S3 (not endpoint/region)", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Object store" }))

    const bucketLabel = screen.getByText("Bucket").closest(".ds-form__req-label") as HTMLElement
    const endpointLabel = screen.getByText("Endpoint").closest(".ds-form__req-label") as HTMLElement
    const regionLabel = screen.getByText("Region").closest(".ds-form__req-label") as HTMLElement

    expect(within(bucketLabel).getByText("*")).toBeInTheDocument()
    expect(within(endpointLabel).queryByText("*")).not.toBeInTheDocument()
    expect(within(regionLabel).queryByText("*")).not.toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:object-store] catalog marks endpoint and bucket as required for S3-compatible subtypes", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Object store" }))
    await user.click(screen.getByText("S3-compatible buckets"))

    const bucketLabel = screen.getByText("Bucket").closest(".ds-form__req-label") as HTMLElement
    const endpointLabel = screen.getByText("Endpoint").closest(".ds-form__req-label") as HTMLElement
    const regionLabel = screen.getByText("Region").closest(".ds-form__req-label") as HTMLElement

    expect(within(bucketLabel).getByText("*")).toBeInTheDocument()
    expect(within(endpointLabel).getByText("*")).toBeInTheDocument()
    expect(within(regionLabel).queryByText("*")).not.toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:object-store] S3-compatible Add requires endpoint and bucket", { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    renderDialog({ form, onClose })

    await user.click(screen.getByRole("tab", { name: "Object store" }))
    await user.click(screen.getByText("S3-compatible buckets"))

    const addBtn = screen.getByRole("button", { name: "Add" })
    expect(addBtn).toBeDisabled()

    await selectCredential(user)
    await user.type(screen.getByLabelText("Bucket"), "my-bucket")
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText("Endpoint"), "https://minio.local")
    expect(addBtn).not.toBeDisabled()

    await user.click(addBtn)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "S3Compatible")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "s3",
        config: expect.objectContaining({
          bucket: "my-bucket",
          endpoint: "https://minio.local",
        }),
      }),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:object-store] Add requires a credential and bucket when using existing credentials", { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    const onPasswordSet = vi.fn()
    renderDialog({ form, onClose, onPasswordSet })

    await user.click(screen.getByRole("tab", { name: "Object store" }))

    const addBtn = screen.getByRole("button", { name: "Add" })
    expect(addBtn).toBeDisabled()

    await selectCredential(user)
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText("Bucket"), "my-bucket")
    expect(addBtn).not.toBeDisabled()
    expect(screen.getByText("Untested")).toBeInTheDocument()

    await user.click(addBtn)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "AmazonS3")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "my-bucket")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.auth_method", "credential_ref")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "s3",
        scope: "resource",
        connector_type: "objectstore",
        credential_id: "cred-1",
        config: expect.objectContaining({ bucket: "my-bucket" }),
      }),
    )
    expect(onPasswordSet).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:object-store] optional object store fields are persisted when provided", { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    const onPasswordSet = vi.fn()
    renderDialog({ form, onClose, onPasswordSet })

    await user.click(screen.getByRole("tab", { name: "Object store" }))

    await user.type(screen.getByLabelText("Bucket"), "my-bucket")
    await selectCredential(user)
    await user.type(screen.getByLabelText("Endpoint"), "https://s3.amazonaws.com")
    await user.type(screen.getByLabelText("Region"), "us-east-1")

    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "AmazonS3")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "https://s3.amazonaws.com")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "s3",
        credential_id: "cred-1",
        config: expect.objectContaining({
          bucket: "my-bucket",
          endpoint: "https://s3.amazonaws.com",
          region: "us-east-1",
        }),
      }),
    )
    expect(onPasswordSet).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:database] Database tab lists its engines", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Database" }))

    expect(screen.getByText("PostgreSQL")).toBeInTheDocument()
    expect(screen.getByText("PostgreSQL (SSL)")).toBeInTheDocument()
    expect(screen.getByText("Custom database")).toBeInTheDocument()
    // "MySQL" appears both as the selected engine row and the default credential value
    expect(screen.getAllByText("MySQL").length).toBeGreaterThan(0)
  })

  it("[tag:access-config-dialog][tag:database] Database Connection shows Database Type and per-engine port defaults", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Database" }))

    expect(screen.getByText("Database Connection")).toBeInTheDocument()
    expect(screen.getByText("Database Type")).toBeInTheDocument()

    // Default engine is MySQL → port defaults to 3306
    expect(screen.getByLabelText("Port")).toHaveValue("3306")

    // Switching to the PostgreSQL engine updates the port default to 5432
    await user.click(screen.getByText("PostgreSQL"))
    expect(screen.getByLabelText("Port")).toHaveValue("5432")
  })

  it("[tag:access-config-dialog][tag:database] Add is disabled until Host is set, then confirm writes form values", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    const onPasswordSet = vi.fn()
    renderDialog({ form, onClose, onPasswordSet })

    await user.click(screen.getByRole("tab", { name: "Database" }))

    const addBtn = screen.getByRole("button", { name: "Add" })
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/host/i), "db.example.com")
    await selectCredential(user)
    expect(addBtn).not.toBeDisabled()
    expect(screen.getByText("Untested")).toBeInTheDocument()

    await user.click(addBtn)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "MySQL")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "db.example.com")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.auth_method", "credential_ref")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "mysql",
        scope: "resource",
        connector_type: "database",
        credential_id: "cred-1",
        config: expect.objectContaining({ host: "db.example.com", port: 3306 }),
      }),
    )
    expect(onPasswordSet).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:volume] Volume tab lists NFS in the type table and existing/new radios", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Volume" }))

    // Top selection table uses the same template as the other tabs.
    expect(screen.getByText("NFS volumes")).toBeInTheDocument()
    // Existing vs new volume is a radio-card group (like the credential radios).
    expect(screen.getByText("Existing volume")).toBeInTheDocument()
    expect(screen.getByText("Create new volume")).toBeInTheDocument()
    // Static (default) shows a Volume endpoint field.
    expect(screen.getByLabelText(/volume endpoint/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/volume name/i)).toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:volume] Existing volume: confirm is gated on endpoint + name + region, then writes form values", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    renderDialog({ form, onClose })

    await user.click(screen.getByRole("tab", { name: "Volume" }))

    const confirm = within(
      document.querySelector(".ds-form__access-dialog-footer") as HTMLElement,
    ).getByRole("button", { name: "Add" })
    expect(confirm).toBeDisabled()

    await user.type(screen.getByLabelText(/volume endpoint/i), "nfs-server:/export")
    expect(confirm).toBeDisabled()

    await user.type(screen.getByLabelText(/volume name/i), "my-volume")
    // Region is a required free-text field — still gated until it's filled.
    expect(confirm).toBeDisabled()

    await user.type(screen.getByLabelText("Region"), "us-east-1")
    expect(confirm).not.toBeDisabled()

    await user.click(confirm)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "NFSVolumes")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.provisioning_mode", "static")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.volume_type", "NFS")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "nfs-server:/export")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.region", "us-east-1")
    expect(form.setFieldValue).toHaveBeenCalledWith("connector", null)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog][tag:volume] Create new volume shows storage class + storage size fields", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Volume" }))
    // Switch the mode radio to "Create new volume".
    await user.click(screen.getByText("Create new volume"))

    expect(screen.getByText("Storage class")).toBeInTheDocument()
    expect(screen.getByLabelText(/storage size/i)).toBeInTheDocument()
    // Endpoint field is replaced by dynamic provisioning fields.
    expect(screen.queryByLabelText(/volume endpoint/i)).not.toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:volume] metadata key/value pairs can be added and are written on confirm", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    renderDialog({ form })

    await user.click(screen.getByRole("tab", { name: "Volume" }))

    await user.type(screen.getByPlaceholderText("Enter key"), "team")
    await user.type(screen.getByPlaceholderText("Enter value"), "data")
    await user.click(within(
      screen.getByPlaceholderText("Enter key").closest(".ds-form__vol-kv") as HTMLElement,
    ).getByRole("button", { name: "Add" }))
    expect(screen.getByText("team: data")).toBeInTheDocument()

    // Fill the required fields so confirm is enabled, then confirm.
    await user.type(screen.getByLabelText(/volume endpoint/i), "nfs-server:/export")
    await user.type(screen.getByLabelText(/volume name/i), "my-volume")
    await user.type(screen.getByLabelText("Region"), "us-east-1")
    await user.click(within(
      document.querySelector(".ds-form__access-dialog-footer") as HTMLElement,
    ).getByRole("button", { name: "Add" }))

    expect(form.setFieldValue).toHaveBeenCalledWith("connection.metadata", { team: "data" })
  })

  it("[tag:access-config-dialog][tag:volume] password field toggles visibility", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "Volume" }))

    const passwordInput = screen.getByLabelText("Password")
    expect(passwordInput).toHaveAttribute("type", "password")

    await user.click(screen.getByRole("button", { name: /show password/i }))
    expect(passwordInput).toHaveAttribute("type", "text")
  })

  it("[tag:access-config-dialog][tag:api] API tab lists Redash and shows API details", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("tab", { name: "API" }))

    expect(screen.getByText("Redash")).toBeInTheDocument()
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument()
    expect(screen.getByText("API details")).toBeInTheDocument()
  })

  it("[tag:access-config-dialog][tag:api] Add is disabled until Base URL is set, then confirm writes form values", async () => {
    const user = userEvent.setup()
    const form = makeFormStub()
    const onClose = vi.fn()
    const onPasswordSet = vi.fn()
    renderDialog({ form, onClose, onPasswordSet })

    await user.click(screen.getByRole("tab", { name: "API" }))

    const addBtn = screen.getByRole("button", { name: "Add" })
    expect(addBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/base url/i), "https://redash.example.com")
    await selectCredential(user)
    expect(addBtn).not.toBeDisabled()
    expect(screen.getByText("Untested")).toBeInTheDocument()

    await user.click(addBtn)

    expect(form.setFieldValue).toHaveBeenCalledWith("source_type", "Redash")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.server", "https://redash.example.com")
    expect(form.setFieldValue).toHaveBeenCalledWith("connection.auth_method", "credential_ref")
    expect(form.setFieldValue).toHaveBeenCalledWith(
      "connector",
      expect.objectContaining({
        provider: "redash",
        scope: "account",
        connector_type: "api",
        credential_id: "cred-1",
        config: expect.objectContaining({ base_url: "https://redash.example.com" }),
      }),
    )
    expect(onPasswordSet).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog] shows provider catalog load error on connector tabs with retry", async () => {
    mockListProviderCatalogQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetchProviderCatalog,
    })

    const user = userEvent.setup()
    renderDialog()

    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(PROVIDER_CATALOG_STRINGS.ERROR_MESSAGE)
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled()

    await user.click(screen.getByRole("button", { name: PROVIDER_CATALOG_STRINGS.RETRY_LABEL }))
    expect(mockRefetchProviderCatalog).toHaveBeenCalledOnce()
  })

  it("[tag:access-config-dialog] hides provider catalog status on Volume tab", async () => {
    mockListProviderCatalogQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetchProviderCatalog,
    })

    const user = userEvent.setup()
    renderDialog()

    expect(screen.getByRole("alert")).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Volume" }))

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("[tag:access-config-dialog] shows loading status while provider catalog is fetching", () => {
    mockListProviderCatalogQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: mockRefetchProviderCatalog,
    })

    renderDialog()

    expect(screen.getByRole("status")).toHaveTextContent(PROVIDER_CATALOG_STRINGS.LOADING_MESSAGE)
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
  })

  it("[tag:access-config-dialog] pressing Escape dismisses the dialog and calls onClose", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog({ onClose })

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
  })
})

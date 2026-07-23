import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { Credential } from "../credential.types"

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the component
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockBlocker = vi.fn().mockReturnValue({ state: "unblocked" })

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useBlocker: (...args: unknown[]) => mockBlocker(...args),
  }
})

const mockCreateCredential = vi.fn()
const mockUpdateCredential = vi.fn()

vi.mock("../credential-api.slice", () => ({
  useCreateCredentialMutation: () => [mockCreateCredential, { isLoading: false }],
  useUpdateCredentialMutation: () => [mockUpdateCredential, { isLoading: false }],
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock("@/components/credential-secret-fields/credential-secret-fields", () => ({
  CredentialSecretFields: ({
    onChange,
  }: {
    provider: string
    secretData: Record<string, string>
    onChange: (d: Record<string, string>) => void
    metadata?: Record<string, string>
    onMetadataChange?: (m: Record<string, string>) => void
    disabled?: boolean
  }) => (
    <div data-testid="credential-secret-fields">
      <button
        type="button"
        data-testid="set-secret"
        onClick={() => onChange({ api_key: "sk-test-key" })}
      >
        Set secret
      </button>
    </div>
  ),
}))

import { CredentialForm } from "./credential-form"
import { toast } from "@/ui-lib/base-components/toast/toast"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CREDENTIAL: Credential = {
  id: "cred-abc",
  projectId: "proj-1",
  name: "my-openai-key",
  description: "Test credential",
  provider: "openai",
  labels: ["prod", "llm"],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function renderCreateForm() {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/credentials/new", element: <CredentialForm /> },
      { path: "/credentials", element: <div data-testid="credentials-list" /> },
    ],
    initialEntries: ["/credentials/new"],
  })
}

function renderEditForm(initialData = MOCK_CREDENTIAL) {
  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: "/credentials/:credId/edit",
        element: <CredentialForm isEdit initialData={initialData} />,
      },
      { path: "/credentials", element: <div data-testid="credentials-list" /> },
    ],
    initialEntries: [`/credentials/${initialData.id}/edit`],
  })
}

// ---------------------------------------------------------------------------
// Tests — create mode
// ---------------------------------------------------------------------------

describe("CredentialForm — create mode", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    mockBlocker.mockReturnValue({ state: "unblocked" })
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:credential-form][tag:create] renders page title 'Add credential'", () => {
    renderCreateForm()

    expect(screen.getByRole("heading", { level: 1, name: /add credential/i })).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:create] renders name, description, labels, and date fields", () => {
    renderCreateForm()

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/labels/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/expires on/i)).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:create] renders CredentialSecretFields in create mode", () => {
    renderCreateForm()

    expect(screen.getByTestId("credential-secret-fields")).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:create] cancel button navigates back to credentials list", async () => {
    renderCreateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /cancel/i }))

    expect(mockNavigate).toHaveBeenCalledWith("/credentials")
  })

  it("[tag:credential-form][tag:create] close (X) button navigates back", async () => {
    renderCreateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /close/i }))

    expect(mockNavigate).toHaveBeenCalledWith("/credentials")
  })

  it("[tag:credential-form][tag:create][tag:validation] shows error when name is empty on submit", async () => {
    renderCreateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /^add$/i }))

    expect(toast.error).toHaveBeenCalledWith("Name is required")
  })

  it("[tag:credential-form][tag:create][tag:validation] shows error when no secrets provided", async () => {
    renderCreateForm()

    const user = userEvent.setup({ delay: null })
    await user.type(screen.getByLabelText(/name/i), "my-key")
    await user.click(screen.getByRole("button", { name: /^add$/i }))

    // The openai preset requires api_key, so expect a missing fields error
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/required fields missing/i),
    )
  })

  it("[tag:credential-form][tag:create][tag:submit] submits successfully and navigates back", async () => {
    mockCreateCredential.mockReturnValue({ unwrap: () => Promise.resolve({}) })

    renderCreateForm()

    const user = userEvent.setup({ delay: null })
    await user.type(screen.getByLabelText(/name/i), "my-openai-key")
    await user.click(screen.getByTestId("set-secret"))
    await user.click(screen.getByRole("button", { name: /^add$/i }))

    await waitFor(() => {
      expect(mockCreateCredential).toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalledWith("Credential added successfully.")
    })
  })

  it("[tag:credential-form][tag:create][tag:submit] shows error toast on create failure", async () => {
    mockCreateCredential.mockRejectedValue(new Error("server error"))

    renderCreateForm()

    const user = userEvent.setup({ delay: null })
    await user.type(screen.getByLabelText(/name/i), "my-openai-key")
    await user.click(screen.getByTestId("set-secret"))
    await user.click(screen.getByRole("button", { name: /^add$/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to add credential.")
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — edit mode
// ---------------------------------------------------------------------------

describe("CredentialForm — edit mode", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    mockBlocker.mockReturnValue({ state: "unblocked" })
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:credential-form][tag:edit] renders page title 'Edit credential'", () => {
    renderEditForm()

    expect(screen.getByRole("heading", { level: 1, name: /edit credential/i })).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:edit] pre-fills name field with existing value", () => {
    renderEditForm()

    expect(screen.getByDisplayValue("my-openai-key")).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:edit] pre-fills description field", () => {
    renderEditForm()

    expect(screen.getByDisplayValue("Test credential")).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:edit] pre-fills labels field", () => {
    renderEditForm()

    expect(screen.getByDisplayValue("prod, llm")).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:edit] shows provider as read-only text, not dropdown", () => {
    renderEditForm()

    // Provider shown as readonly text, not the SelectDropdown
    expect(screen.queryByRole("combobox", { name: /provider/i })).not.toBeInTheDocument()
    // The provider label is shown as text
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("[tag:credential-form][tag:edit] does not render CredentialSecretFields in edit mode", () => {
    renderEditForm()

    // In edit mode, secret fields are write-only, so CredentialSecretFields is not shown
    expect(screen.queryByTestId("credential-secret-fields")).not.toBeInTheDocument()
  })

  it("[tag:credential-form][tag:edit][tag:submit] updates credential and navigates back", async () => {
    mockUpdateCredential.mockReturnValue({ unwrap: () => Promise.resolve({}) })

    renderEditForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateCredential).toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalledWith("Credential updated successfully.")
    })
  })

  it("[tag:credential-form][tag:edit][tag:submit] shows error toast on update failure", async () => {
    mockUpdateCredential.mockRejectedValue(new Error("network error"))

    renderEditForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to update credential.")
    })
  })

  it("[tag:credential-form][tag:edit][tag:blocker] renders discard dialog when navigation is blocked", () => {
    mockBlocker.mockReturnValue({ state: "blocked", proceed: vi.fn(), reset: vi.fn() })

    renderEditForm()

    expect(screen.getByText("Discard changes?")).toBeInTheDocument()
  })
})

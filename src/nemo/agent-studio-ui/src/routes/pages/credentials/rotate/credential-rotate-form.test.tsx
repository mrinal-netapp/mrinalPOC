import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { Credential } from "../credential.types"

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the component
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

const mockRotateCredential = vi.fn()

vi.mock("../credential-api.slice", () => ({
  useRotateCredentialMutation: () => [mockRotateCredential, { isLoading: false }],
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
    disabled?: boolean
  }) => (
    <div data-testid="credential-secret-fields">
      <button
        type="button"
        data-testid="set-secret"
        onClick={() => onChange({ api_key: "sk-new-key" })}
      >
        Set secret
      </button>
    </div>
  ),
}))

import { CredentialRotateForm } from "./credential-rotate-form"
import { toast } from "@/ui-lib/base-components/toast/toast"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPENAI_CREDENTIAL: Credential = {
  id: "cred-abc",
  projectId: "proj-1",
  name: "openai-key",
  provider: "openai",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

const CUSTOM_CREDENTIAL: Credential = {
  id: "cred-custom",
  projectId: "proj-1",
  name: "custom-cred",
  provider: "my-custom-provider",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function renderRotateForm(credential = OPENAI_CREDENTIAL) {
  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: "/credentials/:credId/rotate",
        element: <CredentialRotateForm credential={credential} />,
      },
      { path: "/credentials", element: <div data-testid="credentials-list" /> },
    ],
    initialEntries: [`/credentials/${credential.id}/rotate`],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialRotateForm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:credential-rotate-form] renders heading with credential name", () => {
    renderRotateForm()

    expect(screen.getByRole("heading", { level: 2, name: "openai-key" })).toBeInTheDocument()
  })

  it("[tag:credential-rotate-form] renders 'Rotate secrets' title in top bar", () => {
    renderRotateForm()

    expect(screen.getByRole("heading", { level: 1, name: /rotate secrets/i })).toBeInTheDocument()
  })

  it("[tag:credential-rotate-form] renders CredentialSecretFields", () => {
    renderRotateForm()

    expect(screen.getByTestId("credential-secret-fields")).toBeInTheDocument()
  })

  it("[tag:credential-rotate-form] renders provider as read-only label (OpenAI)", () => {
    renderRotateForm()

    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("[tag:credential-rotate-form] cancel button navigates back to credentials list", async () => {
    renderRotateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /cancel/i }))

    expect(mockNavigate).toHaveBeenCalledWith("/credentials")
  })

  it("[tag:credential-rotate-form] close (X) button navigates back", async () => {
    renderRotateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /close/i }))

    expect(mockNavigate).toHaveBeenCalledWith("/credentials")
  })

  it("[tag:credential-rotate-form][tag:validation] shows error when required fields missing (preset provider)", async () => {
    // openai preset requires api_key but we don't fill it
    renderRotateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /rotate secrets/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/required fields missing/i),
      )
    })
  })

  it("[tag:credential-rotate-form][tag:validation] shows error for custom provider with no key-value", async () => {
    renderRotateForm(CUSTOM_CREDENTIAL)

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: /rotate secrets/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Add at least one key/value secret field.")
    })
  })

  it("[tag:credential-rotate-form][tag:submit] rotates secrets successfully", async () => {
    mockRotateCredential.mockReturnValue({ unwrap: () => Promise.resolve({}) })

    renderRotateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByTestId("set-secret"))
    await user.click(screen.getByRole("button", { name: /rotate secrets/i }))

    await waitFor(() => {
      expect(mockRotateCredential).toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/rotated successfully/i),
      )
      expect(mockNavigate).toHaveBeenCalledWith("/credentials")
    })
  })

  it("[tag:credential-rotate-form][tag:submit] shows error toast on rotate failure", async () => {
    mockRotateCredential.mockReturnValue({ unwrap: () => Promise.reject(new Error("network error")) })

    renderRotateForm()

    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByTestId("set-secret"))
    await user.click(screen.getByRole("button", { name: /rotate secrets/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed to rotate/i),
      )
    })
  })
})

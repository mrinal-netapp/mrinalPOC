import { screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"

import { ModelProviderConfigureModal } from "./model-provider-configure-modal"

const PROJECT_STATE = {
  projectContext: { activeProject: { id: "proj-1", name: "Project One", role: "admin" } },
} as const

type Route = { match: string | RegExp; data: unknown; status?: number }

const LIST_EMPTY: Route = { match: "/credentials?", data: [] }
const LIST_ONE: Route = {
  match: "/credentials?",
  data: [{ id: "cred-existing", name: "existing-key", provider: "openai" }],
}
const VALIDATE_OK: Route = { match: "/credentials/validate", data: { valid: true } }
const CREATE_OK: Route = { match: "/credentials", data: { id: "cred-123", name: "my-openai" } }

function fetchUrls(mock: Mock): string[] {
  return mock.mock.calls.map((c) => {
    const first = c[0] as unknown
    return typeof first === "string" ? first : String((first as { url?: string })?.url ?? first)
  })
}

function renderProvidersModal(
  overrides: Partial<{
    onSave: (id?: string) => void
    onOpenChange: (open: boolean) => void
    providerId: string
    providerName: string
  }> = {},
) {
  const onSave = overrides.onSave ?? vi.fn()
  const onOpenChange = overrides.onOpenChange ?? vi.fn()
  renderWithProviders(
    <ModelProviderConfigureModal
      open
      onOpenChange={onOpenChange}
      flow="providers"
      providerId={overrides.providerId ?? "openai"}
      providerName={overrides.providerName ?? "OpenAI"}
      onSave={onSave}
    />,
    { preloadedState: PROJECT_STATE },
  )
  return { onSave, onOpenChange }
}

describe("ModelProviderConfigureModal", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => {
    roCleanup?.()
    restoreAllMocks()
    vi.clearAllMocks()
  })

  it("[tag:configure-modal] validates raw credentials before persisting, then saves", async () => {
    const fetchMock = mockFetchByUrl([VALIDATE_OK, LIST_EMPTY, CREATE_OK])
    const { onSave, onOpenChange } = renderProvidersModal()

    const nameInput = await screen.findByPlaceholderText("e.g. azure-openai-prod")
    await userEvent.type(nameInput, "my-openai")
    await userEvent.type(screen.getByPlaceholderText("sk-..."), "sk-secret")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("cred-123"))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    const urls = fetchUrls(fetchMock)
    const validateIdx = urls.findIndex((u) => u.includes("/credentials/validate"))
    const createIdx = urls.findIndex((u) => /\/credentials$/.test(u))
    expect(validateIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeGreaterThan(validateIdx)
  })

  it("[tag:configure-modal] surfaces the provider's rejection and never persists invalid credentials", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/credentials/validate", data: { valid: false, error: "Invalid API key" } },
      LIST_EMPTY,
      CREATE_OK,
    ])
    const { onSave } = renderProvidersModal()

    await userEvent.type(await screen.findByPlaceholderText("e.g. azure-openai-prod"), "my-openai")
    await userEvent.type(screen.getByPlaceholderText("sk-..."), "bad-key")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
    expect(fetchUrls(fetchMock).some((u) => /\/credentials$/.test(u))).toBe(false)
  })

  it("[tag:configure-modal] reports a reachability failure when validation errors out", async () => {
    mockFetchByUrl([
      { match: "/credentials/validate", data: { error: "boom" }, status: 500 },
      LIST_EMPTY,
      CREATE_OK,
    ])
    const { onSave } = renderProvidersModal()

    await userEvent.type(await screen.findByPlaceholderText("e.g. azure-openai-prod"), "my-openai")
    await userEvent.type(screen.getByPlaceholderText("sk-..."), "sk-secret")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(
      await screen.findByText(
        "Couldn't reach the provider to validate the connection. Please try again.",
      ),
    ).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:configure-modal] surfaces a create failure after a successful validation", async () => {
    mockFetchByUrl([
      VALIDATE_OK,
      LIST_EMPTY,
      { match: "/credentials", data: { error: "Name already exists" }, status: 409 },
    ])
    const { onSave } = renderProvidersModal()

    await userEvent.type(await screen.findByPlaceholderText("e.g. azure-openai-prod"), "dupe")
    await userEvent.type(screen.getByPlaceholderText("sk-..."), "sk-secret")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Name already exists")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:configure-modal] requires a credential name before validating", async () => {
    const fetchMock = mockFetchByUrl([VALIDATE_OK, LIST_EMPTY, CREATE_OK])
    const { onSave } = renderProvidersModal()

    await screen.findByPlaceholderText("e.g. azure-openai-prod")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Enter a name for this credential.")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
    expect(fetchUrls(fetchMock).some((u) => u.includes("/credentials/validate"))).toBe(false)
  })

  it("[tag:configure-modal] requires the provider's mandatory secret fields", async () => {
    mockFetchByUrl([VALIDATE_OK, LIST_EMPTY, CREATE_OK])
    const { onSave } = renderProvidersModal()

    await userEvent.type(await screen.findByPlaceholderText("e.g. azure-openai-prod"), "my-openai")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText(/Fill in required fields: API Key\./)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:configure-modal] requires a selection in the 'use existing' mode", async () => {
    mockFetchByUrl([VALIDATE_OK, LIST_ONE, CREATE_OK])
    const { onSave } = renderProvidersModal()

    // With saved credentials present the modal defaults to the existing-credential tab.
    await userEvent.click(await screen.findByRole("button", { name: "Save" }))
    expect(await screen.findByText("Select a credential to continue.")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:configure-modal] shows Azure-specific guidance for the azure-openai alias", async () => {
    mockFetchByUrl([LIST_EMPTY])
    renderProvidersModal({ providerId: "azure-openai", providerName: "Azure OpenAI" })

    expect(
      await screen.findByText(/Set the Azure endpoint and an API version/),
    ).toBeInTheDocument()
  })

  it("[tag:configure-modal] self-hosted flow validates via the Validate action and closes", async () => {
    const onSave = vi.fn()
    const onOpenChange = vi.fn()
    renderWithProviders(
      <ModelProviderConfigureModal
        open
        onOpenChange={onOpenChange}
        flow="self-hosted"
        providerId={null}
        providerName={null}
        onSave={onSave}
      />,
      { preloadedState: PROJECT_STATE },
    )

    expect(await screen.findByText("Configure self-hosted model server")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Validate" }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

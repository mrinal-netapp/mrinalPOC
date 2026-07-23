import { screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"

import { ProviderProxyModal, type ProviderProxyTarget } from "./provider-proxy-modal"

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}))

const PROVIDER: ProviderProxyTarget = {
  provider_id: "openai",
  name: "OpenAI",
  concurrent_requests: 1000,
  buffer_size: 5000,
}

const PROJECT_STATE = {
  projectContext: { activeProject: { id: "proj-1", name: "Project One", role: "admin" } },
} as const

describe("ProviderProxyModal", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    mockFetchByUrl([{ match: "/providers/openai", data: { success: true, provider: {} } }])
  })
  afterEach(() => {
    roCleanup?.()
    restoreAllMocks()
    vi.clearAllMocks()
  })

  it("[tag:provider-proxy] does not render the body when closed or provider is null", () => {
    const { rerender } = renderWithProviders(
      <ProviderProxyModal open={false} onOpenChange={() => {}} projectId="proj-1" provider={PROVIDER} />,
      { preloadedState: PROJECT_STATE },
    )
    expect(screen.queryByText("Edit proxy configuration")).not.toBeInTheDocument()

    rerender(
      <ProviderProxyModal open onOpenChange={() => {}} projectId="proj-1" provider={null} />,
    )
    expect(screen.queryByText("Edit proxy configuration")).not.toBeInTheDocument()
  })

  it("[tag:provider-proxy] seeds the inputs from the provider row", async () => {
    renderWithProviders(
      <ProviderProxyModal open onOpenChange={() => {}} projectId="proj-1" provider={PROVIDER} />,
      { preloadedState: PROJECT_STATE },
    )
    expect(await screen.findByText("Edit proxy configuration")).toBeInTheDocument()
    expect(screen.getByLabelText("Concurrent requests")).toHaveValue(1000)
    expect(screen.getByLabelText("Buffer size")).toHaveValue(5000)
  })

  it("[tag:provider-proxy] PUTs the edited values, toasts success and closes", async () => {
    const onOpenChange = vi.fn()
    const fetchMock = mockFetchByUrl([
      { match: "/providers/openai", data: { success: true, provider: {} } },
    ])
    renderWithProviders(
      <ProviderProxyModal open onOpenChange={onOpenChange} projectId="proj-1" provider={PROVIDER} />,
      { preloadedState: PROJECT_STATE },
    )
    await screen.findByText("Edit proxy configuration")

    const bufferInput = screen.getByLabelText("Buffer size")
    await userEvent.clear(bufferInput)
    await userEvent.type(bufferInput, "8000")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled())
    const putCall = fetchMock.mock.calls.find(
      ([input]) => (input as Request)?.method === "PUT",
    )
    expect(putCall).toBeTruthy()
    expect((putCall![0] as Request).url).toContain("/providers/openai")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("[tag:provider-proxy] blocks save on a non-positive value and shows an error", async () => {
    const onOpenChange = vi.fn()
    renderWithProviders(
      <ProviderProxyModal open onOpenChange={onOpenChange} projectId="proj-1" provider={PROVIDER} />,
      { preloadedState: PROJECT_STATE },
    )
    await screen.findByText("Edit proxy configuration")

    const concurrentInput = screen.getByLabelText("Concurrent requests")
    await userEvent.clear(concurrentInput)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Enter a positive whole number for both fields.")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

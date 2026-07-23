import { act, render, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createMockStore, mockResizeObserver, type ResizeObserverHandle } from "@test/mocks"
import { renderWithProviders, userEvent } from "@test/render"

import { loadEditToolForm } from "../reducer"
import type { EditToolLoadPayload } from "../toolset.types"
import { EditTool } from "./edit-tool"

const mockNavigate = vi.fn()
const mockUseParams = vi.fn((): { toolId?: string } => ({ toolId: "tool-mcp-01" }))
const mockUpdateTrigger = vi.fn(() => ({ unwrap: () => Promise.resolve({}) }))

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => mockUseParams(),
  }
})

vi.mock("../toolset.api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../toolset.api")>()
  return {
    ...actual,
    useGetMcpServerQuery: () => ({ data: undefined, isLoading: false, isFetching: false }),
    useUpdateMcpServerMutation: () => [mockUpdateTrigger, { isLoading: false }],
  }
})

const editPayload: EditToolLoadPayload = {
  name: "tool-mcp-01",
  description: "description",
  labels: ["staging"],
  addCustomHeaders: false,
  customHeaders: [],
  addForwardedHeaders: false,
  forwardedHeaders: [""],
  applyRateLimiting: false,
  callsPerMinute: "",
  configFields: [{ key: "serverUrl", label: "Server URL", value: "https://example.com", isRequired: true }],
}

function createProjectStore() {
  return createMockStore({
    projectContext: {
      activeProject: { id: "proj-1", name: "Project", role: "admin" },
    },
  } as unknown as Parameters<typeof createMockStore>[0])
}

function renderEditTool(store = createProjectStore()) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, {
      store,
      children: createElement(MemoryRouter, null, children),
    })

  return { store, ...render(<EditTool />, { wrapper }) }
}

describe("EditTool", () => {
  let roHandle: ResizeObserverHandle

  beforeEach(() => {
    mockNavigate.mockReset()
    mockUpdateTrigger.mockClear()
    mockUseParams.mockReturnValue({ toolId: "tool-mcp-01" })
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:edit-tool] renders page title", async () => {
    renderWithProviders(<EditTool />)

    await waitFor(() => {
      expect(screen.getByText("Edit toolset")).toBeInTheDocument()
    })
  })

  it("[tag:edit-tool] renders Save and Cancel buttons", async () => {
    renderWithProviders(<EditTool />)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    })
  })

  it("[tag:edit-tool] saves successfully when config is valid", async () => {
    const user = userEvent.setup({ delay: null })
    const store = createProjectStore()
    renderEditTool(store)

    await waitFor(() => {
      expect(screen.getByText("Edit toolset")).toBeInTheDocument()
    })

    await act(async () => {
      store.dispatch(loadEditToolForm({ toolId: "tool-mcp-01", ...editPayload }))
    })

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/toolsets")
    })
  })

  it("[tag:edit-tool] shows validation error when required config is missing", async () => {
    const user = userEvent.setup({ delay: null })
    const store = createProjectStore()
    renderEditTool(store)

    await waitFor(() => {
      expect(screen.getByText("Edit toolset")).toBeInTheDocument()
    })

    await act(async () => {
      store.dispatch(
        loadEditToolForm({
          toolId: "tool-mcp-01",
          ...editPayload,
          configFields: [{ key: "serverUrl", label: "Server URL", value: "", isRequired: true }],
        }),
      )
    })

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("Required configuration fields are missing")).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalledWith("/toolsets")
  })

  it("[tag:edit-tool] opens config dialog and saves configuration", async () => {
    const user = userEvent.setup({ delay: null })
    const store = createProjectStore()
    renderEditTool(store)

    await waitFor(() => {
      expect(screen.getByText("Edit toolset")).toBeInTheDocument()
    })

    await act(async () => {
      store.dispatch(loadEditToolForm({ toolId: "tool-mcp-01", ...editPayload }))
    })

    await user.click(screen.getByRole("button", { name: "Modify" }))
    const saveButtons = screen.getAllByRole("button", { name: "Save" })
    await user.click(saveButtons[saveButtons.length - 1]!)
  })

  it("[tag:edit-tool] navigates back on cancel", async () => {
    const user = userEvent.setup({ delay: null })
    renderEditTool()

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    })

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets/tool-mcp-01")
  })

  it("[tag:edit-tool] navigates to toolset list on cancel when toolId is missing", async () => {
    mockUseParams.mockReturnValue({})
    const user = userEvent.setup({ delay: null })
    renderEditTool()

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    })

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets")
  })
})

import { fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mockResizeObserver, type ResizeObserverHandle } from "@test/mocks"
import { renderWithProviders, userEvent as testUserEvent } from "@test/render"

const mockNavigate = vi.fn()
const mockCreateMcpServer = vi.fn()
const mockValidateMcpConnection = vi.fn()
const mockValidateManagedMcpConfig = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("../toolset.api", () => ({
  useCreateMcpServerMutation: () => [mockCreateMcpServer],
  useValidateMcpConnectionMutation: () => [mockValidateMcpConnection],
  useValidateManagedMcpConfigMutation: () => [mockValidateManagedMcpConfig],
}))

import { AddTool } from "./add-tool"

const AZURE_NETAPP_FILES_RADIO_NAME = "Select template Azure NetApp Files"

describe("AddTool", () => {
  let roHandle: ResizeObserverHandle

  beforeEach(() => {
    mockNavigate.mockReset()
    mockCreateMcpServer.mockReset()
    mockValidateMcpConnection.mockReset()
    mockValidateManagedMcpConfig.mockReset()
    mockCreateMcpServer.mockReturnValue({
      unwrap: () => Promise.resolve({ id: "mcp-1" }),
    })
    mockValidateMcpConnection.mockReturnValue({
      unwrap: () => Promise.resolve({ success: true, message: "Connected" }),
    })
    mockValidateManagedMcpConfig.mockReturnValue({
      unwrap: () => Promise.resolve({ success: true, message: "Connected" }),
    })
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:add-tool] renders page title and entity name", () => {
    renderWithProviders(<AddTool />)

    expect(screen.getByText("Add toolsets")).toBeInTheDocument()
    expect(screen.getByText("Toolset")).toBeInTheDocument()
  })

  it("[tag:add-tool] renders details section with tabs", () => {
    renderWithProviders(<AddTool />)

    expect(screen.getByText("Details")).toBeInTheDocument()
    expect(screen.getByText("Add from catalog")).toBeInTheDocument()
    expect(screen.getByText("Add custom toolset")).toBeInTheDocument()
  })

  it("[tag:add-tool] renders MCP server configuration section", () => {
    renderWithProviders(<AddTool />)

    expect(screen.getByText("MCP server configuration")).toBeInTheDocument()
    expect(screen.getByText("MCP server")).toBeInTheDocument()
    expect(screen.getByText("Configure")).toBeInTheDocument()
  })

  it("[tag:add-tool] renders Cancel button", () => {
    renderWithProviders(<AddTool />)

    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("[tag:add-tool] navigates back on cancel", async () => {
    const user = testUserEvent.setup({ delay: null })
    renderWithProviders(<AddTool />)

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets")
  })

  it("[tag:add-tool] submits custom tool when name and MCP config are set", async () => {
    const user = testUserEvent.setup({ delay: null })
    renderWithProviders(<AddTool />, {
      projectContext: {
        activeProject: { id: "proj-test-1", name: "Project 1", role: "admin" },
        hasActiveProject: true,
        isAdmin: true,
        isMember: false,
        isViewer: false,
      },
    })

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "my-custom-tool" } })
    await user.click(screen.getByRole("button", { name: "Configure" }))
    await waitFor(() => {
      expect(screen.getByLabelText("Server URL")).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://mcp.example.com" } })
    const dialogSave = screen.getAllByRole("button", { name: "Add" })[0]!
    await user.click(dialogSave)
    await user.click(screen.getAllByRole("button", { name: "Add" }).at(-1)!)

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/toolsets")
    })
  }, 15_000)

  it("[tag:add-tool] opens MCP dialog from configure action", async () => {
    const user = testUserEvent.setup({ delay: null })
    renderWithProviders(<AddTool />)

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "my-custom-tool" } })
    await user.click(screen.getByRole("button", { name: "Configure" }))
    await waitFor(() => {
      expect(screen.getByText("Add MCP server")).toBeInTheDocument()
    })
  }, 15_000)

  it("[tag:add-tool] shows catalog MCP validation when submitted without config", async () => {
    const user = testUserEvent.setup({ delay: null })
    renderWithProviders(<AddTool />)

    await user.click(screen.getByRole("tab", { name: "Add from catalog" }))
    await user.click(screen.getByRole("radio", { name: AZURE_NETAPP_FILES_RADIO_NAME }))
    await user.click(screen.getAllByRole("button", { name: "Add" }).at(-1)!)

    expect(screen.getByText("MCP server configuration is required")).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it("[tag:add-tool] switches to catalog tab and shows catalog MCP card", async () => {
    const user = testUserEvent.setup({ delay: null })
    renderWithProviders(<AddTool />)

    await user.click(screen.getByRole("tab", { name: "Add from catalog" }))
    await user.click(screen.getByRole("radio", { name: AZURE_NETAPP_FILES_RADIO_NAME }))

    expect(screen.getByText("Configure")).toBeInTheDocument()
  })
})

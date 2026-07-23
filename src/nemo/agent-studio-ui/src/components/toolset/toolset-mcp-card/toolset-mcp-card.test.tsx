import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"

import { ToolsetMcpCard } from "./toolset-mcp-card"

describe("ToolsetMcpCard", () => {
  it("[tag:mcp-card] renders title and subtitle", () => {
    renderWithProviders(
      <ToolsetMcpCard title="Server config" subtitle="Connect to MCP" />,
    )

    expect(screen.getByText("Server config")).toBeInTheDocument()
    expect(screen.getByText("Connect to MCP")).toBeInTheDocument()
  })

  it("[tag:mcp-card] shows 'Not configured' status by default", () => {
    renderWithProviders(
      <ToolsetMcpCard title="T" subtitle="S" />,
    )

    expect(screen.getByText("Not configured")).toBeInTheDocument()
  })

  it("[tag:mcp-card] shows 'Connected' status when connectionStatus='connected'", () => {
    renderWithProviders(
      <ToolsetMcpCard title="T" subtitle="S" connectionStatus="connected" />,
    )

    expect(screen.getByText("Connected")).toBeInTheDocument()
  })

  it("[tag:mcp-card] shows 'Error' status when connectionStatus='error'", () => {
    renderWithProviders(
      <ToolsetMcpCard title="T" subtitle="S" connectionStatus="error" />,
    )

    expect(screen.getByText("Error")).toBeInTheDocument()
  })

  it("[tag:mcp-card] shows Configure button when onConfigure is provided", () => {
    renderWithProviders(
      <ToolsetMcpCard title="T" subtitle="S" onConfigure={() => {}} />,
    )

    expect(screen.getByRole("button", { name: "Configure" })).toBeInTheDocument()
  })

  it("[tag:mcp-card] hides Configure button when onConfigure is NOT provided", () => {
    renderWithProviders(
      <ToolsetMcpCard title="T" subtitle="S" />,
    )

    expect(screen.queryByRole("button", { name: "Configure" })).not.toBeInTheDocument()
  })

  it("[tag:mcp-card] renders detail rows", () => {
    renderWithProviders(
      <ToolsetMcpCard
        title="T"
        subtitle="S"
        details={[
          { label: "Endpoint", value: "https://example.com" },
          { label: "Region", value: "us-east-1" },
        ]}
      />,
    )

    expect(screen.getByText("Endpoint")).toBeInTheDocument()
    expect(screen.getByText("https://example.com")).toBeInTheDocument()
    expect(screen.getByText("Region")).toBeInTheDocument()
    expect(screen.getByText("us-east-1")).toBeInTheDocument()
  })

  it("[tag:mcp-card] omits card header when title and subtitle are empty", () => {
    const { container } = renderWithProviders(
      <ToolsetMcpCard connectionStatus="not-configured" onConfigure={() => {}} />,
    )

    expect(screen.getByText("MCP server")).toBeInTheDocument()
    expect(container.querySelector(".card-header")).not.toBeInTheDocument()
  })

  it("[tag:mcp-card] renders non-string detail values", () => {
    renderWithProviders(
      <ToolsetMcpCard
        title="T"
        subtitle="S"
        details={[{ label: "Status", value: <span>Custom status</span> }]}
      />,
    )

    expect(screen.getByText("Custom status")).toBeInTheDocument()
  })
})

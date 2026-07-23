import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders } from "@test/render"
import { AccessConfigSection } from "./access-config-section"

const BASE_PROPS = {
  configured: true,
  onOpenDialog: vi.fn(),
  sourceType: "NFS",
  server: "nfs.example.com",
  volumeName: "my-volume",
  username: "admin",
  passwordConfigured: true,
  connectionStatus: "Healthy" as const,
}

// ---------------------------------------------------------------------------
// Section 11.26–11.29 — AccessConfigSection testStatus rendering
// ---------------------------------------------------------------------------

describe("AccessConfigSection", () => {
  // 11.26
  it("[tag:access-config-section][tag:idle] testStatus='idle' → shows 'Untested'", () => {
    renderWithProviders(<AccessConfigSection {...BASE_PROPS} testStatus="idle" connectionStatus="Healthy" />)

    expect(screen.getByText("Untested")).toBeInTheDocument()
    expect(screen.queryByText("Testing…")).not.toBeInTheDocument()
  })

  // 11.27
  it("[tag:access-config-section][tag:loading] testStatus='loading' → shows Spinner + 'Testing…'", () => {
    renderWithProviders(<AccessConfigSection {...BASE_PROPS} testStatus="loading" />)

    expect(screen.getByText("Testing…")).toBeInTheDocument()
  })

  // 11.28
  it("[tag:access-config-section][tag:success] testStatus='success' → shows 'Success'", () => {
    renderWithProviders(
      <AccessConfigSection {...BASE_PROPS} testStatus="success" connectionStatus="Unhealthy" />,
    )

    expect(screen.getByText("Success")).toBeInTheDocument()
    expect(screen.queryByText("Untested")).not.toBeInTheDocument()
  })

  // 11.29
  it("[tag:access-config-section][tag:error] testStatus='error' → shows 'Failed'", () => {
    renderWithProviders(
      <AccessConfigSection {...BASE_PROPS} testStatus="error" connectionStatus="Healthy" />,
    )

    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.queryByText("Success")).not.toBeInTheDocument()
  })

  it("[tag:access-config-section] not configured → shows 'Add' button, no connection details", () => {
    renderWithProviders(<AccessConfigSection {...BASE_PROPS} configured={false} />)

    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
    expect(screen.queryByText("Connection status")).not.toBeInTheDocument()
  })

  it("[tag:access-config-section] configured → shows 'Edit' button and connection details", () => {
    renderWithProviders(<AccessConfigSection {...BASE_PROPS} configured />)

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
    expect(screen.getByText("Connection status")).toBeInTheDocument()
    // Volume sources surface the user-supplied volume name (not the endpoint),
    // and no credential row (volumes carry no persisted credential).
    expect(screen.getByText("Volume name")).toBeInTheDocument()
    expect(screen.getByText("my-volume")).toBeInTheDocument()
    expect(screen.queryByText("Credential")).not.toBeInTheDocument()
  })

  // VolumeIcon — static SVG exported from this file; verified here via its unique path data
  it("[tag:access-config-section][tag:volume-icon] VolumeIcon SVG is rendered in the card header", () => {
    const { container } = renderWithProviders(<AccessConfigSection {...BASE_PROPS} configured />)

    const path = container.querySelector(
      'path[d="M4 7h16v2H4V7Zm0 4h16v2H4v-2Zm0 4h16v2H4v-2Z"]',
    )
    expect(path).toBeInTheDocument()
  })
})

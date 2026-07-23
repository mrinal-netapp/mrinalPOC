import { describe, expect, it } from "vitest"

import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types"

import { deriveToolHealth } from "./toolset-health"

type ServerHealthInput = Pick<McpServerSummary, "status" | "runtimeStatus">

describe("deriveToolHealth", () => {
  it("[tag:toolset-health] maps connected -> healthy", () => {
    expect(deriveToolHealth({ status: "connected" })).toBe("healthy")
  })

  it("[tag:toolset-health] maps error/disconnected -> unhealthy", () => {
    expect(deriveToolHealth({ status: "error" })).toBe("unhealthy")
    expect(deriveToolHealth({ status: "disconnected" })).toBe("unhealthy")
  })

  it("[tag:toolset-health] maps unknown -> unknown", () => {
    expect(deriveToolHealth({ status: "unknown" })).toBe("unknown")
  })

  it("[tag:toolset-health] provisioning pod -> deploying, regardless of transient status", () => {
    expect(
      deriveToolHealth({ status: "unknown", runtimeStatus: "provisioning" }),
    ).toBe("deploying")
  })

  it("[tag:toolset-health] failed provision -> unhealthy", () => {
    expect(
      deriveToolHealth({ status: "unknown", runtimeStatus: "failed" }),
    ).toBe("unhealthy")
  })

  it("[tag:toolset-health] running pod falls back to bifrost status", () => {
    const running: ServerHealthInput = { status: "connected", runtimeStatus: "running" }
    expect(deriveToolHealth(running)).toBe("healthy")
  })
})

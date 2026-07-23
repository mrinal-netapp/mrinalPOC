import { describe, expect, it } from "vitest"

import type { ToolListItem } from "../toolset-list.types"

import { mapToolListItemToToolsetRow } from "./toolset.mappers"

function makeTool(overrides: Partial<ToolListItem> = {}): ToolListItem {
  return {
    tool_id: "tool-1",
    tool_name: "My Tool",
    description: null,
    tool_type: "custom",
    region: null,
    healthiness_status: "Healthy",
    last_validation_error: null,
    last_validated_at: null,
    pipelines_count: 0,
    agents_count: 2,
    is_deprecated: false,
    tags: ["Production"],
    updated_at: "2026-05-08T00:00:00.000Z",
    updated_by: "system",
    ...overrides,
  }
}

describe("mapToolListItemToToolsetRow", () => {
  it("[tag:toolset-mapper] maps a healthy tool", () => {
    const result = mapToolListItemToToolsetRow(makeTool())

    expect(result).toEqual({
      id: "tool-1",
      name: "My Tool",
      type: "Remote",
      status: "healthy",
      statusDetails: "",
      associatedAgents: "2 agents",
      labels: ["Production"],
    })
  })

  it("[tag:toolset-mapper] maps singular associated agent label", () => {
    const result = mapToolListItemToToolsetRow(
      makeTool({
        agents_count: 1,
      }),
    )

    expect(result.associatedAgents).toBe("1 agent")
  })

  it("[tag:toolset-mapper] maps unhealthy tool with explicit validation error", () => {
    const result = mapToolListItemToToolsetRow(
      makeTool({
        tool_type: "catalogue",
        healthiness_status: "Unhealthy",
        last_validation_error: "Connection timeout",
      }),
    )

    expect(result.type).toBe("Local")
    expect(result.status).toBe("unhealthy")
    expect(result.statusDetails).toBe("Connection timeout")
  })

  it("[tag:toolset-mapper] maps unhealthy tool with empty status details when api error is blank", () => {
    const result = mapToolListItemToToolsetRow(
      makeTool({
        healthiness_status: "Unhealthy",
        last_validation_error: "   ",
      }),
    )

    expect(result.statusDetails).toBe("")
  })

  it("[tag:toolset-mapper] maps unknown tool health when backend sends Unknown", () => {
    const result = mapToolListItemToToolsetRow(
      makeTool({
        healthiness_status: "Unknown",
      }),
    )

    expect(result.status).toBe("unknown")
    expect(result.statusDetails).toBe("")
  })

  it("[tag:toolset-mapper] maps a deploying tool when backend sends Deploying", () => {
    const result = mapToolListItemToToolsetRow(
      makeTool({
        tool_type: "catalogue",
        healthiness_status: "Deploying",
      }),
    )

    expect(result.status).toBe("deploying")
  })

  it("[tag:toolset-mapper] maps unknown tool health when backend sends null status", () => {
    const result = mapToolListItemToToolsetRow(
      makeTool({
        healthiness_status: null,
      }),
    )

    expect(result.status).toBe("unknown")
    expect(result.statusDetails).toBe("")
  })
})

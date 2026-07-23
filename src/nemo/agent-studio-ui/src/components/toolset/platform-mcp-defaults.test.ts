import { describe, expect, it } from "vitest"

import {
  PLATFORM_MCP_DEFAULT_EXTRA_HEADERS,
  resolveDisplayedForwardedHeaders,
} from "./platform-mcp-defaults"

describe("platform-mcp-defaults", () => {
  it("[tag:platform-mcp] uses stored headers when present", () => {
    expect(
      resolveDisplayedForwardedHeaders("platform", ["Authorization", "X-Custom"]),
    ).toEqual(["Authorization", "X-Custom"])
  })

  it("[tag:platform-mcp] falls back to defaults for platform MCPs", () => {
    expect(resolveDisplayedForwardedHeaders("platform", null)).toEqual([
      ...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS,
    ])
  })

  it("[tag:platform-mcp] returns empty for non-platform MCPs without headers", () => {
    expect(resolveDisplayedForwardedHeaders("remote", null)).toEqual([])
  })
})

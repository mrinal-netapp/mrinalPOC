import { describe, expect, it } from "vitest"

import { TOOLSET_STATUS_ICON_MAP } from "./toolset-status.utils"

describe("toolset-status.utils", () => {
  it("[tag:toolset-status] exposes icon config for each health status", () => {
    expect(TOOLSET_STATUS_ICON_MAP.healthy.type).toBe("icon")
    expect(TOOLSET_STATUS_ICON_MAP.unhealthy.type).toBe("icon")
    expect(TOOLSET_STATUS_ICON_MAP.unknown.type).toBe("icon")
    expect(TOOLSET_STATUS_ICON_MAP.deploying.type).toBe("icon")
  })
})

import { describe, expect, it } from "vitest"

import {
  agentsConfigPath,
  agentsRuntimePath,
  appendQueryParams,
  buildAgentStreamUrl,
} from "@/routes/pages/agents/api/agents-api.paths"

describe("playground agents-api.paths", () => {
  describe("agentsConfigPath", () => {
    it("[tag:agents-api-paths] returns the bare /agents prefix when no suffix is provided", () => {
      expect(agentsConfigPath()).toBe("/agents")
    })

    it("[tag:agents-api-paths] appends the provided suffix verbatim", () => {
      expect(agentsConfigPath("/abc")).toBe("/agents/abc")
      expect(agentsConfigPath("?include=team")).toBe("/agents?include=team")
    })
  })

  describe("agentsRuntimePath", () => {
    it("[tag:agents-api-paths] prefixes the suffix with /projects/<projectId>", () => {
      const path = agentsRuntimePath("/agents/foo/sessions", "proj-1")
      expect(path).toBe("/projects/proj-1/agents/foo/sessions")
    })
  })

  describe("buildAgentStreamUrl", () => {
    it("[tag:agents-api-paths] composes a runtime stream url for the given agent id", () => {
      const url = buildAgentStreamUrl("agent-1", "proj-1")
      expect(url).toMatch(
        /^https?:\/\/.+\/projects\/proj-1\/agents\/agent-1\/invoke\/stream$/,
      )
    })

    it("[tag:agents-api-paths] appends optional query params to the stream url", () => {
      expect(appendQueryParams(buildAgentStreamUrl("agent-1", "proj-1"), { staging: "playground" })).toMatch(
        /\/invoke\/stream\?staging=playground$/,
      )
    })

    it("[tag:agents-api-paths] strips a trailing slash on the runtime base url before joining", () => {
      const url = buildAgentStreamUrl("a", "proj-1")
      expect(url).not.toMatch(/\/\/projects/)
    })
  })
})

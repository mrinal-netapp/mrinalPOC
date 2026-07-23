import { describe, expect, it } from "vitest"

import {
  agentsConfigPath,
  agentsRuntimePath,
  appendQueryParams,
  buildAgentStreamUrl,
  buildAgentTeamStreamUrl,
} from "./agents-api.paths"

describe("agents-api.paths", () => {
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

  describe("appendQueryParams", () => {
    it("[tag:agents-api-paths] leaves the url unchanged when query params are omitted", () => {
      expect(appendQueryParams("/invoke/stream")).toBe("/invoke/stream")
    })

    it("[tag:agents-api-paths] leaves the url unchanged when query params are empty", () => {
      expect(appendQueryParams("/invoke/stream", {})).toBe("/invoke/stream")
    })

    it("[tag:agents-api-paths] appends staging=playground when provided", () => {
      expect(appendQueryParams("/invoke/stream", { staging: "playground" })).toBe(
        "/invoke/stream?staging=playground",
      )
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
      const url = buildAgentStreamUrl("agent-1", "proj-1", { staging: "playground" })
      expect(url).toMatch(/\/invoke\/stream\?staging=playground$/)
    })

    it("[tag:agents-api-paths] strips a trailing slash on the runtime base url before joining", () => {
      const url = buildAgentStreamUrl("a", "proj-1")
      expect(url).not.toMatch(/\/\/projects/)
    })
  })

  describe("buildAgentTeamStreamUrl", () => {
    it("[tag:agents-api-paths] composes a runtime team stream url for the given team id", () => {
      const url = buildAgentTeamStreamUrl("team-1", "proj-1")
      expect(url).toMatch(
        /^https?:\/\/.+\/projects\/proj-1\/agent-teams\/team-1\/invoke\/stream$/,
      )
    })

    it("[tag:agents-api-paths] appends optional query params to the team stream url", () => {
      const url = buildAgentTeamStreamUrl("team-1", "proj-1", { staging: "playground" })
      expect(url).toMatch(/\/invoke\/stream\?staging=playground$/)
    })
  })
})

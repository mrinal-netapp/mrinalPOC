import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const ENV_KEYS = [
  "VITE_API_BASE_URL",
  "VITE_UTILITIES_API_BASE_URL",
  "VITE_AGENT_API_BASE_URL",
  "VITE_MODEL_SERVICE_BASE_URL",
  "VITE_USER_ID",
  "VITE_ORG_ID",
] as const

describe("api.consts", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.resetModules()
    for (const key of ENV_KEYS) {
      savedEnv[key] = import.meta.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete (import.meta.env as Record<string, unknown>)[key]
      } else {
        (import.meta.env as Record<string, unknown>)[key] = savedEnv[key]
      }
    }
    vi.unstubAllEnvs()
  })

  it("[tag:api-consts] should use env values when VITE_* vars are set", async () => {
    (import.meta.env as Record<string, unknown>).VITE_API_BASE_URL = "http://custom-api";
    (import.meta.env as Record<string, unknown>).VITE_UTILITIES_API_BASE_URL = "http://custom-utilities";
    (import.meta.env as Record<string, unknown>).VITE_AGENT_API_BASE_URL =
      "https://app.agentstudio.local:8443/api/agent";
    (import.meta.env as Record<string, unknown>).VITE_MODEL_SERVICE_BASE_URL = "http://custom-models";
    (import.meta.env as Record<string, unknown>).VITE_USER_ID = "user@test.com";
    (import.meta.env as Record<string, unknown>).VITE_ORG_ID = "org-456";

    const consts = await import("./api.consts")

    expect(consts.BASE_URL).toBe("http://custom-api")
    expect(consts.UTILITIES_BASE_URL).toBe("http://custom-utilities")
    expect(consts.AGENT_BASE_URL).toBe("https://app.agentstudio.local:8443/api/agent")
    expect(consts.PROJECTS_BASE_URL).toBe("https://app.agentstudio.local:8443/config/api/v1")
    expect(consts.MODEL_SERVICE_BASE_URL).toBe("http://custom-models")
    expect(consts.DEFAULT_NEMO_CONTEXT.user_id).toBe("user@test.com")
    expect(consts.DEFAULT_NEMO_CONTEXT.org_id).toBe("org-456")
  })

  it("[tag:api-consts] should fall back to defaults when env vars are missing", async () => {
    for (const key of ENV_KEYS) {
      delete (import.meta.env as Record<string, unknown>)[key]
    }

    const consts = await import("./api.consts")

    expect(consts.BASE_URL).toBe("http://localhost:3000/api/v1")
    expect(consts.UTILITIES_BASE_URL).toBe("http://localhost:3400/api/v1/utilities")
    expect(consts.AGENT_BASE_URL).toBe("/api/agent")
    expect(consts.PROJECTS_BASE_URL).toBe("/config/api/v1")
    expect(consts.WORKFLOW_BASE_URL).toBe("/workflow/api/v1")
    expect(consts.MODEL_SERVICE_BASE_URL).toBe(
      import.meta.env.DEV ? "/__model_service" : "http://127.0.0.1:8000",
    )
    expect(consts.DEFAULT_NEMO_CONTEXT.user_id).toBe("")
    expect(consts.DEFAULT_NEMO_CONTEXT.org_id).toBe("")
  })

  it("[tag:api-consts] should export static constants", async () => {
    const consts = await import("./api.consts")

    expect(consts.NEMO_CONTEXT_HEADER).toBe("x-agent-studio-context")
    expect(consts.POLLING_INTERVAL).toBe(20_000)
    expect(consts.DEFAULT_PAGE_SIZE).toBe(20)
  })

  it("[tag:api-consts] deriveWorkflowBaseUrl mirrors deriveProjectsBaseUrl with workflow prefix", async () => {
    const { deriveWorkflowBaseUrl } = await import("./api.consts")
    expect(deriveWorkflowBaseUrl("/api/agent")).toBe("/workflow/api/v1")
    expect(deriveWorkflowBaseUrl("https://app.agentstudio.local:8443/api/agent")).toBe(
      "https://app.agentstudio.local:8443/workflow/api/v1",
    )
  })

  it("[tag:api-consts] deriveProjectsBaseUrl uses same-origin path for relative agent base URLs", async () => {
    const { deriveProjectsBaseUrl } = await import("./api.consts")
    expect(deriveProjectsBaseUrl("/api/agent")).toBe("/config/api/v1")
  })

  it("[tag:api-consts] deriveProjectsBaseUrl uses agent URL origin for absolute agent base URLs", async () => {
    const { deriveProjectsBaseUrl } = await import("./api.consts")
    expect(deriveProjectsBaseUrl("https://app.agentstudio.local:8443/api/agent")).toBe(
      "https://app.agentstudio.local:8443/config/api/v1",
    )
    expect(deriveProjectsBaseUrl("https://agent-studio-nemo-apim-dev.azure-api.net/v1")).toBe(
      "https://agent-studio-nemo-apim-dev.azure-api.net/config/api/v1",
    )
  })

  it("[tag:api-consts] deriveProjectsBaseUrl falls back to same-origin path for empty or invalid URLs", async () => {
    const { deriveProjectsBaseUrl } = await import("./api.consts")
    expect(deriveProjectsBaseUrl("")).toBe("/config/api/v1")
    expect(deriveProjectsBaseUrl("not-a-url")).toBe("/config/api/v1")
  })

  describe("resolveSameOriginBase", () => {
    it("[tag:api-consts] prepends window.location.origin for relative paths", async () => {
      const { resolveSameOriginBase } = await import("./api.consts")
      // jsdom sets window.location.origin to "http://localhost"
      expect(resolveSameOriginBase("/__config")).toBe(`${window.location.origin}/__config`)
      expect(resolveSameOriginBase("/__agent_runtime")).toBe(
        `${window.location.origin}/__agent_runtime`,
      )
    })

    it("[tag:api-consts] returns absolute http/https URLs unchanged", async () => {
      const { resolveSameOriginBase } = await import("./api.consts")
      expect(resolveSameOriginBase("https://api.example.com/v1")).toBe("https://api.example.com/v1")
      expect(resolveSameOriginBase("http://localhost:8000")).toBe("http://localhost:8000")
    })

    it("[tag:api-consts] returns empty string unchanged", async () => {
      const { resolveSameOriginBase } = await import("./api.consts")
      expect(resolveSameOriginBase("")).toBe("")
    })
  })
})

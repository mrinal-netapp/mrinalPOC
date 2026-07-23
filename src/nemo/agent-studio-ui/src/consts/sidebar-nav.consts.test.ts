import { afterEach, describe, expect, it, vi } from "vitest"

import { getObservabilityUrls } from "./sidebar-nav.consts"

describe("getObservabilityUrls", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe("with VITE_GRAFANA_URL set", () => {
    it("[tag:observability][tag:urls] appends var-project to metrics when projectId is provided", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "")

      const { metrics } = getObservabilityUrls("proj-abc-123")

      expect(metrics).toBe(
        "https://grafana.example.com/d/service-overview/service-overview?orgId=1&var-project=proj-abc-123",
      )
    })

    it("[tag:observability][tag:urls] omits var-project from metrics when no projectId", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "")

      const { metrics } = getObservabilityUrls()

      expect(metrics).toBe(
        "https://grafana.example.com/d/service-overview/service-overview?orgId=1",
      )
      expect(metrics).not.toContain("var-project")
    })

    it("[tag:observability][tag:urls] URL-encodes special characters in projectId for metrics", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "")

      const { metrics } = getObservabilityUrls("proj/special id")

      expect(metrics).toContain("var-project=proj%2Fspecial%20id")
    })

    it("[tag:observability][tag:urls] logs URL points to the App Logs dashboard without project scope", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "")

      const { logs } = getObservabilityUrls("proj-abc-123")

      expect(logs).toBe("https://grafana.example.com/d/app-logs/app-logs?orgId=1")
      expect(logs).not.toContain("var-project")
    })

    it("[tag:observability][tag:urls] appTraces URL points to the App Traces dashboard", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "")

      const { appTraces } = getObservabilityUrls()

      expect(appTraces).toBe("https://grafana.example.com/d/app-traces/app-traces?orgId=1")
    })

    it("[tag:observability][tag:urls] agentTraces returns VITE_PHOENIX_URL", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "https://phoenix.example.com")

      const { agentTraces } = getObservabilityUrls()

      expect(agentTraces).toBe("https://phoenix.example.com")
    })
  })

  describe("derived from VITE_KEYCLOAK_ISSUER (primary derivation path)", () => {
    it("[tag:observability][tag:urls] extracts endpoint from Keycloak issuer for multi-segment domain", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "")
      vi.stubEnv("VITE_PHOENIX_URL", "")
      vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.agentstudio.dev.openeng.netapp.com/realms/nemo")

      const urls = getObservabilityUrls("proj-123")

      expect(urls.metrics).toContain("grafana.agentstudio.dev.openeng.netapp.com")
      expect(urls.metrics).not.toContain("grafana.netapp.com")
      expect(urls.metrics).toContain("var-project=proj-123")
      expect(urls.logs).toContain("grafana.agentstudio.dev.openeng.netapp.com")
      expect(urls.logs).toContain("/d/app-logs/app-logs")
      expect(urls.logs).not.toContain("var-project")
      expect(urls.agentTraces).toContain("phoenix.agentstudio.dev.openeng.netapp.com")
      expect(urls.agentTraces).not.toContain("phoenix.netapp.com")
    })

    it("[tag:observability][tag:urls] extracts endpoint from Keycloak issuer for simple two-label domain", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "")
      vi.stubEnv("VITE_PHOENIX_URL", "")
      vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.agentstudio.local/realms/nemo")

      const urls = getObservabilityUrls()

      expect(urls.metrics).toContain("grafana.agentstudio.local")
      expect(urls.logs).toContain("grafana.agentstudio.local")
      expect(urls.agentTraces).toContain("phoenix.agentstudio.local")
    })

    it("[tag:observability][tag:urls] VITE_GRAFANA_URL still takes precedence over issuer-derived URL", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.override.example.com")
      vi.stubEnv("VITE_PHOENIX_URL", "")
      vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.agentstudio.dev.openeng.netapp.com/realms/nemo")

      const urls = getObservabilityUrls()

      expect(urls.metrics).toContain("grafana.override.example.com")
      expect(urls.metrics).not.toContain("grafana.agentstudio.dev.openeng.netapp.com")
    })
  })

  describe("without env vars (localhost / no base domain)", () => {
    it("[tag:observability][tag:urls] returns empty strings when env vars are unset and hostname is localhost", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "")
      vi.stubEnv("VITE_PHOENIX_URL", "")
      vi.stubEnv("VITE_KEYCLOAK_ISSUER", "")
      // jsdom default hostname is "localhost" (single-label) → endpointDomain() returns ""

      const urls = getObservabilityUrls("any-project")

      expect(urls.logs).toBe("")
      expect(urls.metrics).toBe("")
      expect(urls.appTraces).toBe("")
      expect(urls.agentTraces).toBe("")
    })
  })

  describe("fallback: derived from window.location.hostname (auth-off local dev)", () => {
    const originalLocation = window.location

    afterEach(() => {
      Object.defineProperty(window, "location", { value: originalLocation, writable: true })
    })

    it("[tag:observability][tag:urls] falls back to hostname when no issuer is configured", () => {
      vi.stubEnv("VITE_GRAFANA_URL", "")
      vi.stubEnv("VITE_PHOENIX_URL", "")
      vi.stubEnv("VITE_KEYCLOAK_ISSUER", "")
      Object.defineProperty(window, "location", {
        value: { hostname: "app.agentstudio.local", port: "8443", protocol: "https:" },
        writable: true,
      })

      const urls = getObservabilityUrls("my-project")

      expect(urls.metrics).toContain("grafana.agentstudio.local:8443")
      expect(urls.metrics).toContain("var-project=my-project")
      expect(urls.logs).toContain("grafana.agentstudio.local:8443/d/app-logs/app-logs")
      expect(urls.agentTraces).toBe("https://phoenix.agentstudio.local:8443")
    })
  })
})

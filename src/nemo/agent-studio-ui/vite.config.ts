/// <reference types="vitest/config" />
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import type { ProxyOptions } from "vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const basePath = env.VITE_BASE_PATH?.trim() || "/"
  const devProxyTarget = env.VITE_DEV_PROXY_TARGET?.trim().replace(/\/+$/, "")
  const devProxyGateway =
    env.VITE_DEV_PROXY_GATEWAY?.trim().toLowerCase() === "true" ||
    Boolean(
      devProxyTarget &&
        !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(devProxyTarget),
    )
  const modelServiceProxyTarget =
    env.VITE_DEV_MODEL_SERVICE_PROXY_TARGET?.trim() || "http://127.0.0.1:8000"
  const workflowEngineTarget =
    env.VITE_DEV_WORKFLOW_PROXY_TARGET?.trim().replace(/\/+$/, "") ||
    "http://127.0.0.1:8082"
  const devWorkflowProxyTarget =
    env.VITE_DEV_WORKFLOW_PROXY_TARGET?.trim().replace(/\/+$/, "") ||
    (devProxyGateway ? devProxyTarget : workflowEngineTarget)
  // Agent-service runtime proxy target. Decoupled from
  // VITE_AGENT_RUNTIME_API_BASE_URL (the *app* base URL) so the app can point
  // at this same-origin proxy path to avoid CORS in dev:
  //   VITE_AGENT_RUNTIME_API_BASE_URL=http://localhost:5173/__agent_runtime
  // while the proxy still forwards to the real agent-service. Override the
  // target with VITE_DEV_AGENT_RUNTIME_PROXY_TARGET (mirrors the config-service
  // proxy var); defaults to the local agent-service on :8000.
  const agentRuntimeProxyTarget =
    env.VITE_DEV_AGENT_RUNTIME_PROXY_TARGET?.trim() || "http://localhost:8000"
  // The agent-service trusts the gateway to authenticate the JWT and inject the
  // user context (X-User-ID etc.); see agent-service/src/auth.py. When the dev
  // proxy talks to the service pod directly (no gateway in between) we must
  // inject that header ourselves or every invoke returns 401 "Missing auth
  // headers". X-Project-ID is intentionally omitted — the service falls back to
  // the project id in the URL path. Override the dev user via VITE_USER_ID.
  const devAgentUserId = env.VITE_USER_ID?.trim() || "dev@local"
  // Config-service proxy: used when VITE_AGENTS_CONFIG_API_BASE_URL=/__config so
  // the Vite dev server can forward agent/agent-team CRUD calls to a config
  // service that has no CORS (e.g. a kubectl port-forward to localhost:3000).
  const configServiceProxyTarget =
    env.VITE_DEV_CONFIG_SERVICE_PROXY_TARGET?.trim() || "http://localhost:3000"

  const proxy: Record<string, string | ProxyOptions> = {
    "/api/agent": {
      target: "https://agent-studio-nemo-apim-dev.azure-api.net",
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api\/agent/, "/v1"),
    },
    // Proxy for agents runtime (invoke / sessions / SSE stream).
    // The agent-service mounts every route under /api/v1, so the prefix is
    // rewritten to /api/v1 (not stripped to ""): /__agent_runtime/projects/...
    // → <agentRuntimeProxyTarget>/api/v1/projects/... . Use
    // VITE_AGENT_RUNTIME_API_BASE_URL=/__agent_runtime in .env.local to route
    // through this proxy instead of calling the service directly.
    "/__agent_runtime": {
      target: agentRuntimeProxyTarget,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/__agent_runtime/, "/api/v1"),
      headers: { "X-User-ID": devAgentUserId },
    },
    // Same-origin escape hatch for config-service (agent + agent-team CRUD)
    // when it has no CORS: set VITE_AGENTS_CONFIG_API_BASE_URL=/__config in
    // .env.local (dev only). Rewrites /__config/... → <target>/...
    "/__config": {
      target: configServiceProxyTarget,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/__config/, ""),
    },
    // Same-origin escape hatch when model-service has no CORS: set
    // VITE_MODEL_SERVICE_BASE_URL=/__model_service in ui/.env (dev only).
    "/__model_service": {
      target: modelServiceProxyTarget,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/__model_service/, ""),
    },
  }

  if (devProxyTarget) {
    // Gateway mode (e.g. https://app.agentstudio.local:8443): forward /config/*, /agents/*,
    // and /kb/* unchanged — the gateway routes those prefixes to backend services.
    // Direct-backend mode (e.g. http://localhost:3000): strip gateway prefixes so requests
    // hit config-service at /api/v1.
    proxy["/config/api/v1"] = {
      target: devProxyTarget,
      changeOrigin: true,
      secure: false,
      ...(devProxyGateway
        ? {}
        : {
            rewrite: (p: string) => p.replace(/^\/config\/api\/v1/, "/api/v1"),
          }),
    }
    proxy["/workflow/api/v1"] = {
      target: devProxyGateway ? devProxyTarget : devWorkflowProxyTarget,
      changeOrigin: true,
      secure: false,
      ...(devProxyGateway
        ? {}
        : {
            rewrite: (p: string) => p.replace(/^\/workflow\/api\/v1/, "/api/v1"),
          }),
    }
    // Fallback when VITE_API_BASE_URL uses the legacy /api/v1/config-service shape.
    proxy["/api/v1/config-service"] = {
      target: devProxyTarget,
      changeOrigin: true,
      secure: false,
      rewrite: (p: string) =>
        devProxyGateway
          ? p.replace(/^\/api\/v1\/config-service/, "/config/api/v1")
          : p.replace(/^\/api\/v1\/config-service/, "/api/v1"),
    }
    // Forward /api/v1 calls to the local config-service (avoids CORS in dev).
    proxy["/api/v1"] = {
      target: devProxyTarget,
      changeOrigin: true,
      secure: false,
      ...(devProxyGateway
        ? {
            rewrite: (p: string) => p.replace(/^\/api\/v1/, "/config/api/v1"),
          }
        : {}),
    }
    const agentsProxy: ProxyOptions = {
      target: devProxyTarget,
      changeOrigin: true,
      secure: false,
      // Don't proxy SPA page navigations (Accept: text/html) — let Vite serve
      // index.html so client-side routing handles /agents/* paths.
      bypass(req) {
        const accept = req.headers.accept;
        const acceptsHtml = Array.isArray(accept)
          ? accept.some((value) => value.includes("text/html"))
          : accept?.includes("text/html");
        if (acceptsHtml) return "/index.html";
      },
    }
    proxy["/agents"] = agentsProxy
    proxy["/kb"] = {
      target: devProxyTarget,
      changeOrigin: true,
      secure: false,
    }
  }

  // Analytics endpoints are served by analytics-engine directly.
  // In dev, port-forward analytics-engine to localhost:5001 and Vite strips the /analytics
  // prefix (matching the apigateway-service rewrite) before forwarding:
  //   POST /analytics/api/v1/datasets/preview  →  analytics-engine: POST /api/v1/datasets/preview
  // Run: kubectl port-forward -n agentstudio svc/analytics-engine 5001:5000
  const analyticsEngineTarget = env.VITE_DEV_ANALYTICS_PROXY_TARGET?.trim() || "http://localhost:5001"
  if (analyticsEngineTarget) {
    proxy["/analytics"] = {
      target: analyticsEngineTarget,
      changeOrigin: true,
      secure: false,
      rewrite: (p: string) => p.replace(/^\/analytics/, ""),
    }
  }

  // Workflow-engine endpoints (volume-browse, connector test, etc.) go through the /workflow prefix.
  // Run: kubectl port-forward -n agentstudio-services svc/workflow-engine 8082:8080
  if (workflowEngineTarget) {
    proxy["/workflow"] = {
      target: workflowEngineTarget,
      changeOrigin: true,
      secure: false,
      rewrite: (p: string) => p.replace(/^\/workflow/, ""),
    }
  }

  // S3 gateway (manual dataset uploads + file previews) is served under /s3 by the
  // deployment gateway (apigateway-service), NOT config-service — so it needs its own target.
  //
  // Auth nuance (apigateway-service AuthMiddleware): the /s3 PATH on the console host
  // (app.*) requires a Bearer JWT, but auth is SKIPPED when the request Host starts with
  // "s3." (the S3 proxy then signs the request with the gateway's own S3 credentials).
  // Since the dev UI runs without OIDC (no token), we send a Host header starting with
  // "s3." so the gateway skips the JWT check and signs the upload itself. The TCP target
  // stays the local gateway port-forward; secure:false tolerates its self-signed cert.
  // Run: kubectl port-forward -n agentstudio svc/nemo-gateway-nginx 8443:8443
  const s3GatewayTarget = env.VITE_DEV_S3_PROXY_TARGET?.trim() || "https://localhost:8443"
  const s3GatewayHost = env.VITE_DEV_S3_PROXY_HOST?.trim() || "s3.agentstudio.local"
  if (s3GatewayTarget) {
    proxy["/s3"] = {
      target: s3GatewayTarget,
      // Keep our explicit Host header (don't let changeOrigin overwrite it with the target host).
      changeOrigin: false,
      secure: false,
      headers: { host: s3GatewayHost },
    }
  }

  return {
    base: basePath,
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@test": path.resolve(__dirname, "./src/utils/unit-tests"),
      },
    },
    server: {
      proxy,
    },
    test: {
      globals: true,
      // renderWithProviders loads the full mock store (RTK Query + agents slices);
      // component tests routinely exceed Vitest's 5s default on local dev machines.
      testTimeout: 60_000,
      environment: "jsdom",
      typecheck: {
        tsconfig: "./tsconfig.test.json",
      },
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["node_modules", "dist"],
      setupFiles: ["./src/utils/unit-tests/setup.ts"],
      css: true,
      outputFile: {
        json: "src/utils/unit-tests/test-results/results.json",
        junit: "src/utils/unit-tests/test-results/junit.xml",
      },
      coverage: {
        provider: "v8",
        reporter: ["text", "text-summary", "lcov", "json-summary", "html"],
        reportsDirectory: "./src/utils/unit-tests/coverage",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          // Test files themselves — never measure test code
          "src/**/*.test.{ts,tsx}",
          // Test infrastructure — utility files that set up tests, not testable in isolation
          "src/utils/unit-tests/**",
          // Type and index files
          "src/**/*.types.ts",
          "src/**/index.ts",
          // App infrastructure
          "src/main.tsx",
          "src/vite-env.d.ts",
          // Store & routing infrastructure — tested indirectly, not unit testable in isolation
          "src/store/store.ts",
          "src/store/hooks.ts",
          "src/store/selectors/**",
          "src/routes/router.tsx",
          // API infrastructure — tested indirectly via RTK Query integration
          "src/api/api.slice.ts",
          // UI lib — exclude non-component directories and demo files;
          // the only thing tests are the components themselves
          "src/ui-lib/lib/**",
          "src/ui-lib/figma-MCP-download/**",
          "src/ui-lib/base-components/z-raw-files/**",
          "src/**/*.demo.*",
          "src/**/*.example.{ts,tsx}",
          // Mock data files — test fixtures, not logic
          "src/**/*.mock.ts",
          // Pure third-party re-exports — no executable code of ours
          "src/ui-lib/base-components/toast/toast.tsx",
        ],
        thresholds: {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
          // Reusable shared modal building blocks: held to a higher bar so the
          // public surface other features depend on stays trustworthy.
          "src/components/common/**/*.{ts,tsx}": {
            lines: 100,
            functions: 100,
            branches: 100,
            statements: 100,
          },
        },
      },
    },
  }
})

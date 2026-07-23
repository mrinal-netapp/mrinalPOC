import { createElement, type ReactNode } from "react"
import {
  IconActivity,
  IconAdjustments,
  IconBinaryTree,
  IconBooks,
  IconBriefcase,
  IconDatabase,
  IconFolders,
  IconGridDots,
  IconKey,
  IconMessageChatbot,
  IconReportAnalytics,
  IconSettings,
  IconSparkles2,
  IconTool,
} from "@tabler/icons-react"

import { getRuntimeAuthConfig } from "@/contexts/auth/runtimeConfig"
import { ROUTES } from "@/routes/routes.consts"

export interface SidebarNavItem {
  label: string
  path: string
  icon: ReactNode
  /** Any matching role allows the item to render (case-insensitive exact match). */
  requiredRoles?: readonly string[]
  /**
   * Whether the item is project-scoped. Defaults to `true` — every page
   * under these items reads project data, so without an active project
   * they're meaningless. Set to `false` for platform-level pages that
   * make sense even when no project is selected (cross-project admin /
   * super-admin views).
   *
   * Without this gate, every non-role-gated item used to render on
   * pages where the project switcher reads "Unnamed project" — the
   * pages then crashed/empty-loaded because there's no projectId to
   * scope queries by.
   */
  requireProject?: boolean
}

export const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
  { label: "Overview", path: ROUTES.OVERVIEW, icon: createElement(IconGridDots), requiredRoles: ["admin", "member", "viewer"], requireProject: false },
  { label: "Data sources", path: ROUTES.DATA_SOURCES, icon: createElement(IconDatabase), requiredRoles: ["admin", "member", "viewer"] },
  { label: "Datasets", path: ROUTES.DATASETS, icon: createElement(IconFolders), requiredRoles: ["admin", "member", "viewer"] },
  { label: "Knowledge Bases", path: ROUTES.KNOWLEDGE_BASES, icon: createElement(IconBooks), requiredRoles: ["admin", "member", "viewer"] },
  { label: "Credentials", path: ROUTES.CREDENTIALS, icon: createElement(IconKey), requiredRoles: ["admin", "member"] },
  { label: "Toolsets", path: ROUTES.TOOLSET, icon: createElement(IconTool), requiredRoles: ["admin", "member", "viewer"] },
  // Platform-level views: visible even without an active project so the
  // super-admin can land on the global console after login.
  { label: "Jobs", path: ROUTES.JOBS, icon: createElement(IconBriefcase), requiredRoles: ["super-admin"] },
  { label: "Models", path: ROUTES.MODELS, icon: createElement(IconBinaryTree), requiredRoles: ["admin", "member", "viewer"] },
  { label: "Agents", path: ROUTES.AGENTS, icon: createElement(IconSparkles2), requiredRoles: ["admin", "member", "viewer"] },
  { label: "Configurations", path: ROUTES.CONFIGURATIONS, icon: createElement(IconAdjustments), requiredRoles: ["super-admin"] },
  { label: "Chatbot", path: ROUTES.CHATBOT, icon: createElement(IconMessageChatbot), requiredRoles: ["super-admin"] },
  { label: "Evaluations", path: ROUTES.EVALUATIONS, icon: createElement(IconReportAnalytics), requiredRoles: ["admin", "member", "viewer"] },
  { label: "Administration", path: ROUTES.ADMINISTRATION, icon: createElement(IconSettings), requiredRoles: ["admin"], requireProject: false },
  { label: "Observability", path: ROUTES.OBSERVABILITY, icon: createElement(IconActivity), requiredRoles: ["admin", "member"] },
]

/**
 * Derive the endpoint domain for observability URLs.
 *
 * Resolution order:
 *  1. Keycloak issuer — already explicitly set per environment as
 *     https://auth.{endpoint}/realms/nemo (runtime config or VITE_KEYCLOAK_ISSUER).
 *     Parsing its hostname and stripping the first label gives the exact endpoint
 *     the Helm chart was configured with, regardless of what URL the browser shows.
 *  2. window.location.hostname fallback — for local dev with auth disabled where
 *     no issuer is configured. The UI is always at {consoleSubdomain}.{endpoint},
 *     so parts.slice(1) yields the endpoint correctly for any domain depth.
 *  3. Empty string — single-label host (plain localhost), no domain derivable.
 */
function endpointDomain(): string {
  // Prefer the explicitly configured Keycloak issuer URL.
  const issuer =
    getRuntimeAuthConfig().keycloakIssuer?.trim() ||
    import.meta.env.VITE_KEYCLOAK_ISSUER?.trim()

  if (issuer) {
    try {
      const issuerHostname = new URL(issuer).hostname // e.g. "auth.agentstudio.dev.openeng.netapp.com"
      const parts = issuerHostname.split(".")
      return parts.length > 1 ? parts.slice(1).join(".") : ""
    } catch {
      // malformed issuer URL — fall through to hostname derivation
    }
  }

  // Fallback: derive from the browser's current hostname (auth-off / local dev).
  if (typeof window === "undefined") return ""
  const parts = window.location.hostname.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : ""
}

export interface ObservabilityUrls {
  logs: string
  metrics: string
  appTraces: string
  agentTraces: string
}

/**
 * Wrap a Grafana dashboard URL so the current user's identity is handed off
 * explicitly to grafana-proxy, instead of being inferred from cross-site
 * cookies.
 *
 * Grafana runs on a different origin (grafana.<domain>) than the app
 * (app.<domain>). When opened directly, grafana-proxy decides who you are from
 * a lingering session/SSO cookie on the grafana/auth origins. Safari's
 * Intelligent Tracking Prevention blocks those cross-site cookies from being
 * kept in sync with the app, so Grafana can open as a previously signed-in
 * user. Routing through /oauth2/handoff with the current Keycloak access token
 * makes grafana-proxy establish a session for *this* user via a first-party
 * cookie that every browser (including Safari) stores reliably.
 *
 * The token is verified against Keycloak's JWKS by grafana-proxy, so it cannot
 * be forged. When no token is available (e.g. local dev with auth disabled) the
 * raw dashboard URL is returned unchanged and grafana-proxy falls back to its
 * normal cookie/OIDC flow.
 */
export function buildGrafanaHandoffUrl(grafanaDashboardUrl: string, authToken?: string | null): string {
  if (!authToken) {
    return grafanaDashboardUrl
  }
  try {
    const parsed = new URL(grafanaDashboardUrl)
    const redirect = `${parsed.pathname}${parsed.search}${parsed.hash}`
    const params = new URLSearchParams({ token: authToken, redirect })
    return `${parsed.origin}/oauth2/handoff?${params.toString()}`
  } catch {
    // Malformed URL (should not happen for our own constructed URLs) — open the
    // dashboard directly rather than breaking the button.
    return grafanaDashboardUrl
  }
}

/**
 * Build the four observability external URLs.
 *
 * URL resolution order:
 *  1. VITE_GRAFANA_URL / VITE_PHOENIX_URL env vars (set at build time or in .env)
 *  2. Derived from the current hostname: grafana.<base-domain> / phoenix.<base-domain>
 *     e.g. if the UI is at https://agentstudio.local:8443 the proxy URLs become
 *          https://grafana.agentstudio.local:8443 and https://phoenix.agentstudio.local:8443
 *  3. Empty string — clicking opens nothing useful (URL not configured)
 *
 * When projectId is provided it is appended as ?var-project=<id> to the Metrics
 * (Service Overview) Grafana dashboard URL so that dashboard opens pre-filtered
 * to the active project. Logs and trace dashboards do not carry project scope yet.
 *
 * When authToken is provided, the three Grafana dashboards (Logs, Metrics, App
 * Traces) are routed through grafana-proxy's /oauth2/handoff endpoint so the
 * current user's identity is passed explicitly rather than inferred from
 * cross-site cookies (see buildGrafanaHandoffUrl). Agent Traces (Phoenix) is a
 * separate service and is never wrapped.
 */
export function getObservabilityUrls(projectId?: string, authToken?: string | null): ObservabilityUrls {
  const port = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : ""
  const domain = endpointDomain()
  const scheme = typeof window !== "undefined" ? window.location.protocol : "https:"

  const grafanaUrl =
    import.meta.env.VITE_GRAFANA_URL?.trim() ||
    (domain ? `${scheme}//grafana.${domain}${port}` : "")

  const phoenixUrl =
    import.meta.env.VITE_PHOENIX_URL?.trim() ||
    (domain ? `${scheme}//phoenix.${domain}${port}` : "")

  const projectParam = projectId ? `&var-project=${encodeURIComponent(projectId)}` : ""

  const grafanaLink = (dashboardPath: string): string =>
    grafanaUrl ? buildGrafanaHandoffUrl(`${grafanaUrl}${dashboardPath}`, authToken) : ""

  return {
    logs: grafanaLink("/d/app-logs/app-logs?orgId=1"),
    metrics: grafanaLink(`/d/service-overview/service-overview?orgId=1${projectParam}`),
    appTraces: grafanaLink("/d/app-traces/app-traces?orgId=1"),
    agentTraces: phoenixUrl,
  }
}

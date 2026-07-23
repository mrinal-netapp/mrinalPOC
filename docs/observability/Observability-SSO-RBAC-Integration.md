# Observability SSO & Project-Level RBAC Integration

> **Scope:** This document covers the design, data flow, and security model for
> Grafana single sign-on (SSO) and per-project metric access control in the
> AgentStudio observability stack. It is the authoritative reference for
> `grafana-proxy` and `prometheus-proxy`.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Responsibilities](#2-component-responsibilities)
3. [SSO Design — grafana-proxy](#3-sso-design--grafana-proxy)
   - [OIDC Authorization Code Flow](#31-oidc-authorization-code-flow)
   - [Session Management](#32-session-management)
   - [Backchannel Logout](#33-backchannel-logout)
   - [Header Injection into Grafana](#34-header-injection-into-grafana)
4. [Project-Level RBAC — prometheus-proxy](#4-project-level-rbac--prometheus-proxy)
   - [Request Flow](#41-request-flow)
   - [PromQL Rewriting](#42-promql-rewriting)
   - [Project Variable ($project Dropdown)](#43-project-variable-project-dropdown)
   - [Admin Bypass](#44-admin-bypass)
5. [Security — Attacks and Mitigations](#5-security--attacks-and-mitigations)
   - [Attack 1: X-WEBAUTH Header Spoofing](#attack-1-x-webauth-header-spoofing)
   - [Attack 2: Stale Grafana Session Cookie](#attack-2-stale-grafana-session-cookie)
   - [Attack 3: PromQL project_id Label Injection](#attack-3-promql-project_id-label-injection)
   - [Attack 4: Negation Operator Bypass](#attack-4-negation-operator-bypass)
   - [Attack 5: Unscoped PromQL Expression](#attack-5-unscoped-promql-expression)
   - [Attack 6: Internal Endpoint Abuse](#attack-6-internal-endpoint-abuse)
   - [Attack 7: Session Use After Logout](#attack-7-session-use-after-logout)
6. [Configuration Reference](#6-configuration-reference)

---

## 1. Architecture Overview

```
  Browser
    |
    | HTTPS
    v
 NGINX Ingress
    |
    | HTTP (cluster-internal)
    v
+-------------------+      OIDC auth-code      +-----------+
|   grafana-proxy   | -----------------------> |  Keycloak |
|      :8080        | <-----------------------  +-----------+
|                   |     id_token / code
|                   |      fetch projects       +----------------+
|                   | -----------------------> | config-service |
|                   | <-----------------------  +----------------+
+-------------------+
    |
    | X-WEBAUTH-USER / ROLE / EMAIL / NAME
    v
+-------------------+   PromQL + X-Grafana-User  +--------------------+
|      Grafana      | -------------------------> | prometheus-proxy   |
|   (auth.proxy)    |                            |      :9091         |
+-------------------+                            |                    |
                                                 |  /.internal/       |
                                                 |  projects          |
                                                 |     |              |
                                                 |     v              |
                                                 | grafana-proxy:8080 |
                                                 |                    |
                                                 | rewritten PromQL   |
                                                 |     |              |
                                                 |     v              |
                                                 | Prometheus :9090   |
                                                 +--------------------+
```

All browser traffic to Grafana flows through **grafana-proxy**.  
All PromQL queries from Grafana flow through **prometheus-proxy**.  
Neither proxy is optional once SSO is enabled — direct access to Grafana or
Prometheus is blocked at the network layer.

---

## 2. Component Responsibilities

| Component | Namespace | Port | Purpose |
|---|---|---|---|
| `grafana-proxy` | `monitoring` | 8080 | OIDC auth-code flow; session management; X-WEBAUTH header injection; backchannel logout; project cache |
| `prometheus-proxy` | `monitoring` | 9091 | PromQL rewriting to enforce `project_id` scope per user |
| `Grafana` | `monitoring` | 80 | Dashboard rendering; configured in `auth.proxy` mode (no login form) |
| `Prometheus` | `monitoring` | 9090 | Raw metric storage; never directly reachable from dashboards |
| `Keycloak` | `agentstudio-identity` | 8080/8443 | OIDC identity provider; issues `id_token` + `access_token` |
| `config-service` | `agentstudio-services` | 3000 | Source of truth for project membership per user (`sub` UUID) |

---

## 3. SSO Design — grafana-proxy

### 3.1 OIDC Authorization Code Flow

The proxy uses the standard OIDC authorization code grant. No tokens are stored
in the browser — only an AES-encrypted server-issued session cookie.

```
 Browser          NGINX Ingress    grafana-proxy       Keycloak (public)    Keycloak (internal)   config-service    Grafana
    |                  |                |                      |                      |                  |              |
    |--- GET / ------->|                |                      |                      |                  |              |
    |                  |-- forward ---->|                      |                      |                  |              |
    |                  |                |-- session.Get()      |                      |                  |              |
    |                  |                |   returns nil        |                      |                  |              |
    |<-- 302 Redirect -+----------------| ?client_id=agentstudio-grafana-proxy        |                  |              |
    |                    &state=/orig-path &redirect_uri=/oauth2/callback             |                  |              |
    |                                   |                      |                      |                  |              |
    |--- GET /auth?... ------------------------------------------------>|             |                  |              |
    |<-- Login page -------------------------------------------------------            |                  |              |
    |--- POST credentials --------------------------------------------------->         |                  |              |
    |<-- 302 /oauth2/callback?code=AUTH_CODE&state=/orig-path ---------               |                  |              |
    |                                   |                      |                      |                  |              |
    |--- GET /oauth2/callback ---------->|                     |                      |                  |              |
    |                  |                |-- POST /token (code=AUTH_CODE) -------------------------------->|              |
    |                  |                |<- id_token + access_token ---------------------------          |              |
    |                  |                |                      |                      |                  |              |
    |                  |                |-- parseUnverifiedClaims(id_token)           |                  |              |
    |                  |                |   -> sub, email, name, preferred_username   |                  |              |
    |                  |                |   -> check realm role: platform-admin?      |                  |              |
    |                  |                |                      |                      |                  |              |
    |                  |                |-- GET /api/projects?userId=<sub> -------------------------------->|            |
    |                  |                |<- [{projectId:"proj-A"},{projectId:"proj-B"}] -----------       |              |
    |                  |                |                      |                      |                  |              |
    |                  |                |-- session.Save()     |                      |                  |              |
    |                  |                |   (AES-encrypted cookie, setCache, clearRevocation)             |              |
    |<-- 302 /orig-path Set-Cookie: grafana-proxy-session=<encrypted> ---|             |                  |              |
    |                                   |                      |                      |                  |              |
    |--- GET /orig-path Cookie: grafana-proxy-session=... ----->|        |             |                  |              |
    |                  |                |-- session.Get() -> valid UserSession         |                  |              |
    |                  |                |-- isRevoked(sub, cachedAt)? -> false         |                  |              |
    |                  |                |-- refreshCacheIfNeeded()                     |                  |              |
    |                  |                |-- len(projects)>0 or role=Admin? -> OK       |                  |              |
    |                  |                |-- X-WEBAUTH-USER: <sub>                      |                  |              |
    |                  |                |   X-WEBAUTH-ROLE: Viewer|Admin               |                  |              |
    |                  |                |   X-WEBAUTH-EMAIL / NAME ------------------------------------------------>|     |
    |                  |                |                      |                      |                  |<-- 200 --    |
    |<-- Grafana dashboard ---------------------------------------------------------------------------------------      |
```

**Key design decisions:**

- **Two Keycloak URLs** — `KeycloakPublicIssuer` (external HTTPS, for browser redirects)
  vs `KeycloakIssuer` (internal HTTP, for server-side token exchange). This avoids
  TLS certificate issues in cluster and ensures Keycloak sets its SSO cookies with
  the correct `Secure` flag.
- **Auth URL** is built from the public issuer; **Token URL** from the internal issuer.
- **No OAuth tokens in the session cookie** — storing two JWTs would exceed the
  4096-byte browser cookie limit. The proxy fetches and caches role + project list
  directly at login time.

### 3.2 Session Management

```
  Cookie: grafana-proxy-session
  ┌──────────────────────────────────────────────────────────┐
  │  Outer layer — HMAC-SHA256 signature                     │
  │  (SessionHashKey, 32+ random bytes)                      │
  │  ┌────────────────────────────────────────────────────┐  │
  │  │  Middle layer — AES-GCM encryption                 │  │
  │  │  (SessionBlockKey, 16 / 24 / 32 bytes)             │  │
  │  │  ┌──────────────────────────────────────────────┐  │  │
  │  │  │  UserSession struct (JSON)                   │  │  │
  │  │  │                                              │  │  │
  │  │  │  sub      : Keycloak UUID                    │  │  │
  │  │  │  email    : alice@example.com                │  │  │
  │  │  │  name     : Alice                            │  │  │
  │  │  │  username : alice                            │  │  │
  │  │  │  role     : Admin | Viewer                   │  │  │
  │  │  │  projects : [{projectId, role}, ...]         │  │  │
  │  │  │  cachedAt : 2024-01-01T10:00:00Z             │  │  │
  │  │  └──────────────────────────────────────────────┘  │  │
  │  └────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────┘
```

| Property | Value |
|---|---|
| Cookie name | `grafana-proxy-session` |
| Encoding | `gorilla/securecookie` — HMAC-SHA256 + AES-GCM |
| `HttpOnly` | `true` (not readable by JavaScript) |
| `SameSite` | `Lax` |
| `Secure` | `true` in production (TLS-terminated ingress) |
| Session TTL | 8 hours (configurable via `session.ttlHours`) |
| Project cache TTL | 5 minutes (configurable via `projectCacheTTLSeconds`) |

Project list is refreshed from config-service in the background every 5 minutes.
If the refresh fails, the proxy continues with cached (stale) data rather than
blocking the user — availability is preferred over strict freshness.

Non-admin users with **zero** project memberships receive `403 Forbidden`
immediately, before any request reaches Grafana.

### 3.3 Backchannel Logout

When a user logs out of **any** Keycloak client (e.g., the main AgentStudio
UI), Keycloak invokes the OIDC Back-Channel Logout spec:

```
  Alice (AgentStudio UI)          Keycloak              grafana-proxy
         |                           |                        |
         |--- Click Logout --------->|                        |
         |                           |-- End SSO session      |
         |                           |   for alice's sub      |
         |                           |                        |
         |                           |-- POST /oauth2/backchannel-logout
         |                           |   Body: logout_token=<JWT sub=alice-sub>
         |                           |----------------------> |
         |                           |                        |-- parseUnverifiedClaims(logout_token)
         |                           |                        |   revokedSubs["alice-sub"] = time.Now()
         |                           |<-- 200 OK -------------|
         |                           |                        |
         |                                                    |
         |          [ Later — Alice opens Grafana tab ]       |
         |                                                    |
         |--- GET /grafana/ Cookie: grafana-proxy-session --->|
         |                                                    |-- isRevoked("alice-sub", session.cachedAt)?
         |                                                    |   revokedAt AFTER cachedAt  ->  TRUE
         |                                                    |-- sessions.Clear(r, w)
         |<-- 302 -> Keycloak login page ---------------------|
```

The revocation map is keyed by `sub → time.Time`. A fresh login after logout
**clears** the revocation entry (`clearRevocation(sub)`), so the same user
can immediately log back in without being perpetually blocked.

### 3.4 Header Injection into Grafana

The proxy's `ReverseProxy.Director` function is the critical anti-spoofing
boundary. It runs on every forwarded request:

```
Step 1  removeCookieByName(req, "grafana-proxy-session")
        → proxy session cookie never reaches Grafana

Step 2  removeCookieByPrefix(req, "grafana_")
        → strips grafana_session, grafana_session_expiry, etc.
        → prevents stale Grafana sessions from overriding injected identity

Step 3  req.Header.Del("X-WEBAUTH-USER")
        req.Header.Del("X-WEBAUTH-ROLE")
        req.Header.Del("X-WEBAUTH-EMAIL")
        req.Header.Del("X-WEBAUTH-NAME")
        → drops ALL client-supplied identity headers unconditionally

Step 4  req.Header.Set("X-WEBAUTH-USER",  session.Sub)
        req.Header.Set("X-WEBAUTH-ROLE",  session.Role)
        req.Header.Set("X-WEBAUTH-EMAIL", session.Email)
        req.Header.Set("X-WEBAUTH-NAME",  session.Name)
        → re-injects ONLY the server-validated values from the encrypted session
```

Grafana is configured with `auth.proxy.enabled=true` and trusts exactly these
four headers. No Grafana login form exists (`auth.disable_login_form=true`).

---

## 4. Project-Level RBAC — prometheus-proxy

Every PromQL query Grafana sends to its datasource passes through
`prometheus-proxy` before reaching Prometheus. The proxy enforces that each
query is scoped to the requesting user's allowed projects.

### 4.1 Request Flow

```
      Grafana               prometheus-proxy            grafana-proxy         Prometheus
         |                        |                          |                     |
         |-- POST /api/v1/query ->|                          |                     |
         |   query=metric{        |                          |                     |
         |     project_id="p1"}   |                          |                     |
         |   X-Grafana-User: <sub>|                          |                     |
         |                        |                          |                     |
         |                        |-- sub = X-Grafana-User   |                     |
         |                        |   check in-memory cache  |                     |
         |                        |   (TTL: 5 min)           |                     |
         |                        |                          |                     |
         |                        |  [cache miss]            |                     |
         |                        |-- GET /.internal/projects?sub=<sub> ---------->|
         |                        |   Authorization: Bearer <InternalToken>        |
         |                        |<- {"role":"Viewer","projects":["p1","p2"]} ----|
         |                        |   cache[sub] = {role, projects, cachedAt}      |
         |                        |                          |                     |
         |                        |  [role == Admin]         |                     |
         |                        |-- forward unchanged --------------------------------->|
         |                        |                          |                     |
         |                        |  [role == Viewer]        |                     |
         |                        |-- rewriteQuery(query, allowedProjects)         |
         |                        |   -> metric{project_id=~"^(p1|p2)$"}          |
         |                        |   (X-Grafana-User header stripped)             |
         |                        |-- POST /api/v1/query rewritten ---------------------->|
         |                        |<- metrics scoped to p1 + p2 only -------------------|
         |<-- results ------------|                          |                     |
```

The `X-Grafana-User` header is automatically added by Grafana because
`dataproxy.send_user_header = true` is set in `grafana.ini`. It contains the
authenticated user's `sub` UUID (set as the Grafana username by grafana-proxy
via `X-WEBAUTH-USER`).

### 4.2 PromQL Rewriting

The rewriter enforces project scope by replacing or injecting `project_id`
label matchers. Four cases are handled:

```
  Incoming PromQL (non-Admin user)
           |
           v
  +-----------------------------+
  | project_id matcher present? |
  +-----------------------------+
           |
      YES  |                     NO
           v                      |
  +-----------------------+       v
  | CASE 1 — Intersect    |  +-----------------------------+
  |                       |  | { } selector block present? |
  | Extract project IDs   |  +-----------------------------+
  | from matcher value    |       |
  | Intersect with        |  YES  |                     NO
  | allowed list          |       v                      |
  |                       |  +----------------------+    v
  | Negation (!=, !~)?    |  | CASE 2 — Inject      |  +---------------------+
  |  -> full allowed list |  |                      |  | Bare metric name?   |
  |                       |  | Append               |  +---------------------+
  | Output:               |  | project_id=~"^(...)$"|       |
  | project_id=~          |  | into every { } block |  YES  |              NO
  |   "^(p1|p2)$"         |  |                      |       v               |
  +-----------------------+  +----------------------+  +--------------+     v
                                                       | CASE 3       |  +------------------+
                                                       | Append       |  | Has identifiers? |
                                                       | {project_id= |  +------------------+
                                                       |  ~"^(...)$"} |       |          |
                                                       | after name   |  NO   |     YES  |
                                                       +--------------+   v            v
                                                                     +-------+   +----------+
                                                                     | PASS  |   |  BLOCK   |
                                                                     | (pure |   | -> empty |
                                                                     | scalar|   |   vector |
                                                                     | 1+1)  |   | response |
                                                                     +-------+   +----------+
```

**Worked examples:**

| Input query | Case | Output query |
|---|---|---|
| `nemo_run_count{project_id="proj-A"}` | 1 | `nemo_run_count{project_id=~"^(proj-A)$"}` |
| `nemo_run_count{project_id=~"proj-A\|proj-C"}` | 1 | `nemo_run_count{project_id=~"^(proj-A)$"}` _(proj-C not in allowed list, silently dropped)_ |
| `nemo_run_count{project_id!="proj-A"}` | 1 (negation) | `nemo_run_count{project_id=~"^(proj-A\|proj-B)$"}` |
| `nemo_run_count{status="ok"}` | 2 | `nemo_run_count{status="ok", project_id=~"^(proj-A\|proj-B)$"}` |
| `up` | 3 | `up{project_id=~"^(proj-A\|proj-B)$"}` |
| `avg(rate(metric[5m]))` | 4 (blocked) | `{status:"success", data:{resultType:"vector", result:[]}}` |
| `1 + 1` | scalar pass | `1 + 1` (forwarded unchanged) |

**Security guarantee:** The effective `project_id` in the query sent to
Prometheus is always a subset of the user's allowed projects as returned by
config-service. A user cannot exceed their own project boundary regardless of
what query text they submit.

### 4.3 Project Variable ($project Dropdown)

Grafana's `$project` template variable is populated via the prometheus-proxy
`/api/v1/label/project_id/values` endpoint:

```
  Grafana (backend)         prometheus-proxy          grafana-proxy
         |                        |                        |
         |-- GET /api/v1/label/project_id/values -------->|
         |   X-Grafana-User: <sub>|                        |
         |                        |-- GET /.internal/projects?sub=<sub>
         |                        |   Authorization: Bearer <InternalToken>
         |                        |----------------------->|
         |                        |<- {projects:["proj-A","proj-B"]}
         |                        |                        |
         |<-- {"status":"success","data":["proj-A","proj-B"]}
         |
         |  $project dropdown now shows ONLY the user's projects.
         |  Cannot be expanded by manipulating the datasource query.
```

The user sees only their own projects in the dropdown — the list cannot be
expanded by manipulating the datasource query because prometheus-proxy intercepts
and overrides `/api/v1/label/project_id/values` directly from its own cache,
bypassing Prometheus entirely for this endpoint.

### 4.4 Admin Bypass

Users with the Keycloak realm role `platform-admin` are mapped to `role=Admin`
by grafana-proxy. The prometheus-proxy forwards all requests from Admin users
**unchanged** to Prometheus — no PromQL rewriting, no project scope restriction.
The `$project` dropdown for Admin users shows all projects.

---

## 5. Security — Attacks and Mitigations

The following section documents attack vectors that the current implementation
actively handles. Each entry describes the threat, the attack mechanics, and
the precise code-level defence.

---

### Attack 1: X-WEBAUTH Header Spoofing

**Threat:** An attacker crafts a request with forged identity headers
(e.g., `X-WEBAUTH-USER: admin-uuid`, `X-WEBAUTH-ROLE: Admin`) to impersonate
a privileged user, bypassing Keycloak authentication entirely.

```
  Attacker Browser             grafana-proxy Director              Grafana
         |                              |                             |
         |-- GET /grafana/ ------------>|                             |
         |   X-WEBAUTH-USER: admin-uuid |                             |
         |   X-WEBAUTH-ROLE: Admin      |                             |
         |                              |                             |
         |                              | Step 1: Del X-WEBAUTH-USER  |
         |                              |         (client-supplied)   |
         |                              | Step 2: Del X-WEBAUTH-ROLE  |
         |                              |         (client-supplied)   |
         |                              | Step 3: Del X-WEBAUTH-EMAIL |
         |                              | Step 4: Del X-WEBAUTH-NAME  |
         |                              |                             |
         |                              | Step 5: Inject from         |
         |                              |   validated session only:   |
         |                              |   X-WEBAUTH-USER: real-sub  |
         |                              |   X-WEBAUTH-ROLE: Viewer    |
         |                              |                             |
         |                              |-- forward ----------------->|
         |                              |   X-WEBAUTH-USER: real-sub  |
         |                              |   X-WEBAUTH-ROLE: Viewer    |
         |                              |                             |
         |          Spoofed admin-uuid NEVER reaches Grafana          |
```

**Mitigation:** `ReverseProxy.Director` unconditionally deletes all four
`X-WEBAUTH-*` headers from the **incoming** request before re-injecting values
from the server-side encrypted session. There is no conditional — the delete
runs on every single request, regardless of what the client sent.

---

### Attack 2: Stale Grafana Session Cookie (User-Switching Attack)

**Threat:** Alice logs in to Grafana and a `grafana_session` cookie is written
to the browser. Bob then uses the same browser profile (or a shared cookie
jar). Grafana would recognise Alice's `grafana_session` cookie and show her
context to Bob, silently ignoring the `X-WEBAUTH-USER: bob-sub` header.

```
  Bob's Browser                  grafana-proxy Director              Grafana
  (has Alice's cookie)                   |                             |
         |                               |                             |
         |-- GET /grafana/ ------------->|                             |
         |   Cookie: grafana_session=    |                             |
         |           alice-session-id    |                             |
         |   Cookie: grafana_session_    |                             |
         |           expiry=...          |                             |
         |                               |                             |
         |                               | removeCookieByPrefix(       |
         |                               |   "grafana_")               |
         |                               |                             |
         |                               | Strips:                     |
         |                               |   grafana_session           |
         |                               |   grafana_session_expiry    |
         |                               |   (all grafana_* cookies)   |
         |                               |                             |
         |                               |-- forward ----------------->|
         |                               |   Cookie: (none)            |
         |                               |   X-WEBAUTH-USER: bob-sub   |
         |                               |                             |
         |            Grafana sees NO session cookie.                  |
         |            Uses X-WEBAUTH-USER: bob-sub as identity.        |
         |            Alice's context is completely invisible.         |
```

**Mitigation:** `removeCookieByPrefix("grafana_")` strips every cookie whose
name starts with `grafana_`. Grafana never sees a session cookie and falls back
entirely to the `X-WEBAUTH-USER` header, which only contains the server-validated
identity for the current request.

---

### Attack 3: PromQL project_id Label Injection

**Threat:** An attacker modifies the Grafana datasource URL or intercepts the
API call to inject a `project_id` label matcher for a project they do not own,
attempting to read another tenant's metrics.

```
Attack query:
  nemo_run_count{project_id="competitor-project"}

User's allowed projects: ["proj-A", "proj-B"]
```

```
  Tampered query                 prometheus-proxy                  Prometheus
  ─────────────────              ─────────────────────────────     ──────────
  nemo_run_count{           -->  CASE 1: project_id matcher found
    project_id=                  extractMatcherValue()
    "competitor-project"         -> "competitor-project"
  }                              intersect(
                                   ["competitor-project"],
                                   ["proj-A", "proj-B"]
                                 ) -> [] (empty)
                                 fallback: full allowed list      -->  nemo_run_count{
                                                                         project_id=~
                                                                         "^(proj-A|proj-B)$"
                                                                       }

  Result: competitor-project data NEVER returned.
          User receives only their own proj-A + proj-B metrics.
```

**Mitigation:** Case 1 of `rewriteQuery` intercepts the existing `project_id`
matcher, extracts its value, and intersects it with the caller's allowed project
list. Any project ID not in the allowed list is silently dropped. If the
intersection is empty (all requested projects are forbidden), the full allowed
list is used as a fallback — the attacker gets only their own data.

---

### Attack 4: Negation Operator Bypass

**Threat:** An attacker uses `!=` or `!~` operators on `project_id` to invert
the scope: "give me all metrics **except** mine" — effectively reading
everything else.

```
Attack query:
  nemo_run_count{project_id!="proj-A"}
```

**Mitigation:** `rewriteQuery` explicitly checks for `!=` and `!~` in the
matched substring. Negation operators **cannot be safely intersected** (the
inverse of an exclusion is unbounded), so the entire matcher is unconditionally
replaced with a positive regex enforcing the full allowed list:

```
  Input:   nemo_run_count{project_id!="proj-A"}
                                    ^^
                               negation detected

  Action:  cannot intersect a negation safely
           -> replace entire matcher with positive allowlist

  Output:  nemo_run_count{project_id=~"^(proj-A|proj-B)$"}
```

The negation is converted to a positive membership check. The attacker's
exclusion intent is neutralised; they see only their own projects.

---

### Attack 5: Unscoped PromQL Expression

**Threat:** An attacker submits a complex PromQL expression that has metric
references but no `{}` selector block and is not a bare metric name, making it
impossible to inject a `project_id` filter safely.

```
Attack query:
  avg(rate(nemo_run_count[5m]))
```

If forwarded to Prometheus unchanged this would return metrics across **all**
projects because there is no `project_id` label constraint.

```
  avg(rate(nemo_run_count[5m]))
           |
           v
  project_id matcher? ----NO---->  { } block present? ----NO----> bare metric? ----NO---->  has letter identifiers?
                                                                                                      |
                                                                                              YES     |
                                                                                                      v
                                                                                            rewriteQuery returns ("", false)
                                                                                                      |
                                                                                                      v
                                                                                     writeEmptyPrometheusResult()
                                                                                     {
                                                                                       "status": "success",
                                                                                       "data": {
                                                                                         "resultType": "vector",
                                                                                         "result": []
                                                                                       }
                                                                                     }
                                                                                     Grafana shows "No data".
                                                                                     Query NEVER reaches Prometheus.
```

**Mitigation:** `rewriteQuery` returns `("", false)` for any expression that
contains letter identifiers (i.e., metric references) but does not match Cases
1–3. The caller receives a valid but empty Prometheus-shaped JSON response.
Grafana renders "No data" rather than an error. The query never reaches
Prometheus.

---

### Attack 6: Unauthorized Access to `/.internal/projects`

**Threat:** A rogue pod, external attacker, or curious developer calls
`grafana-proxy`'s `/.internal/projects` endpoint without a valid shared
secret to enumerate all users' project memberships.

```
  Attacker Pod                          grafana-proxy
       |                                     |
       |-- GET /.internal/projects?sub=any ->|
       |   (no Authorization header)         |
       |                                     |-- token = r.Header.Get("Authorization")
       |                                     |   -> "" (empty)
       |                                     |-- token != InternalToken
       |<-- 401 Unauthorized ----------------|
       |
       |-- GET /.internal/projects?sub=any ->|
       |   Authorization: Bearer wrong-token |
       |                                     |-- "wrong-token" != InternalToken
       |<-- 401 Unauthorized ----------------|

  Additional constraint:
    The endpoint has NO Ingress route.
    It is only reachable in-cluster via ClusterIP (pod-to-pod).
    External traffic cannot reach it regardless of the token.
```

**Mitigation:** `handleInternalProjects` validates the `Authorization: Bearer <token>`
header against the `InternalToken` loaded from a Kubernetes Secret (Azure Key
Vault CSI-synced). A mismatch or missing header returns `401` before any data
is read. The Kubernetes Secret is shared between grafana-proxy and
prometheus-proxy deployments and is never exposed outside the cluster.

---

### Attack 7: Session Use After Logout (Broken SSO Propagation)

**Threat:** Alice logs out of AgentStudio. Her `grafana-proxy-session` cookie
is still valid (hasn't expired). Alice's browser — or a tab opened by someone
with access to Alice's cookies — continues to use Grafana as Alice after logout.

```
  Alice              AgentStudio UI       Keycloak            grafana-proxy
    |                      |                  |                     |
    |-- Click Logout ------>|                 |                     |
    |                       |-- End session ->|                     |
    |                       |                 |-- POST /oauth2/backchannel-logout
    |                       |                 |   logout_token (JWT, sub=alice-sub)
    |                       |                 |-------------------->|
    |                       |                 |                     |-- revokedSubs["alice-sub"] = time.Now()
    |                       |                 |<-- 200 OK ----------|
    |                       |                 |                     |
    |                                         |                     |
    |  [ Later — Alice opens Grafana tab ]    |                     |
    |                                         |                     |
    |-- GET /grafana/ (Cookie: grafana-proxy-session, pre-logout) ->|
    |                                         |                     |-- isRevoked("alice-sub", session.cachedAt)?
    |                                         |                     |   revokedAt  >  cachedAt  ->  TRUE
    |                                         |                     |-- sessions.Clear(r, w)
    |<-- 302 -> Keycloak login page --------------------------------|
```

**Mitigation:** The in-memory `revokedSubs` map records `sub → revokedAt`.
`isRevoked` returns `true` only when the logout event happened **after** the
session was created (`revokedAt.After(sessionCachedAt)`). This allows Bob to
log in fresh on the same machine immediately after Alice's revocation without
being blocked by the revocation entry (which only applies to sessions predating
the logout).

---

## 6. Configuration Reference

### grafana-proxy (Helm values)

```yaml
grafana-proxy:
  enabled: true
  hostname: "grafana.agentstudio.dev.openeng.netapp.com"

  keycloak:
    issuer: "http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo"
    publicIssuer: "https://auth.agentstudio.dev.openeng.netapp.com/realms/nemo"
    clientId: "agentstudio-grafana-proxy"
    clientSecret: ""          # set via existingSecret or --set
    existingSecret: ""        # Kubernetes Secret with key clientSecret
    tlsSkipVerify: false      # true only for local dev with self-signed certs

  session:
    hashKey: ""               # 32+ random bytes (HMAC signing key)
    blockKey: ""              # 16, 24, or 32 random bytes (AES encryption key)
    existingSecret: ""        # Kubernetes Secret with keys hashKey + blockKey
    ttlHours: 8               # Session lifetime

  projectCacheTTLSeconds: 300   # How long to cache user's project list
  platformAdminRole: "platform-admin"   # Keycloak realm role → Grafana Admin

  grafanaUpstreamURL: "http://observability-grafana.monitoring.svc.cluster.local:80"
  configServiceURL: "http://config-service.agentstudio-services.svc.cluster.local:3000"

  internalToken:
    value: ""                 # Shared secret with prometheus-proxy
    existingSecret: ""        # Kubernetes Secret with key token
```

### prometheus-proxy (Helm values)

```yaml
prometheus-proxy:
  enabled: true

  prometheusUpstreamURL: "http://prometheus-prometheus.monitoring.svc.cluster.local:9090"
  grafanaProxyURL: "http://grafana-proxy.monitoring.svc.cluster.local:8080"
  projectCacheTTLSeconds: 300

  internalToken:
    value: ""                 # Must match grafana-proxy.internalToken.value
    existingSecret: ""
```

### Grafana (`grafana.ini` via Helm)

```yaml
grafana.ini:
  auth.proxy:
    enabled: true
    header_name: X-WEBAUTH-USER
    header_property: username
    auto_sign_up: true
    headers: "Role:X-WEBAUTH-ROLE Email:X-WEBAUTH-EMAIL Name:X-WEBAUTH-NAME"

  auth:
    disable_login_form: true   # No password login — only via grafana-proxy

  dataproxy:
    send_user_header: true     # Enables X-Grafana-User on datasource calls
```

---

**Network access rules:**

| Source | Destination | Port | Notes |
|---|---|---|---|
| Browser | grafana-proxy | 443 (via Ingress) | Only entry point to Grafana |
| grafana-proxy | Grafana | 80 | In-cluster only |
| grafana-proxy | Keycloak (internal) | 8080 | Token exchange |
| grafana-proxy | config-service | 3000 | Project membership |
| Grafana | prometheus-proxy | 9091 | Datasource `prometheus-proxy` |
| prometheus-proxy | grafana-proxy | 8080 | `/.internal/projects` |
| prometheus-proxy | Prometheus | 9090 | Rewritten PromQL |
| Keycloak | grafana-proxy | 8080 | Backchannel logout POST |
| Browser | Prometheus | — | **BLOCKED** (no Ingress route) |
| Browser | grafana-proxy `/.internal/*` | — | **BLOCKED** (no Ingress route) |

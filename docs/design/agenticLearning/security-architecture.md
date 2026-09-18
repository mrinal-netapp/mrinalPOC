# AgentStudio — End-to-End Security Architecture

## Overview

AgentStudio is a multi-tenant agent platform deployed **inside the customer's own Kubernetes cluster**. The trust model has to hold even against the vendor: a user in one project must never reach another project's data, agents or credentials, and NetApp must not be able to reach the customer's provider credentials.

The enforcement is **layered** — every hop re-verifies rather than trusting the previous one.

Reference files are listed at the end.

---

## 1. The core mental model — two independent identity axes

This is the single most useful framing. Every request carries **two** identities, verified by **different roots of trust**:

```text
   ┌────────────────────────────┬──────────────────────────────────┐
   │  WHICH USER?               │  WHICH WORKLOAD?                 │
   ├────────────────────────────┼──────────────────────────────────┤
   │  Keycloak JWT / RPT        │  Istio mTLS + SPIFFE             │
   │  verified at edge AND mesh │  PeerAuthentication STRICT       │
   │  project scope in app      │  AuthorizationPolicy allow-lists │
   ├────────────────────────────┼──────────────────────────────────┤
   │  root of trust:            │  root of trust:                  │
   │  Keycloak signing key      │  Istio CA (istiod)               │
   └────────────────────────────┴──────────────────────────────────┘

   Both must pass. Neither can forge the other.
```

Consequences:

- A **stolen user token** can't move laterally — the attacker's pod has no valid SPIFFE certificate.
- A **compromised pod** can't act as a user — it can't mint a Keycloak-signed JWT.

---

## 2. Request flow — enforcement at every hop

```text
  ┌──────────┐   Auth Code + PKCE (S256)    ┌─────────────────────────┐
  │ Browser  │ ◄──────────────────────────► │  Keycloak  realm: nemo  │
  │  / SPA   │        access_token          │  ns: agentstudio-       │
  └────┬─────┘        aud=agent-studio-api  │      identity           │
       │                                     └───────────┬─────────────┘
       │ HTTPS :443  Bearer <access_token>                │
       ▼                                                  │
 ╔═══════════════════════════════════════════════════╗    │
 ║  ISTIO GATEWAY POD        ns: agentstudio-edge    ║    │
 ║  (Gateway API — Gateway + HTTPRoute)              ║    │
 ║                                                   ║    │
 ║  ① TLS TERMINATE  :443                            ║    │
 ║     cert: Secret nemo-gateway-tls                 ║    │
 ║     listener mTLS = PERMISSIVE (browser has       ║    │
 ║     no SPIFFE cert)                               ║    │
 ║                     │                             ║    │
 ║  ② RequestAuthentication  (Envoy jwt_authn)       ║    │
 ║     verify signature via JWKS ──────────────────────────┤
 ║     issuer: /realms/nemo   aud: agent-studio-api  ║    │
 ║     ✗ invalid/expired  →  401  (never reaches app)║    │
 ║                     │                             ║    │
 ║  ③ UMA → RPT SWAP   (Lua EnvoyFilter)             ║    │
 ║     on paths  /api/v1/projects/{id}/...           ║    │
 ║     POST grant_type=uma-ticket ───────────────────────► │
 ║          permission=project:{id}#admin,member,    ║    │
 ║                              viewer               ║ ◄──┘ RPT
 ║     200 → replace Authorization with RPT          ║
 ║     401/403 → short-circuit    KC error → 502     ║   (fail closed)
 ║                     │                             ║
 ║  ④ PARITY HEADERS injected (post jwt_authn)       ║
 ║     X-User-ID · X-User-Email · X-Project-ID …     ║
 ╚══════════════════════╤════════════════════════════╝
                        │
                        │  ⑤  mTLS  STRICT   +  SPIFFE identity
                        │      spiffe://cluster.local/ns/<ns>/sa/<sa>
                        │      (PeerAuthentication, 9 namespaces)
                        ▼
 ╔═══════════════════════════════════════════════════╗
 ║  SERVICE POD  (e.g. config-service)               ║
 ║  ┌─────────────── istio-proxy sidecar ──────────┐ ║
 ║  │ ⑥ RequestAuthentication (mesh)               │ ║
 ║  │    re-verify JWT/RPT signature + aud         │ ║
 ║  │    ✗ → 401                                   │ ║
 ║  │                                              │ ║
 ║  │ ⑦ AuthorizationPolicy allow-list             │ ║
 ║  │    principals: cluster.local/ns/…/sa/…       │ ║
 ║  │    ✗ wrong workload identity → 403           │ ║
 ║  │                                              │ ║
 ║  │ ⑧ XFCC re-injection                          │ ║
 ║  │    strip inbound, re-add from verified peer  │ ║
 ║  └──────────────────┬───────────────────────────┘ ║
 ║                     ▼                             ║
 ║  ⑨ APPLICATION GUARD   unifiedGuard.ts            ║
 ║     parse RPT authorization.permissions[]         ║
 ║     rsname == "project:{id}"  →  scope rank       ║
 ║             admin ⊇ member ⊇ viewer               ║
 ║     GET metadata → viewer                         ║
 ║     writes       → member                         ║
 ║     DELETE proj  → admin                          ║
 ║     ✗ → 403                                       ║
 ╚═══════════════════════════════════════════════════╝
```

---

## 3. Edge / ingress

Ingress uses **Gateway API** (`Gateway` + `HTTPRoute`), not Istio `VirtualService` — the legacy VirtualService path exists but is disabled.

| Setting | Value |
|---|---|
| Resource | `gateway.networking.k8s.io/v1` `Gateway` |
| Name / namespace | `agentstudio-gateway` in `agentstudio-edge` |
| Class | `istio` (istiod auto-provisions the Deployment/Service) |
| Listeners | HTTP 80, HTTPS 443 |
| TLS | `Terminate` on 443, cert from Secret `nemo-gateway-tls` |
| Cert source | NetApp provisioning service (prod) · cert-manager (KIND) |

### Exposed hostnames

| Host | Backend |
|---|---|
| `app.<endpoint>` | config-service, UI, agents, KB, workflow, analytics |
| `auth.<endpoint>` | Keycloak |
| `catalog.<endpoint>` | Lakekeeper |
| `workflows.<endpoint>` | Temporal UI |
| `phoenix.<endpoint>` | Phoenix (LLM traces) |
| `s3.<endpoint>` | apigateway-service (SigV4) |
| `grafana.<endpoint>` | grafana-proxy (OIDC) |

`app.<endpoint>` path-routes to each service (`/api/v1` → config-service, `/agents-maf` → agent-service-maf, `/kb` → kb-retrieval-service, and so on).

---

## 4. Edge authentication

### JWT is validated twice — at edge AND at the mesh

| Layer | Mechanism | Verifies signature? |
|---|---|---|
| Edge (Istio) | `RequestAuthentication` on the gateway pod | **Yes** (Envoy jwt_authn) |
| Mesh (Istio) | `RequestAuthentication` per namespace | **Yes** |
| App (config-service, workflow-engine) | decode payload only | No — trusts the sidecar |
| App (agent-service-maf) | trusts `X-User-ID` from the gateway | No — trusts network isolation |

> ⚠️ Edge and mesh JWT configs are deliberately independent. **Unintentional divergence causes edge-pass / mesh-401** — a documented footgun.

### Keycloak model

Realm `nemo`:

| Client | Type | Purpose |
|---|---|---|
| `agent-studio-api` | bearer-only resource server | Audience target; hosts Authorization Services |
| `agent-studio-ui` | public SPA, Auth Code + **PKCE S256** | Browser login |
| per-service confidential clients | client_credentials | Service-to-service tokens |
| Entra ID broker | OIDC IdP (PKCE S256) | Upstream corporate login |

Authorization Services resource model:

```text
   resource type : urn:agent-studio:resource-types:project
   scopes        : admin · member · viewer
   enforcement   : ENFORCING,  decision strategy AFFIRMATIVE
   platform roles: platform-admin · platform-member
```

### The UMA → RPT swap

This is the distinctive part. On any project-scoped path, the gateway exchanges the user's access token for a **Requesting Party Token** carrying that user's permissions for that specific project:

```text
   inbound:  Bearer <access_token>        path /api/v1/projects/{id}/...
        │
        ▼  Lua EnvoyFilter
   POST Keycloak token endpoint
        grant_type = urn:ietf:params:oauth:grant-type:uma-ticket
        audience   = agent-studio-api
        permission = project:{id}#admin,member,viewer
        │
        ├─ 200      → replace Authorization header with the RPT
        ├─ 401/403  → short-circuit with the same status
        └─ other    → 502              ← FAIL CLOSED
```

The downstream app then reads `authorization.permissions[]` out of the RPT instead of querying Keycloak itself.

---

## 5. Service mesh — pod-to-pod

### mTLS

`PeerAuthentication` mode **STRICT**, applied to **9 namespaces**:

```text
  agentstudio-edge · agentstudio-console · agentstudio-workers
  agentstudio-llm-gateway · agentstudio-services · agentstudio-platform
  agentstudio-identity · monitoring · database
```

Port-level `PERMISSIVE` exceptions exist only for: the gateway's 80/443 (browsers have no SPIFFE cert), Keycloak bootstrap jobs, and Prometheus metrics scrape ports.

### SPIFFE identity

Istio issues each workload a cert with a URI SAN:

```text
   spiffe://cluster.local/ns/<namespace>/sa/<serviceaccount>
```

`AuthorizationPolicy` rules reference these as principals:

```text
   cluster.local/ns/agentstudio-services/sa/config-service
```

**XFCC handling:** an EnvoyFilter strips any inbound `x-forwarded-client-cert` and re-injects it from the *verified* mTLS peer identity — so the header can't be spoofed by a caller.

### Allow-lists

Each entry renders one ALLOW policy. Representative pairs:

| Policy | Target | Allowed principals |
|---|---|---|
| `allow-services-to-kb-retrieval` | kb-retrieval-service | agent-service, agent-service-maf |
| `allow-services-to-bifrost` | bifrost | 7 named service accounts |
| `allow-bifrost-and-config-to-mcp-runners` | mcp-stdio-runner | bifrost-proxy, config-service |
| `allow-services-to-config-service` | config-service | workflow-engine, agent-service(-maf), storage-manager, workers |

**NetworkPolicies** provide a second, non-Istio layer (ingress/egress per workload), including dynamically generated ones for MCP runner pods.

---

## 6. Application-layer RBAC

| Service | Enforcement |
|---|---|
| **config-service** | **Primary** — parses RPT permissions, full project scope check |
| agent-service-maf | Gateway identity + route-level project match |
| workflow-engine | User presence only — **no project scope check** (known regression) |

config-service scope hierarchy and method mapping:

```text
   admin  ⊇  member  ⊇  viewer

   GET metadata            → viewer
   writes                  → member
   DELETE project,
   service-account secret  → admin
   /api/v1/gateway,
   /api/v1/governance      → platform-member role
```

**Service (non-user) callers** carry no `email` claim; the guard passes them through and the mesh `AuthorizationPolicy` is the sole gate.

---

## 7. Service-to-service authentication

```text
   agent-service-maf ──┬── mTLS SPIFFE ──► config-service
                       │   + client_credentials token (Keycloak)
                       │     cached, 60s refresh leeway
                       │
                       ├── mTLS SPIFFE ──► Bifrost (LLM gateway)
                       │   + per-project virtual key
                       │     as-proj-{projectId}-vk
                       │     ✱ never falls back to a cluster master key
                       │
                       └── mTLS SPIFFE ──► kb-retrieval-service
```

The virtual key is resolved per project from config-service and cached for 60s. The explicit refusal to fall back to a master key is what keeps a project's LLM spend and access scoped to that project.

---

## 8. Secrets — "no plaintext credentials"

```text
   user enters provider credential (Azure OpenAI / Bedrock / …)
        │
        ▼
   config-service CredentialService
        │  creates K8s Secret:  cred-{projectId}-{provider}-{shortId}
        ▼
   DB row stores only  secretName  ──►  never the credential itself
        │
        ▼
   consuming pod: envFrom / volume mount, materialized at runtime
        │
        └─ MCP runtime creds carry a checksum annotation:
              mcp.nemo/runtime-cred-checksum: <sha256[:16]>
           → rotating the Secret forces a rolling restart
```

| Secret | Created by | Name pattern |
|---|---|---|
| Provider/model credentials | config-service `CredentialService` | `cred-{projectId}-{provider}-{shortId}` |
| Bifrost project VK | config-service governance | `as-proj-{projectId}-vk` |
| MCP runtime credentials | `MCPRuntimeManager` | `mcp-runtime-cred-{serverId}` |
| Keycloak OIDC client secrets | identity bootstrap jobs | `keycloak-oidc-secrets` |
| Gateway TLS | provisioning service / cert-manager | `nemo-gateway-tls` |

**Cloud:** Secrets Store CSI driver with 60s rotation polling, plus Azure Workload Identity federation — so there are no static cloud credentials in the cluster.

---

## 9. Tool / MCP isolation

Each managed MCP server gets its own provisioned, isolated footprint:

```text
   MCPRuntimeManager creates per server:
     ├─ Deployment + Service
     ├─ dedicated K8s Secret for env vars
     ├─ runtime credential Secret (checksum-rolled)
     ├─ per-server ServiceAccount (+ ClusterRoleBinding only if the
     │    catalog entry requires K8s API access)
     └─ NetworkPolicy: ingress from bifrost + config-service ONLY
```

The catalog drives the security profile — e.g. `network-access` opens specific egress ports; `allowedTools` gates which tools the server may expose.

---

## 10. Runtime guardrails (agent layer)

`agent-service-maf/guardrails/catalog/` — registered guardrails by phase:

| Phase | Guardrails |
|---|---|
| **Input** | `prompt_injection`, `pii_masker`, `pci_masker`, `content_filter`, `adversarial_unicode`, `input_validator`, `language`, `word_blocklist`, `custom_regex`, `secret_leakage` |
| **Output** | `pii_masker`, `phi_masker`, `pci_masker`, `content_filter`, `system_prompt_leakage`, `secret_leakage`, `output_sanitizer`, `output_length`, `schema_validator`, `word_blocklist`, `custom_regex` |
| **Tool** | `tool_authorizer`, `tool_call_counter`, `tool_param_validator`, `tool_result_guardrail` |

`ToolAuthorizer` enforces max-calls-per-request plus an allowlist/denylist by tool name.

---

## 11. Namespace topology

```text
  istio-system             istiod, Gateway API controller
  ───────────────────────────────────────────────────────────────
  agentstudio-edge         gateway, HTTPRoutes, edge EnvoyFilters, TLS
  agentstudio-identity     Keycloak
  agentstudio-console      UI
  agentstudio-services     config-service, workflow-engine,
                           agent-service-maf, kb-retrieval, MCP runners, TEI
  agentstudio-workers      Temporal workers
  agentstudio-llm-gateway  Bifrost
  agentstudio-platform     Temporal, Lakekeeper, Redis
  monitoring               Prometheus, Grafana, Phoenix, OTel
  database                 PostgreSQL

  CONTROL PLANE : edge · identity · console · config-service · workflow-engine
  DATA PLANE    : agent-service-maf · Bifrost · workers · MCP runners ·
                  kb-retrieval · TEI
```

---

## 12. Enforcement summary — what rejects what

| Hop | Enforcer | Rejects |
|---|---|---|
| Browser → Gateway | Envoy TLS termination | Bad/missing cert (handshake) |
| Gateway jwt_authn | `RequestAuthentication` | Invalid JWT → **401** |
| Gateway UMA filter | Lua EnvoyFilter → Keycloak | No project permission → **401/403**; KC error → **502** |
| Gateway routing | `AuthorizationPolicy edge-require-jwt` | No matching ALLOW rule |
| Transport | mTLS STRICT | No valid SPIFFE cert → connection reset |
| Sidecar jwt_authn | mesh `RequestAuthentication` | Invalid JWT → **401** |
| Sidecar authz | allow-list `AuthorizationPolicy` | Wrong SPIFFE principal → **403** |
| config-service app | `unifiedGuard` | Insufficient project scope → **403** |
| MCP tool call | mesh allow-list + NetworkPolicy | Unauthorized caller |
| LLM call | project VK + mesh allow-list | Wrong/missing virtual key |

---

## 13. Known gaps

Documented honestly — these are real and worth knowing before discussing the architecture.

| Gap | Detail |
|---|---|
| **No namespace default-deny** | `defaultDeny.enabled: false`. Per-workload allow-lists *do* deny-by-default for targeted workloads (Istio denies anything not matching once an ALLOW exists), but workloads with no policy are open |
| **No RPT cache** | Every project-scoped request makes a synchronous Keycloak round-trip. Design doc specifies a 5-minute cache; not implemented. Latency + availability coupling |
| **workflow-engine project scope** | Validates user presence but doesn't parse RPT permissions — regression being restored |
| **Phoenix unauthenticated** | Internet-reachable, exempt from edge JWT, no OIDC of its own |
| **TLS minimum version not pinned** | No explicit `minProtocolVersion` in templates; Envoy defaults apply |
| **Project SA secrets base64-only** | Flagged as TODO in `ProjectServiceAccountService.ts` |
| **Per-agent identity / VK** | Agents within a project share one virtual key — no per-agent scoping |
| **Confused deputy** | Tools execute with the project VK rather than the calling user's scope |
| **Action-class tool auth** | `tool_authorizer` gates by name and call count, not read/write/irreversible class; no human-in-the-loop for irreversible actions |
| **Admission policies inactive** | ValidatingAdmissionPolicies bind to an `env=production` label not present on the namespaces |

---

## Key reference files

| Layer | Path |
|---|---|
| Gateway / TLS | `deployments/helm/edge/templates/gateway-istio.yaml` |
| Edge JWT | `deployments/helm/edge/templates/request-authn-istio.yaml` |
| Edge routing authz | `deployments/helm/edge/templates/authz-edge-require-jwt-istio.yaml` |
| UMA → RPT | `deployments/helm/edge/templates/envoyfilter-uma-rpt-istio.yaml` |
| Parity headers | `deployments/helm/edge/templates/envoyfilter-parity-headers-istio.yaml` |
| Mesh mTLS | `deployments/helm/edge/istio-mesh-policies/templates/policies/peer-authentication.yaml` |
| Mesh JWT + authz | `request-authn-mesh.yaml`, `authz-policy.yaml`, `istio-mesh-policies/values.yaml` |
| XFCC | `deployments/helm/edge/templates/envoyfilter-xfcc.yaml` |
| Keycloak realm | `deployments/helm/identity/realms/agent-studio-realm.json` |
| Project RBAC | `src/nemo/config-service/middleware/unifiedGuard.ts` |
| Service auth | `src/nemo/agent-service-maf/src/agent_service_maf/config/service_auth.py` |
| LLM virtual keys | `src/nemo/agent-service-maf/src/agent_service_maf/gateway/project_vk_resolver.py` |
| MCP provisioning | `src/nemo/config-service/services/MCPRuntimeManager.ts` |
| Guardrails | `src/nemo/agent-service-maf/src/agent_service_maf/guardrails/catalog/` |
| Design doc | `docs/design/agent-studio-security-stack.md` |

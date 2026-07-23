/**
 * unifiedGuard — the single, merged authorization guard for config-service.
 *
 * Simplified mesh-first model: the guard asks ONE question — does this request
 * carry a JWT with an email claim (= a user)? If yes, enforce per-route scope.
 * If no, call next() — the mesh AuthorizationPolicy (PR #274) is the sole gate
 * for east-west service traffic.
 *
 * Decision order:
 *   1. `policy.public`   → allow unconditionally (health / setup).
 *   2. `!payload?.email` → next() immediately. Covers both tokenless workers
 *      (post-PR#249) and SA tokens (pre-PR#249, no email claim).
 *      The mesh AuthorizationPolicy is the gate; no X-Service-Caller needed.
 *   3. email present     → user confirmed. Run per-route user policy
 *      (context / roles / per-project scope). Return 403 if policy not met.
 *
 * Decode-only: this guard NEVER verifies a JWT signature. The Istio sidecar
 * `RequestAuthentication` does that at every hop before app code runs.
 *
 * After PR #249 (SA token removal): simplify step 2 to `if (!payload) next()`.
 */
import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { UserClaims } from '@agentstudio/common';
import { get_logger } from '@agentstudio/observability-client-runtime';

/**
 * Per-project scope hierarchy: `admin ⊇ member ⊇ viewer`.
 *
 * Defined locally (rather than imported from @agentstudio/common) so this guard
 * has no dependency on the shared application-guards library — the merged guard
 * builds its context inline and needs only this scope vocabulary.
 */
export type ProjectScopeName = 'admin' | 'member' | 'viewer';

/**
 * The in-process auth context the user lane attaches to `req.agentStudioContext`.
 * Modelled locally to keep this guard self-contained; only the fields the guard
 * and downstream handlers consume are carried (never the raw JWT-standard claims,
 * which the Istio sidecar validates before app code runs).
 */
export interface AgentStudioContext {
  user_id: string;
  user_email: string;
  preferred_username: string;
  project_id?: string;
  realm_roles: string[];
  api_roles: string[];
  project_scopes?: ProjectScopeName[];
}

// `req.agentStudioContext` is the typed user context the user lane attaches for
// downstream handlers. Declared here so the file is self-contained; this merges
// with any identical augmentation from @agentstudio/common.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentStudioContext?: AgentStudioContext;
    }
  }
}

/** Per-project scope hierarchy: `admin ⊇ member ⊇ viewer`. */
const RANK: Record<ProjectScopeName, number> = { viewer: 1, member: 2, admin: 3 };

function isScope(s: unknown): s is ProjectScopeName {
  return s === 'viewer' || s === 'member' || s === 'admin';
}

/** What a USER must satisfy to call the route. */
export type UserPolicy =
  /** Any authenticated user (valid user token). */
  | { kind: 'context' }
  /** Holder of one of `roles` (realm or `agent-studio-api` client roles). */
  | { kind: 'roles'; roles: string[] }
  /**
   * Per-project scope. `scope` is the minimum rank required for the project the
   * request targets. The project id is read from `req.params[paramName]`
   * (default `projectId`), or from a header when `from.header` is set.
   */
  | { kind: 'project'; scope: ProjectScopeName; paramName?: string; from?: { header: string } };

export interface RoutePolicy {
  /** Reachable with no credentials at all (health / setup). */
  public?: boolean;
  /** What a USER (north-south) needs. Omit ⇒ guard has no user opinion. */
  user?: UserPolicy;
  // internalAllowed: REMOVED — mesh AuthorizationPolicy is the sole gate.
  // !payload?.email → next() handles both tokenless workers and SA tokens (pre-PR#249).
}

const BEARER_PREFIX = 'bearer ';

/**
 * base64url-decode the payload segment of the `Authorization: Bearer` JWT.
 * Returns `null` when the header/token is missing or structurally malformed —
 * the guard never throws on a bad token; callers without an email claim fall
 * through to the mesh gate. NO signature verification (sidecar's job).
 */
export function decodeJwtPayload(req: Request): Record<string, unknown> | null {
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;

  // Trim BEFORE the Bearer-prefix check so a header with leading whitespace
  // (e.g. "  Bearer <jwt>") is still recognized rather than mis-parsed.
  const trimmed = header.trim();
  // Require the `Bearer` scheme. The sidecar's RequestAuthentication validates
  // the token ONLY in the standard `Authorization: Bearer` location, so a
  // non-Bearer header (a bare token, or another scheme) was never
  // signature-checked upstream — decoding it here would risk treating an
  // unvalidated token as authenticated. Anything else falls through to the
  // non-user (mesh-gated) path.
  if (!trimmed.toLowerCase().startsWith(BEARER_PREFIX)) return null;
  const value = trimmed.slice(BEARER_PREFIX.length).trim();
  if (!value) return null;

  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(parts[1])) return null;

  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    if (!json) return null;
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Human-readable messages keyed by the stable machine `code`. The `code` stays
 * fixed for programmatic clients while `message` gives operators and logs a
 * descriptive reason (matching the convention used by the legacy guards such as
 * permissionsGuard). Falls back to the code itself if a mapping is missing.
 */
const REJECT_MESSAGES: Record<string, string> = {
  token_missing_or_invalid: 'Missing or invalid authentication token',
  role_insufficient: 'User does not have the required platform role',
  project_id_missing: 'Project id is required for this request',
  context_project_id_missing: 'Project id is required and must match the request context',
  scope_insufficient: 'User does not have the required scope for this project',
  user_not_allowed: 'User credentials are not permitted on this route',
};

function reject(res: Response, status: number, code: string): void {
  const error = status >= 500 ? 'Internal Server Error' : status === 403 ? 'Forbidden' : 'Unauthorized';
  res.status(status).json({ error, code, message: REJECT_MESSAGES[code] ?? code });
}

/** Resolve the project id a `project`-kind policy authorizes against. */
function resolveProjectId(req: Request, policy: Extract<UserPolicy, { kind: 'project' }>): string {
  if (policy.from?.header) {
    const raw = req.headers[policy.from.header.toLowerCase()];
    // Trim so a templated header like " proj1 " still matches the RPT entry.
    return str(Array.isArray(raw) ? raw[0] : raw).trim();
  }
  return str(req.params[policy.paramName ?? 'projectId']).trim();
}

/**
 * Run the per-route USER policy against a decoded user token. Calls `next()` on
 * success and attaches `req.agentStudioContext`; otherwise writes a 403 and
 * returns without calling `next()`.
 */
function runUserChecks(
  policy: UserPolicy,
  payload: Record<string, unknown>,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const realmAccess = payload.realm_access as Record<string, unknown> | undefined;
  const resourceAccess = payload.resource_access as Record<string, unknown> | undefined;
  const apiClient = resourceAccess?.['agent-studio-api'] as Record<string, unknown> | undefined;

  const ctx: AgentStudioContext = {
    user_id: str(payload.sub),
    user_email: str(payload.email),
    preferred_username: str(payload.preferred_username),
    realm_roles: strArray(realmAccess?.roles),
    api_roles: strArray(apiClient?.roles),
  };

  if (policy.kind === 'roles') {
    const have = new Set([...ctx.realm_roles, ...ctx.api_roles]);
    if (!policy.roles.some((r) => have.has(r))) {
      return reject(res, 403, 'role_insufficient');
    }
  }

  if (policy.kind === 'project') {
    const projectId = resolveProjectId(req, policy);
    if (!projectId) return reject(res, 403, 'project_id_missing');

    const authorization = payload.authorization as Record<string, unknown> | undefined;
    const permissions = Array.isArray(authorization?.permissions) ? authorization!.permissions : [];
    const match = (permissions as unknown[]).find(
      (p): p is Record<string, unknown> =>
        typeof p === 'object' && p !== null && (p as Record<string, unknown>).rsname === `project:${projectId}`,
    );
    // No permission entry for this project → the holder has nothing on it.
    if (!match) return reject(res, 403, 'context_project_id_missing');

    const projectScopes = strArray(match.scopes).filter(isScope);
    const granted = projectScopes.reduce((m, s) => Math.max(m, RANK[s]), 0);
    if (granted < RANK[policy.scope]) return reject(res, 403, 'scope_insufficient');

    ctx.project_id = projectId;
    ctx.project_scopes = projectScopes;
  }

  req.agentStudioContext = ctx;
  // Also populate the legacy `req.user`: on smoke routes the global
  // createAuthMiddleware is bypassed, and some handlers still read
  // `req.user?.sub` for actor attribution (e.g. dataSetRoutes `modifiedBy`).
  const userClaims: UserClaims = { sub: ctx.user_id };
  if (ctx.user_email) userClaims.email = ctx.user_email;
  if (ctx.preferred_username) userClaims.preferred_username = ctx.preferred_username;
  const name = str(payload.name);
  if (name) userClaims.name = name;
  if (ctx.project_id) userClaims['agentstudio.project_id'] = ctx.project_id;
  req.user = userClaims;
  return next();
}

/**
 * Build the merged guard for one route. See the module header for the decision
 * order. Returns an Express `RequestHandler`.
 */
export function guard(policy: RoutePolicy): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1) Public — no credentials required.
    if (policy.public) return next();

    // 2) Decode the JWT. No email claim = not a user (no JWT, or SA token pre-PR#249).
    //    Email is the intentional user discriminator — human tokens carry it;
    //    machine/SA tokens omit it. Mesh AuthorizationPolicy is the gate for
    //    non-user callers. After PR #249: simplify to if (!payload) return next()
    const payload = decodeJwtPayload(req);
    if (!payload?.email) return next();

    // 3) User token confirmed (has email). Enforce the route policy.
    if (!policy.user) return reject(res, 403, 'user_not_allowed'); // safety: guard({}) miscall
    return runUserChecks(policy.user, payload as Record<string, unknown>, req, res, next);
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Global policy-table guard.
//
// Unlike `guard(policy)` (mounted per-router), `unifiedGuardGlobal()` is a
// single app-level middleware that authorizes EVERY config-service route by
// matching the request path/method against an ordered policy table. This makes
// the merged guard the sole authorizer for the whole API (replacing the global
// createAuthMiddleware).
//
// ───────────────────────────────────────────────────────────────────────────

// Policy vocabulary. Token-less / no-email (service) callers pass on ANY policy
// via `!payload?.email → next()` — the mesh AuthorizationPolicy is the gate for
// which services may reach config-service. There is therefore NO user/service
// "dual" distinction at the app layer: a route simply states the USER scope it
// requires (services ride through regardless).
const POL = {
  ctx:      { user: { kind: 'context' } } as RoutePolicy,
  viewer:   { user: { kind: 'project', scope: 'viewer' } } as RoutePolicy,
  member:   { user: { kind: 'project', scope: 'member' } } as RoutePolicy,
  admin:    { user: { kind: 'project', scope: 'admin' } } as RoutePolicy,
  platform: { user: { kind: 'roles', roles: ['platform-member'] } } as RoutePolicy,
};

// SCOPE GRANULARITY (per-endpoint scope map):
// Rules are method-aware so each endpoint gets its least-privilege scope rather
// than one blanket scope per group.
//
//   1. `viewer` reads are applied to content groups whose GETs return metadata.
//      Secret-adjacent groups (datasources, credentials, pipelines, models,
//      mcp-servers) also allow viewer GETs; writes stay `member`.
//   2. Worker (east-west) callers have no email claim → !payload?.email → next()
//      in the guard. No `internalAllowed` flag needed — the mesh AuthorizationPolicy
//      is the sole gate for which services may reach config-service.
//   3. Destructive project DELETE stays `admin`; project PUT (ProjectInit
//      callback) is admin-or-service; sub-resource writes stay `member`.
//
// Specific subpaths MUST precede the group/root fallbacks (first match wins).

interface GlobalRule {
  re: RegExp;
  methods?: string[]; // when set, the rule only matches these HTTP methods
  policy: RoutePolicy;
}

// Ordered: first match wins. Specific subpaths BEFORE the project-root nuance.
const GLOBAL_RULES: GlobalRule[] = [
  // Deployments: GUI lists them (gui api.ts /api/v1/deployments, /deployments/:id)
  // and storage-manager reads config (token-less, passes via !email). Writes
  // (register/sync + health/metrics) are mesh-gated (allow-list).
  { re: /^\/api\/v1\/deployments(\/|$)/, methods: ['GET'], policy: POL.ctx },

  // service-account returns the project CLIENT SECRET → admin on the user lane.
  // workflow-engine/workers also fetch it east-west (token-less → passes via
  // !email). MUST precede the content/secret group rules below.
  { re: /^\/api\/v1\/projects\/[^/]+\/service-account(\/|$)/, policy: POL.admin },

  // Project CONTENT groups. GETs return metadata only, so reads are `viewer`;
  // writes are `member`. Workers call these token-less (pass via !email)
  // regardless of method, so the viewer/member split only affects users.
  {
    re: /^\/api\/v1\/projects\/[^/]+\/(datasets|knowledgebases|agents|agent-teams|evaluation)(\/|$)/,
    methods: ['GET'],
    policy: POL.viewer,
  },
  {
    re: /^\/api\/v1\/projects\/[^/]+\/(datasets|knowledgebases|agents|agent-teams|evaluation)(\/|$)/,
    policy: POL.member,
  },

  // credentials/:id/secret-data returns RAW decrypted secret material — mesh
  // DENY blocks JWT callers at the sidecar; token-less workers pass via !email.

  // Project SECRET-ADJACENT groups (worker-callable, token-less via !email).
  // GETs return metadata / connection config references → `viewer`; writes stay
  // `member`. Raw-secret reads (credentials …/secret-data) are carved out — mesh
  // DENY blocks JWT user callers; token-less workers pass via !email.
  {
    re: /^\/api\/v1\/projects\/[^/]+\/(datasources|pipelines|models)(\/|$)/,
    methods: ['GET'],
    policy: POL.viewer,
  },
  {
    re: /^\/api\/v1\/projects\/[^/]+\/(datasources|pipelines|models)(\/|$)/,
    policy: POL.member,
  },
  {
    re: /^\/api\/v1\/projects\/[^/]+\/credentials(?!\/[^/]+\/secret-data(?:\/|$))(\/|$)/,
    methods: ['GET'],
    policy: POL.viewer,
  },
  {
    re: /^\/api\/v1\/projects\/[^/]+\/credentials(?!\/[^/]+\/secret-data(?:\/|$))(\/|$)/,
    policy: POL.member,
  },

  // Project membership: read-only in config-service (writes live in
  // workflow-engine). Gate on project membership to close cross-project
  // enumeration → `member`.
  { re: /^\/api\/v1\/projects\/[^/]+\/members(\/|$)/, policy: POL.member },

  // buckets: workflow-engine creates/reads/deletes project buckets during
  // ProjectInit / ProjectDelete (config.go CreateBucket/GetBucket/DeleteBucket)
  // token-less, and the GUI hits the per-bucket health probe as a member user.
  // MUST precede the USER-only group rule below (which lists buckets too).
  { re: /^\/api\/v1\/projects\/[^/]+\/buckets(\/|$)/, policy: POL.member },

  // mcp-servers GET: agent-service-maf reads east-west (token-less); UI
  // toolsets/agents list servers as a viewer. Writes stay member-only.
  { re: /^\/api\/v1\/projects\/[^/]+\/mcp-servers(\/|$)/, methods: ['GET'], policy: POL.viewer },

  // Project USER-only groups (no worker callers). workspace-templates GETs are
  // catalog reads → `viewer`; the rest stay `member`.
  { re: /^\/api\/v1\/projects\/[^/]+\/workspace-templates(\/|$)/, methods: ['GET'], policy: POL.viewer },
  { re: /^\/api\/v1\/projects\/[^/]+\/providers(\/|$)/, methods: ['GET'], policy: POL.viewer },
  {
    re: /^\/api\/v1\/projects\/[^/]+\/(mcp-servers|workspace-templates|workspaces|providers|overview-dataset-metrics|facets)(\/|$)/,
    policy: POL.member,
  },

  // Project root, method-specific: PUT is the ProjectInit metadata callback
  // (admin user; workflow-engine also calls it token-less via !email); DELETE is
  // destructive → admin; PATCH is a member write; GET is a viewer read that
  // workflow-engine also calls token-less (config.go fetchProjectStorageRoot).
  { re: /^\/api\/v1\/projects\/[^/]+$/, methods: ['PUT'], policy: POL.admin },
  { re: /^\/api\/v1\/projects\/[^/]+$/, methods: ['DELETE'], policy: POL.admin },
  { re: /^\/api\/v1\/projects\/[^/]+$/, methods: ['PATCH'], policy: POL.member },
  { re: /^\/api\/v1\/projects\/[^/]+$/, methods: ['GET'], policy: POL.viewer },
  { re: /^\/api\/v1\/projects$/, policy: POL.ctx }, // create / list

  // Platform-wide admin: gateway (Bifrost provider/model admin) and governance
  // (virtual keys / budgets) require the platform-member role, like platform MCP.
  { re: /^\/api\/v1\/platform\/mcp-servers(\/|$)/, policy: POL.platform },
  { re: /^\/api\/v1\/(gateway|governance)(\/|$)/, policy: POL.platform },

  // No-project user surfaces (identity only — global read-only / query data).
  {
    re: /^\/api\/v1\/(search|evaluation|mcp-server-catalog|explorer|guardrails|storage-classes)(\/|$)/,
    policy: POL.ctx,
  },
];

/**
 * Paths reachable with no authentication at all. Mirrors the legacy
 * createAuthMiddleware public-path rules (src/common/src/middleware/auth.ts) so
 * the merged guard does not diverge: each entry matches its exact path plus
 * sub-paths (`/swagger/...`) but NOT prefix look-alikes like `/swaggerify`, and
 * the bare root `/` is intentionally not public.
 */
const PUBLIC_PATHS = ['/health', '/ready', '/swagger', '/swagger.json', '/docs', '/api/v1/setup'];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some(p => path === p || path.startsWith(p + '/'));
}

/**
 * Collapse trailing slash(es) so the `$`-anchored policy rules still match the
 * variant Express's default (non-strict) router accepts. Without this,
 * `/api/v1/projects/p1/` reaches the SAME handler as `/api/v1/projects/p1` but
 * the anchored regexes (project root, credentials `secret-data`) would miss it
 * and the request would fall back to the weaker `POL.ctx` default — an authz
 * bypass / privilege escalation. The bare root `/` is preserved.
 */
function stripTrailingSlash(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/\/+$/, '') || '/';
}

/**
 * Routes whose sensitive access control moved to the mesh AuthorizationPolicy.
 * Intentionally unmapped in GLOBAL_RULES — suppress the gap warning so worker
 * traffic does not spam logs.
 */
const MESH_GATED_PATH_RES: RegExp[] = [
  /^\/api\/v1\/internal\//,
  /^\/api\/v1\/workspaces(\/|$)/,
  /^\/api\/v1\/buckets\//,
  /^\/api\/v1\/projects\/[^/]+\/credentials\/[^/]+\/secret-data$/,
];

function isMeshGatedPath(path: string): boolean {
  const normalized = stripTrailingSlash(path);
  return MESH_GATED_PATH_RES.some((re) => re.test(normalized));
}

/** Resolve the global policy for a request, or `null` if unmapped. */
export function resolveGlobalPolicy(method: string, path: string): RoutePolicy | null {
  const normalized = stripTrailingSlash(path);
  for (const rule of GLOBAL_RULES) {
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (rule.re.test(normalized)) return rule.policy;
  }
  return null;
}

/**
 * App-level merged guard: authorizes EVERY route via the policy table. Install
 * once (instead of the global createAuthMiddleware) to make the merged guard the
 * sole authorizer. Unmapped routes fall back to `{ user: context }` for callers
 * with an email claim; token-less / no-email callers still pass through to the
 * mesh gate. Gaps are logged so they surface in testing.
 */
export function unifiedGuardGlobal(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isPublicPath(req.path)) return next();

    const policy = resolveGlobalPolicy(req.method, req.path);
    // Only the /api/v1/* surface is described by the policy table, so confine the
    // "unmapped route" warning to that prefix; other non-public paths (e.g. `/`)
    // still fall back to POL.ctx below but should not generate noisy gap warnings.
    if (!policy && req.path.startsWith('/api/v1/') && !isMeshGatedPath(req.path)) {
      try {
        get_logger().warn('unified_guard_unmapped_route', { method: req.method, path: req.path });
      } catch {
        /* never block on logging */
      }
    }
    // App-level middleware runs before routing, so req.params is empty — extract
    // the project id from the path so the project-scope lane can resolve it.
    const m = req.path.match(/^\/api\/v1\/projects\/([^/]+)/);
    if (m) (req.params as Record<string, string>).projectId = m[1];

    return guard(policy ?? POL.ctx)(req, res, next);
  };
}

export const __testing = { RANK, resolveProjectId, resolveGlobalPolicy };

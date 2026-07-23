/**
 * Resolved request principal — the audited author of any write.
 *
 * Built by `middleware/auth.ts` from gateway-injected headers
 * (X-User-ID, X-Agent-ID, X-Team-ID, X-Session-ID) and threaded
 * through every code path that touches a store.
 */
export type PrincipalKind = 'user' | 'agent' | 'team' | 'service';

export interface Principal {
  /** Primary kind used to attribute audit trailers. */
  kind: PrincipalKind;
  /** Stable id for the kind: keycloak sub for user, agent id, team id, service name. */
  id: string;
  /** Human-readable name (for git commit author). */
  displayName?: string;
  /** Optional email (for git commit author). */
  email?: string;
}

export interface RequestContext {
  principal: Principal;
  projectId: string;
  sessionId?: string;
  agentId?: string;
  teamId?: string;
  /** Optional idempotency key (from MCP arg or `Idempotency-Key` HTTP header). */
  idempotencyKey?: string;
}

/** Encode a principal as the `X-Principal` audit-trailer value. */
export function encodePrincipal(p: Principal): string {
  return `${p.kind}:${p.id}`;
}

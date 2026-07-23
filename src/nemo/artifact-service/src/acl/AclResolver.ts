import {
  ArtifactStoreAclRole,
  ArtifactStoreAclRow,
  ArtifactStoreRow,
} from '../types/ArtifactStore';
import { Principal, RequestContext } from '../types/Principal';
import { AclRepo } from '../repo/AclRepo';

/**
 * Resolves the effective role for `(principal, store)`. P1 rules:
 *
 *  1. Implicit owner — store creator. ownerUserId is stored as
 *     `<sub>` for user creators and `service:<id>` for service-account
 *     creators (see storeRoutes.create); both kinds resolve to owner.
 *  2. Explicit `ArtifactStoreAcl` row matching the principal.
 *  3. When the principal is an `agent` acting within a team
 *     (X-Team-ID header populated), team-scoped ACL rows are also
 *     consulted and the max role wins. Without this, an agent's
 *     access would be the strict intersection of agent-grants and
 *     team-grants — but team membership is the more common path
 *     for "this agent inherits the team's permissions".
 *  4. Otherwise → no access.
 *
 * P2 adds `ProjectMember` inheritance and per-path scopes; those map onto
 * this resolver's return type without changing the call signature.
 */

export type EffectiveRole = ArtifactStoreAclRole | 'none';

const ROLE_RANK: Record<EffectiveRole, number> = {
  none: 0,
  reader: 1,
  writer: 2,
  owner: 3,
};

export function roleAtLeast(role: EffectiveRole, min: ArtifactStoreAclRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

function rankMax(a: EffectiveRole, b: EffectiveRole): EffectiveRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/**
 * True when the principal is the store's creator. Recognises both
 * `user:<sub>` (stored as the raw sub) and `service:<id>` ownership
 * formats produced by storeRoutes.create.
 */
function isImplicitOwner(principal: Principal, store: ArtifactStoreRow): boolean {
  if (principal.kind === 'user' && principal.id === store.ownerUserId) {
    return true;
  }
  if (principal.kind === 'service' && store.ownerUserId === `service:${principal.id}`) {
    return true;
  }
  return false;
}

export class AclResolver {
  constructor(private readonly acls: AclRepo) {}

  /**
   * Batched resolve. Used by /list-style endpoints to avoid the N+1
   * query pattern (a separate `find()` per store). Fetches every
   * relevant ACL row in a single SQL query, then resolves in-memory.
   * Returns a Map<storeId, EffectiveRole>.
   */
  async resolveMany(
    principalOrCtx: Principal | RequestContext,
    stores: ArtifactStoreRow[],
  ): Promise<Map<string, EffectiveRole>> {
    const ctx: RequestContext | null =
      'principal' in principalOrCtx ? principalOrCtx : null;
    const principal: Principal =
      'principal' in principalOrCtx ? principalOrCtx.principal : principalOrCtx;

    const result = new Map<string, EffectiveRole>();
    if (stores.length === 0) return result;

    // Implicit-owner pass (no SQL).
    const needAcl: ArtifactStoreRow[] = [];
    for (const s of stores) {
      if (isImplicitOwner(principal, s)) {
        result.set(s.id, 'owner');
      } else {
        result.set(s.id, 'none');
        needAcl.push(s);
      }
    }
    if (needAcl.length === 0) return result;

    // Build the principal pairs (always the direct principal; plus
    // the team if the principal is an agent acting within a team).
    const principals: Array<{
      principalType: 'user' | 'agent' | 'team' | 'service';
      principalId: string;
    }> = [{ principalType: principal.kind, principalId: principal.id }];
    if (ctx && principal.kind === 'agent' && ctx.teamId) {
      principals.push({ principalType: 'team', principalId: ctx.teamId });
    }

    const rows = await this.acls.findManyForStores(
      needAcl.map((s) => s.id),
      principals,
    );

    for (const r of rows) {
      const prev = result.get(r.storeId) ?? 'none';
      if (ROLE_RANK[r.role] > ROLE_RANK[prev]) {
        result.set(r.storeId, r.role);
      }
    }
    return result;
  }

  /**
   * Resolve the effective role. Accepts either a bare Principal (legacy
   * test path) or a full RequestContext (production path) — the latter
   * additionally consults team-scoped ACL rows when the principal is
   * an agent acting within a team.
   */
  async resolve(
    principalOrCtx: Principal | RequestContext,
    store: ArtifactStoreRow,
  ): Promise<EffectiveRole> {
    const ctx: RequestContext | null =
      'principal' in principalOrCtx ? principalOrCtx : null;
    const principal: Principal =
      'principal' in principalOrCtx ? principalOrCtx.principal : principalOrCtx;

    if (isImplicitOwner(principal, store)) return 'owner';

    let best: EffectiveRole = 'none';

    const direct = await this.acls.find(store.id, principal.kind, principal.id);
    if (direct) best = rankMax(best, direct.role);

    // Agent-in-team: also check the team's grant. Distinct from the
    // direct lookup above (which would key by 'agent', not 'team').
    if (ctx && principal.kind === 'agent' && ctx.teamId) {
      const team = await this.acls.find(store.id, 'team', ctx.teamId);
      if (team) best = rankMax(best, team.role);
    }

    return best;
  }

  /**
   * Pure resolver used by unit tests — applies the same rules to an
   * in-memory ACL list without touching the database.
   */
  static resolveFromRows(
    principalOrCtx: Principal | RequestContext,
    store: ArtifactStoreRow,
    rows: ArtifactStoreAclRow[],
  ): EffectiveRole {
    const ctx: RequestContext | null =
      'principal' in principalOrCtx ? principalOrCtx : null;
    const principal: Principal =
      'principal' in principalOrCtx ? principalOrCtx.principal : principalOrCtx;

    if (isImplicitOwner(principal, store)) return 'owner';

    let best: EffectiveRole = 'none';
    for (const r of rows) {
      if (r.storeId !== store.id) continue;
      if (r.principalType === principal.kind && r.principalId === principal.id) {
        best = rankMax(best, r.role);
      } else if (
        ctx &&
        principal.kind === 'agent' &&
        ctx.teamId &&
        r.principalType === 'team' &&
        r.principalId === ctx.teamId
      ) {
        best = rankMax(best, r.role);
      }
    }
    return best;
  }
}

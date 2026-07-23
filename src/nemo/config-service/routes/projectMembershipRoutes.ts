import { Router, Request, Response } from 'express';
import { getRouteKeycloakAuthzClient, parsePolicyName, KeycloakAuthzClient } from '../services/KeycloakAuthzClient';
import { getRouteKeycloakUserDirectory } from '../services/KeycloakClientService';

/**
 * Read-only project-membership endpoints backed by Keycloak Authorization
 * Services policies (the `usr-{userId}-proj-{projectId}-{role}` convention).
 *
 * These were previously served by workflow-engine — they were colocated there
 * because the Authz Admin client was already wired in Go. Per PR #31 review
 * (comment r3321434919), pure Keycloak queries with no Temporal involvement
 * belong in config-service. The corresponding *write* endpoints
 * (POST/DELETE/PUT on /projects/:projectId/members) remain in workflow-engine
 * because they are Temporal workflow starts.
 *
 * See docs/design/keycloak-per-project-authorization.md for the read-path
 * design (§6.1, §6.2) and the rationale for keeping writes in workflow-engine.
 */

const router = Router();

interface MemberEntry {
  userId: string;
  role: string;
  // Profile fields resolved from the Keycloak user directory. Optional because
  // a lookup can miss (deleted user) or the directory can be unreachable — in
  // either case we still return the userId + role rather than failing.
  username?: string;
  email?: string;
}

/**
 * GET /api/v1/projects/:projectId/members
 * Lists all members of a project by querying Keycloak user policies whose
 * names match `usr-*-proj-{projectId}-*`.
 *
 * Authorization: any authenticated user. This endpoint intentionally does not
 * gate on project membership today. Project-scoped authorization for
 * config-service read endpoints is being introduced centrally by the guard
 * layer (PR #82), which will enforce access before the handler runs — so we
 * avoid scattering ad-hoc per-handler authz/enrichment checks here. It is also
 * used during onboarding (e.g. a freshly-added admin listing who else is on a
 * project they were just added to).
 */
router.get('/api/v1/projects/:projectId/members', async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  const callerSub = req.user?.sub;
  const callerRoles: string[] = (req.user as any)?.realm_access?.roles ?? [];
  const isPlatformAdmin = callerRoles.includes('platform-admin');

  if (!req.user?.sub) {
    return res.status(401).json({ error: 'authentication required' });
  }

  let kc: KeycloakAuthzClient;
  try {
    kc = getRouteKeycloakAuthzClient();
  } catch (err: any) {
    console.error(`[ProjectMembership] keycloak client init failed: ${err.message}`);
    return res.status(500).json({ error: 'internal configuration error' });
  }

  // Narrow the server-side query to this project's policies only.
  // Keycloak's `?search=true` does substring matching, so `-proj-{projectId}-`
  // returns every `usr-{userId}-proj-{projectId}-{role}` for this project
  // without scanning the whole realm's user policies.
  const searchToken = `-proj-${projectId}-`;
  let policies;
  try {
    policies = await kc.listPolicies(searchToken, 500);
  } catch (err: any) {
    console.error(`[ProjectMembership] listPolicies failed: ${err.message}`);
    return res.status(500).json({ error: 'failed to query membership' });
  }

  // Client-side filter remains as a defensive check against projectIds that
  // are substrings of other projectIds (parsePolicyName enforces exact match).
  const members: MemberEntry[] = [];
  for (const p of policies) {
    const parsed = parsePolicyName(p.name);
    if (parsed && parsed.projectId === projectId) {
      members.push({ userId: parsed.userId, role: parsed.role });
    }
  }

  // Enrich each member with their profile (username/email) from the Keycloak
  // user directory. Best-effort: the policy store only carries the userId, so
  // we resolve names here. If the directory lookup fails wholesale we still
  // return userId + role rather than 500ing the listing.
  try {
    const profiles = await getRouteKeycloakUserDirectory().getUsersByIds(
      members.map((m) => m.userId)
    );
    for (const m of members) {
      const profile = profiles.get(m.userId);
      if (profile) {
        m.username = profile.username;
        m.email = profile.email;
      }
    }
  } catch (err: any) {
    console.error(`[ProjectMembership] user directory lookup failed: ${err.message}`);
  }

  return res.json({ projectId, members });
});

/**
 * GET /api/v1/users/:userId/projects — REMOVED.
 *
 * The caller's own project list is now served by `GET /api/v1/projects`
 * (routes/projectRoutes.ts), which joins the caller's Keycloak memberships onto
 * config-service project metadata. The old per-userId endpoint was an
 * own-identity-only lookup that returned bare {projectId, role}; folding it into
 * the metadata-bearing list endpoint removes a redundant path and the
 * cross-tenant enumeration surface it carried.
 */

export default router;

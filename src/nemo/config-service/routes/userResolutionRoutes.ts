import { Router } from 'express';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';
import { getRouteKeycloakUserDirectory } from '../services/KeycloakClientService';

/**
 * Internal user resolve-or-create endpoint.
 *
 * Called by the workflow-engine project-init workflow to turn invitee emails
 * into stable Keycloak user ids before granting per-project roles (authz
 * policies are keyed by userId, never email). config-service runs as the
 * master-realm admin (view-users + manage-users), so it can look up AND create
 * users with no extra Keycloak role grants — which is why this lives here and
 * not in workflow-engine (whose authz SA cannot read/create users).
 *
 * Mounted at `/api/v1/internal/users` in index.ts, behind the app-level auth
 * middleware — same service-to-service pattern as the other internal routes
 * (internal/projects, internal/reference-edges, ...). This is M2M, not
 * user-facing.
 */
const router = Router();

// Pragmatic email shape check — rejects empties / obvious garbage before we
// create an orphan Keycloak account. Not a full RFC 5322 validator.
//
// Written to be linear-time (no catastrophic/polynomial backtracking on
// adversarial input): the domain is dot-separated labels that cannot contain
// dots, so there is no ambiguous overlap between the quantified groups. A
// naive `[^\s@]+\.[^\s@]+` form is super-linear and trips ReDoS scanners.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Validate + normalize + dedupe the `emails` array from the request body.
 * Writes a 400 and returns null on any invalid/empty input.
 */
function parseEmails(req: { body?: unknown }, res: Parameters<typeof sendError>[0]): string[] | null {
  const body = (req.body ?? {}) as { emails?: unknown };
  const rawEmails = body.emails;
  if (!Array.isArray(rawEmails) || rawEmails.length === 0) {
    sendError(res, new Error('emails must be a non-empty array'), 400);
    return null;
  }
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const e of rawEmails) {
    const norm = typeof e === 'string' ? e.trim() : '';
    if (!norm || !EMAIL_RE.test(norm)) {
      sendError(res, new Error(`invalid email: ${String(e)}`), 400);
      return null;
    }
    if (!seen.has(norm)) {
      seen.add(norm);
      emails.push(norm);
    }
  }
  return emails;
}

/**
 * POST /api/v1/internal/users/resolve-or-create
 * body  { emails: string[] }
 * resp  { resolved: [{ email, userId, created }] }
 *
 * Dedupes the input. A hard create/lookup failure rejects (500) so the caller
 * can fail/retry — an explicitly requested invitee that cannot be provisioned
 * must not be silently dropped. Used by the add-member / project-init flows.
 */
router.post(
  '/resolve-or-create',
  asyncHandler(async (req, res) => {
    const emails = parseEmails(req, res);
    if (!emails) return;

    const kc = getRouteKeycloakUserDirectory();
    const resolvedMap = await kc.resolveOrCreateUsers(emails);

    const resolved = emails.map((email) => {
      const r = resolvedMap.get(email)!;
      return { email, userId: r.userId, created: r.created };
    });
    sendSuccess(res, { resolved });
  })
);

/**
 * POST /api/v1/internal/users/resolve
 * body  { emails: string[] }
 * resp  { resolved: [{ email, userId }] }   (userId is "" if no such user)
 *
 * Resolve-ONLY: never creates a user. Used by the change-role / remove-member
 * write paths, which must 404 on an unknown email rather than provisioning one.
 *
 * Unknown emails return an empty-string `userId` (not `null`): this is an M2M
 * contract consumed by workflow-engine's Go client, which decodes `userId`
 * into a `string` — an empty string is the unambiguous "not found" sentinel.
 */
router.post(
  '/resolve',
  asyncHandler(async (req, res) => {
    const emails = parseEmails(req, res);
    if (!emails) return;

    const kc = getRouteKeycloakUserDirectory();
    const resolvedMap = await kc.resolveUsers(emails);

    const resolved = emails.map((email) => ({
      email,
      userId: resolvedMap.get(email) ?? '',
    }));
    sendSuccess(res, { resolved });
  })
);

export default router;

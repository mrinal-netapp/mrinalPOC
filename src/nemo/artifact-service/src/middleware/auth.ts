import { Request, Response, NextFunction } from 'express';
import { Principal, RequestContext } from '../types/Principal';

/**
 * Extracts the resolved request principal from gateway-injected headers
 * and attaches a `ctx: RequestContext` to the express Request.
 *
 * The gateway is expected to have already validated the user's Keycloak
 * token; this service trusts the headers and only routes their values
 * into the audit log.
 *
 * Headers (case-insensitive):
 *   X-User-ID       Keycloak sub of the human user
 *   X-User-Email    Optional, used as the git commit author email
 *   X-User-Name     Optional, used as the git commit author display name
 *   X-Project-ID    Project scope for the call
 *   X-Session-ID    Session id (resolves the 'SESSION' ref sentinel)
 *   X-Agent-ID      When the call is on behalf of an agent invocation
 *   X-Team-ID       When the agent is acting within a team
 *   X-Service-Name  For service-to-service calls without a user
 *   Idempotency-Key Optional idempotency key for write calls
 */
export interface RequestWithCtx extends Request {
  ctx?: RequestContext;
}

export function buildAuthMiddleware() {
  return (req: RequestWithCtx, res: Response, next: NextFunction) => {
    const userId = headerOne(req, 'x-user-id');
    const userEmail = headerOne(req, 'x-user-email') ?? undefined;
    const userName = headerOne(req, 'x-user-name') ?? undefined;
    const projectId = headerOne(req, 'x-project-id');
    const sessionId = headerOne(req, 'x-session-id') ?? undefined;
    const agentId = headerOne(req, 'x-agent-id') ?? undefined;
    const teamId = headerOne(req, 'x-team-id') ?? undefined;
    const serviceName = headerOne(req, 'x-service-name') ?? undefined;
    const idempotencyKey = headerOne(req, 'idempotency-key') ?? undefined;

    if (!projectId) {
      res.status(400).json({ error: 'X-Project-ID header required' });
      return;
    }

    let principal: Principal;
    if (agentId) {
      principal = {
        kind: 'agent',
        id: agentId,
        displayName: userName,
        email: userEmail,
      };
    } else if (teamId) {
      principal = { kind: 'team', id: teamId, displayName: userName };
    } else if (userId) {
      principal = {
        kind: 'user',
        id: userId,
        displayName: userName,
        email: userEmail,
      };
    } else if (serviceName) {
      principal = { kind: 'service', id: serviceName };
    } else {
      res.status(401).json({ error: 'no principal headers present' });
      return;
    }

    req.ctx = {
      principal,
      projectId,
      sessionId,
      agentId,
      teamId,
      idempotencyKey,
    };
    next();
  };
}

function headerOne(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (!v) return null;
  return Array.isArray(v) ? v[0] : v;
}

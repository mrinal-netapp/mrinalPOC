import { Router, Response, NextFunction } from 'express';
import { RequestWithCtx } from '../../middleware/auth';
import { encodePrincipal } from '../../types/Principal';

export function buildWhoamiRouter(): Router {
  const router = Router();
  router.get('/whoami', (req: RequestWithCtx, res: Response, _next: NextFunction) => {
    const ctx = req.ctx!;
    res.json({
      principal: {
        encoded: encodePrincipal(ctx.principal),
        ...ctx.principal,
      },
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      teamId: ctx.teamId,
    });
  });
  return router;
}

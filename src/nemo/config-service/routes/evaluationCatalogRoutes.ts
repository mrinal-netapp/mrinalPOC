import { Router, Request, Response } from 'express';
import { getEvaluationRubricCatalog } from '../catalog/evaluationRubricCatalog';

const router = Router();

/**
 * GET /api/v1/evaluation/rubric-catalog
 * Static, read-only catalog of AI-judge dimensions and deterministic metrics
 * (label + description + enabled flag + output) plus the test-case sources.
 * Powers the "Configure AI judge" / "Configure deterministic metrics" dialogs.
 * Not project-scoped (mirrors /api/v1/mcp-server-catalog).
 */
router.get('/rubric-catalog', (_req: Request, res: Response) => {
  res.json(getEvaluationRubricCatalog());
});

export default router;

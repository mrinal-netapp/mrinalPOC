import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/lib/got', () => {
  const actual =
    jest.requireActual('../../src/lib/got') as typeof import('../../src/lib/got');
  return {
    ...actual,
    gotGet: jest.fn(),
    gotPatch: jest.fn(),
    gotPost: jest.fn(),
  };
});
jest.mock('../../src/lib/auth', () => ({
  getAuthHeaders: jest.fn().mockResolvedValue({ authorization: 'Bearer test' }),
  getServiceAccountToken: jest.fn().mockResolvedValue(null),
}));

import { ApplicationFailure } from '@temporalio/activity';
import { gotGet, gotPatch, gotPost } from '../../src/lib/got';
import {
  findPreviousRun,
  getEvaluationJob,
  loadEvaluationResults,
  loadFailedCaseIds,
  loadCaseArtifacts,
  loadRunSnapshot,
  promoteToRegression,
  recordTradeoffDecision,
  updateJobResults,
  updateJobStatus,
  writeAuditEvent,
} from '../../src/activities/config-service.activities';
import type {
  AuditEvent,
  EvaluationJob,
  EvaluationResults,
  EvaluationTemplate,
  MinimalProvenance,
} from '../../src/lib/evaluation';

const mockGotGet = gotGet as jest.MockedFunction<typeof gotGet>;
const mockGotPatch = gotPatch as jest.MockedFunction<typeof gotPatch>;
const mockGotPost = gotPost as jest.MockedFunction<typeof gotPost>;

function httpError(statusCode: number): Error & { response: { statusCode: number } } {
  const err = new Error(`HTTP ${statusCode}`) as Error & {
    response: { statusCode: number };
  };
  err.response = { statusCode };
  const got = jest.requireActual('got') as { HTTPError: new (...args: never[]) => Error };
  Object.setPrototypeOf(err, got.HTTPError.prototype);
  return err;
}

function makeResults(): EvaluationResults {
  return {
    verdict: 'pass',
    triggeredGates: [],
    dimensions: [],
    coverage: { total: 1, completed: 1, completedPct: 100 },
    infraFailureRate: 0,
    judgeCoverage: { scored: 0, target: 0, pct: 0 },
    preFlightNonPromotable: false,
    runStopped: false,
  };
}

function makeTemplate(): EvaluationTemplate {
  const now = '2026-06-01T00:00:00Z';
  return {
    templateId: 'tpl-1',
    projectId: 'proj-1',
    evalName: 'eval-x',
    createdAt: now,
    updatedAt: now,
    target: 'agent_version',
    agent: { agentTeam: 'team' },
    models: ['gpt-4o'],
    evaluationScope: 'full_agent_execution',
    suite: 'rag',
    evaluators: {
      strategy: 'deterministic',
      rubricPreset: 'none',
      enabledRubric: [],
      judgeEvalMode: 'pointwise',
      judgeSamplingMode: 'all',
      judgeStratifiedSlices: false,
      judgeGateWhenSampled: 'informational',
    },
    thresholds: {
      gates: [],
      coverageMinPct: 0,
      infraFailureMaxPct: 100,
      safetyP0Threshold: 0,
    },
    cases: {
      schemaVersion: 'golden_test_v1',
    },
    runMode: 'single',
  };
}

const baseProvenance: MinimalProvenance = {
  triggeredAt: '2026-06-01T00:00:00Z',
  agentRef: { projectId: 'proj-1', agentTeam: 'team' },
  models: ['gpt-4o'],
  rubricIds: [],
};

describe('config-service.activities', () => {
  const origEnv = { ...process.env };
  let storeRoot: string;

  beforeAll(async () => {
    storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsvc-test-'));
  });

  afterAll(async () => {
    await fs.rm(storeRoot, { recursive: true, force: true });
    process.env = origEnv;
  });

  beforeEach(() => {
    process.env['CONFIG_SERVICE_URL'] = 'http://config.test';
    process.env['NEMO_DEFAULT_STORE_ROOT'] = storeRoot;
    mockGotGet.mockReset();
    mockGotPatch.mockReset();
    mockGotPost.mockReset();
  });

  // ── loadRunSnapshot ───────────────────────────────────────────────

  describe('loadRunSnapshot', () => {
    it('stages template snapshot on disk and resolves jobInput + evalId + testCasesRef', async () => {
      // Cases live on the PVC at
      // `projects/{p}/evaluations/{evalId}/testcases/cases.jsonl`
      // and are loaded by the workflow's `validateTestCases` activity,
      // not here. `loadRunSnapshot` only stages the template + manifest.
      mockGotGet.mockResolvedValueOnce({
        runId: 'run-1',
        templateSnapshot: makeTemplate(),
        provenance: baseProvenance,
      });
      const out = await loadRunSnapshot({ runId: 'run-1', projectId: 'proj-1' });

      expect(out.jobInput.runId).toBe('run-1');
      expect(out.jobInput.evalId).toBe('eval-x');
      expect(out.templateId).toBe('tpl-1');
      // No datasetId on testCasesRef — the path is computed from
      // (projectId, evalId) in validateTestCases.
      expect(out.testCasesRef).not.toHaveProperty('datasetId');
      expect(out.jobFolderUri).toMatch(
        /^posix:\/\/\/projects\/proj-1\/evaluations\/eval-x\/runs\/run-1\/_input$/,
      );

      const stagedDir = path.join(
        storeRoot,
        'projects/proj-1/evaluations/eval-x/runs/run-1/_input',
      );
      await expect(
        fs.readFile(path.join(stagedDir, 'manifest.json'), 'utf8'),
      ).resolves.toContain('"runId": "run-1"');
      await expect(
        fs.readFile(path.join(stagedDir, 'template-snapshot.json'), 'utf8'),
      ).resolves.toContain('eval-x');
      // No `cases-snapshot.json` is written here — the JSONL audit copy
      // is staged by `validateTestCases` instead.
      await expect(
        fs.readFile(path.join(stagedDir, 'cases-snapshot.json'), 'utf8'),
      ).rejects.toThrow();
    });

    it('forwards filename on the test-cases pointer', async () => {
      const tpl = makeTemplate();
      tpl.cases = {
        schemaVersion: 'golden_test_v1',
        filename: 'rag-eval-v3.jsonl',
      };
      mockGotGet.mockResolvedValueOnce({
        runId: 'run-h',
        templateSnapshot: tpl,
        provenance: baseProvenance,
      });
      const out = await loadRunSnapshot({ runId: 'run-h', projectId: 'proj-1' });
      expect(out.testCasesRef).toEqual({
        filename: 'rag-eval-v3.jsonl',
      });
    });

    it('throws InvalidInputError when CONFIG_SERVICE_URL is unset', async () => {
      delete process.env['CONFIG_SERVICE_URL'];
      await expect(
        loadRunSnapshot({ runId: 'run-x', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('throws InvalidInputError when the row is missing templateSnapshot', async () => {
      mockGotGet.mockResolvedValueOnce({
        runId: 'run-3',
        provenance: baseProvenance,
      });
      await expect(
        loadRunSnapshot({ runId: 'run-3', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('throws NotFoundError on 404 from config-service', async () => {
      mockGotGet.mockRejectedValueOnce(httpError(404));
      await expect(
        loadRunSnapshot({ runId: 'run-404', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'NotFoundError' });
    });

    it('throws NotFoundError when row body is null', async () => {
      mockGotGet.mockResolvedValueOnce(null as unknown as never);
      await expect(
        loadRunSnapshot({ runId: 'run-null', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'NotFoundError' });
    });

    it('strips trailing slash from CONFIG_SERVICE_URL', async () => {
      process.env['CONFIG_SERVICE_URL'] = 'http://config.test/';
      mockGotGet.mockResolvedValueOnce({
        runId: 'run-tr',
        templateSnapshot: makeTemplate(),
        provenance: baseProvenance,
      });
      await loadRunSnapshot({ runId: 'run-tr', projectId: 'proj-1' });
      expect(mockGotGet).toHaveBeenCalledWith(
        'http://config.test/api/v1/projects/proj-1/evaluation/agents/runs/run-tr',
        expect.any(Object),
      );
    });
  });

  // ── update* (PATCH) ───────────────────────────────────────────────

  describe('updateJobStatus', () => {
    it('PATCHes the run with status + audit append', async () => {
      mockGotPatch.mockResolvedValueOnce(undefined as never);
      await updateJobStatus({
        runId: 'run-1',
        projectId: 'proj-1',
        status: 'running',
        auditContext: { actor: 'svc', reason: 'started', details: { x: 1 } },
      });
      expect(mockGotPatch).toHaveBeenCalledTimes(1);
      const [url, body] = mockGotPatch.mock.calls[0];
      expect(url).toBe(
        'http://config.test/api/v1/projects/proj-1/evaluation/agents/runs/run-1',
      );
      const reqBody = body as { status: string; auditAppend: Array<{ type: string; actor: string }> };
      expect(reqBody.status).toBe('running');
      // Transitional statuses (queued/running/aggregating) all map to
      // the canonical `evaluation.started` AuditAction; the specific
      // status is preserved on `data.transitionTo` for forensics.
      expect(reqBody.auditAppend[0]).toMatchObject({
        type: 'evaluation.started',
        actor: 'svc',
      });
      expect((reqBody.auditAppend[0] as { data?: { transitionTo?: string } }).data?.transitionTo).toBe('running');
    });

    it('maps 404 → NotFoundError', async () => {
      mockGotPatch.mockRejectedValueOnce(httpError(404));
      await expect(
        updateJobStatus({
          runId: 'run-x',
          projectId: 'proj-1',
          status: 'running',
          auditContext: { actor: 'svc' },
        }),
      ).rejects.toMatchObject({ type: 'NotFoundError' });
    });

    it('maps 4xx (non-404) → InvalidInputError', async () => {
      mockGotPatch.mockRejectedValueOnce(httpError(400));
      await expect(
        updateJobStatus({
          runId: 'run-x',
          projectId: 'proj-1',
          status: 'running',
          auditContext: { actor: 'svc' },
        }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('re-throws on 5xx without remapping (retryable)', async () => {
      mockGotPatch.mockRejectedValueOnce(httpError(503));
      await expect(
        updateJobStatus({
          runId: 'run-x',
          projectId: 'proj-1',
          status: 'running',
          auditContext: { actor: 'svc' },
        }),
      ).rejects.toThrow('HTTP 503');
    });
  });

  describe('updateJobResults', () => {
    it('updateJobResults PATCHes with results body', async () => {
      mockGotPatch.mockResolvedValueOnce(undefined as never);
      const results = makeResults();
      await updateJobResults({
        runId: 'run-1',
        projectId: 'proj-1',
        results,
      });
      expect(mockGotPatch).toHaveBeenCalledWith(
        'http://config.test/api/v1/projects/proj-1/evaluation/agents/runs/run-1',
        { results },
        expect.any(Object),
      );
    });
  });

  // ── reads ─────────────────────────────────────────────────────────

  describe('getEvaluationJob', () => {
    it('returns the row body on 200', async () => {
      const job = {
        runId: 'run-1',
        status: 'completed',
      } as unknown as EvaluationJob;
      mockGotGet.mockResolvedValueOnce(job);
      const out = await getEvaluationJob({ runId: 'run-1', projectId: 'proj-1' });
      expect(out).toBe(job);
    });

    it('throws NotFoundError when body is empty', async () => {
      mockGotGet.mockResolvedValueOnce(null as unknown as never);
      await expect(
        getEvaluationJob({ runId: 'run-1', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'NotFoundError' });
    });

    it('maps 404 → NotFoundError', async () => {
      mockGotGet.mockRejectedValueOnce(httpError(404));
      await expect(
        getEvaluationJob({ runId: 'run-1', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'NotFoundError' });
    });
  });

  describe('loadEvaluationResults', () => {
    it('returns empty array for empty input without any HTTP', async () => {
      const out = await loadEvaluationResults({
        runIds: [],
        projectId: 'proj-1',
      });
      expect(out).toEqual([]);
      expect(mockGotGet).not.toHaveBeenCalled();
    });

    it('returns results for runs that have them; silently drops failures + missing', async () => {
      mockGotGet
        .mockResolvedValueOnce({
          runId: 'a',
          status: 'completed',
          results: makeResults(),
        } as unknown as EvaluationJob)
        .mockResolvedValueOnce({
          runId: 'b',
          status: 'completed',
        } as unknown as EvaluationJob)
        .mockRejectedValueOnce(new Error('boom'));
      const out = await loadEvaluationResults({
        runIds: ['a', 'b', 'c'],
        projectId: 'proj-1',
      });
      expect(out).toHaveLength(1);
      expect(out[0].verdict).toBe('pass');
    });
  });

  // ── findPreviousRun (compare default-baseline lookup) ─────────────

  describe('findPreviousRun', () => {
    it('queries GET /runs filtered by template + status=success, returns the newest', async () => {
      mockGotGet.mockResolvedValueOnce([
        { runId: 'prev-1' },
        { runId: 'prev-2' },
      ]);
      const out = await findPreviousRun({
        projectId: 'proj-1',
        templateId: 'tpl-1',
        currentRunId: 'cur-1',
      });
      expect(out).toEqual({ runId: 'prev-1' });
      const url = mockGotGet.mock.calls[0][0] as string;
      expect(url).toContain(
        '/api/v1/projects/proj-1/evaluation/agents/runs',
      );
      expect(url).toContain('templateId=tpl-1');
      expect(url).toContain('status=success');
    });

    it('skips the current run when it appears in the response (race against own write)', async () => {
      mockGotGet.mockResolvedValueOnce([
        { runId: 'cur-1' }, // own row — must be skipped
        { runId: 'prev-2' },
      ]);
      const out = await findPreviousRun({
        projectId: 'proj-1',
        templateId: 'tpl-1',
        currentRunId: 'cur-1',
      });
      expect(out).toEqual({ runId: 'prev-2' });
    });

    it('returns runId: null when there are no prior runs for this template', async () => {
      mockGotGet.mockResolvedValueOnce([]);
      const out = await findPreviousRun({
        projectId: 'proj-1',
        templateId: 'tpl-1',
      });
      expect(out).toEqual({ runId: null });
    });

    it('returns runId: null when only the current run is in the response', async () => {
      mockGotGet.mockResolvedValueOnce([{ runId: 'cur-1' }]);
      const out = await findPreviousRun({
        projectId: 'proj-1',
        templateId: 'tpl-1',
        currentRunId: 'cur-1',
      });
      expect(out).toEqual({ runId: null });
    });

    it('throws InvalidInputError when templateId is missing', async () => {
      await expect(
        findPreviousRun({ projectId: 'proj-1', templateId: '' }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('maps 404 → NotFoundError', async () => {
      mockGotGet.mockRejectedValueOnce(httpError(404));
      await expect(
        findPreviousRun({ projectId: 'proj-1', templateId: 'tpl-1' }),
      ).rejects.toMatchObject({ type: 'NotFoundError' });
    });
  });

  // ── stubbed/not-yet-implemented routes ────────────────────────────

  describe('NotImplemented stubs', () => {
    it('loadFailedCaseIds throws NotImplemented', async () => {
      await expect(
        loadFailedCaseIds({
          runId: 'r',
          projectId: 'proj-1',
          errorType: 'quality',
        }),
      ).rejects.toMatchObject({ type: 'NotImplemented' });
    });

    it('loadCaseArtifacts throws NotImplemented', async () => {
      await expect(
        loadCaseArtifacts({ runId: 'r', projectId: 'proj-1' }),
      ).rejects.toMatchObject({ type: 'NotImplemented' });
    });

    it('recordTradeoffDecision throws NotImplemented', async () => {
      await expect(
        recordTradeoffDecision({
          runId: 'r',
          projectId: 'proj-1',
          decision: { acknowledged: true },
          actor: 'svc',
        }),
      ).rejects.toMatchObject({ type: 'NotImplemented' });
    });
  });

  // ── audit ─────────────────────────────────────────────────────────

  describe('writeAuditEvent', () => {
    it('POSTs to the run-scoped audit-events endpoint with mapped fields', async () => {
      mockGotPost.mockResolvedValueOnce(undefined as never);
      const event: AuditEvent & { projectId: string } = {
        id: 'evt-1',
        ts: '2026-06-01T00:00:00Z',
        runId: 'run-1',
        actor: 'svc',
        action: 'evaluation.started',
        details: { reason: 'go', meta: 1 },
        projectId: 'proj-1',
      };
      await writeAuditEvent(event);
      expect(mockGotPost).toHaveBeenCalledTimes(1);
      const [url, body] = mockGotPost.mock.calls[0];
      expect(url).toBe(
        'http://config.test/api/v1/projects/proj-1/evaluation/agents/runs/run-1/audit-events',
      );
      const reqBody = body as { type: string; actor: string; message?: string };
      expect(reqBody).toMatchObject({
        type: 'evaluation.started',
        actor: 'svc',
        message: 'go',
      });
    });

    it('skips the POST when runId is missing', async () => {
      const event: AuditEvent & { projectId: string } = {
        id: 'evt-2',
        ts: '2026-06-01T00:00:00Z',
        actor: 'svc',
        action: 'evaluation.created',
        projectId: 'proj-1',
      };
      await writeAuditEvent(event);
      expect(mockGotPost).not.toHaveBeenCalled();
    });

    it('swallows HTTP errors (audit writes must never block main flow)', async () => {
      mockGotPost.mockRejectedValueOnce(httpError(500));
      await expect(
        writeAuditEvent({
          id: 'evt-3',
          ts: '2026-06-01T00:00:00Z',
          runId: 'run-1',
          actor: 'svc',
          action: 'evaluation.started',
          projectId: 'proj-1',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ── promoteToRegression ───────────────────────────────────────────

  describe('promoteToRegression', () => {
    it('rejects when targetDatasetId is missing', async () => {
      await expect(
        promoteToRegression({
          targetDatasetId: '',
          actor: 'svc',
          sourceCaseId: 'c1',
        }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('rejects when actor is missing', async () => {
      await expect(
        promoteToRegression({
          targetDatasetId: 'ds-1',
          actor: '',
          sourceCaseId: 'c1',
        }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('rejects when neither sourceCaseId nor sandboxInteractionId is set', async () => {
      await expect(
        promoteToRegression({ targetDatasetId: 'ds-1', actor: 'svc' }),
      ).rejects.toMatchObject({ type: 'InvalidInputError' });
    });

    it('throws NotImplemented after validating args (route not yet exposed)', async () => {
      await expect(
        promoteToRegression({
          targetDatasetId: 'ds-1',
          actor: 'svc',
          sourceCaseId: 'c1',
        }),
      ).rejects.toMatchObject({ type: 'NotImplemented' });
    });
  });

  // Sanity — ApplicationFailure should be re-throwable without remapping
  it('ApplicationFailure thrown inside loadRunSnapshot is preserved verbatim', async () => {
    mockGotGet.mockImplementationOnce(() => {
      throw ApplicationFailure.nonRetryable('custom', 'CustomError');
    });
    await expect(
      loadRunSnapshot({ runId: 'r', projectId: 'p' }),
    ).rejects.toMatchObject({ type: 'CustomError' });
  });
});

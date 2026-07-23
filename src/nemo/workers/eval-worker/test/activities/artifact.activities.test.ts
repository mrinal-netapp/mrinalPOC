/**
 * Integration tests for artifact.activities.ts.
 *
 * Verifies:
 *   - POSIX path (NEMO_DEFAULT_STORE_ROOT set to a temp dir) — writes land at
 *     projects/{projectId}/evaluations/{evalId}/runs/{runId}/{file} and round-trip.
 *   - evalId falls back to slugify(evalName) when omitted.
 *   - writeResultsFile reads each per-case capture.json from PVC and
 *     denormalizes it into the on-disk results.json (stage-1 path-only
 *     payloads).
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  writeResultsFile,
  writeStakeholderReport,
} from '../../src/activities/artifact.activities';
import type {
  CaptureFile,
  CaseRef,
  CaseRunSlot,
  EvaluationResults,
  ProvenanceEnvelope,
} from '../../src/lib/evaluation';

jest.mock('@temporalio/activity', () => ({
  ApplicationFailure: class extends Error {
    public type: string;
    public nonRetryable: boolean;
    constructor(message: string, type: string) {
      super(message);
      this.type = type;
      this.nonRetryable = true;
    }
    static nonRetryable(message: string, type: string) {
      return new this(message, type);
    }
  },
  heartbeat: jest.fn(),
}));

function makeResults(): EvaluationResults {
  return {
    verdict: 'pass',
    triggeredGates: [],
    dimensions: [
      { id: 'rag.groundedness', label: 'Groundedness', headline: { mean: 0.9 } },
    ],
    coverage: { total: 2, completed: 2, completedPct: 100 },
    infraFailureRate: 0,
    judgeCoverage: { scored: 0, target: 0, pct: 0 },
    preFlightNonPromotable: false,
    runStopped: false,
  };
}

function makeCaseRef(caseId: string, overrides: Partial<CaseRef> = {}): CaseRef {
  return {
    projectId: 'proj-x',
    evalId: 'eval-x',
    runId: 'run-art-1',
    caseId,
    model: 'gpt-4o',
    ...overrides,
  };
}

function makeSlot(
  caseId: string,
  capturePath?: string,
  overrides: Partial<CaseRunSlot> = {},
): CaseRunSlot {
  return {
    caseRef: makeCaseRef(caseId),
    status: 'COMPLETED',
    passed: true,
    startedAt: '2026-05-28T00:00:00Z',
    completedAt: '2026-05-28T00:00:01Z',
    durationMs: 1000,
    ...(capturePath !== undefined ? { capturePath } : {}),
    deterministicMetrics: {},
    judgeRubrics: [],
    telemetry: { e2eMs: 1000 },
    retrievalAnnotation: null,
    resolvedRuntimeParams: { model: 'gpt-4o' },
    ...overrides,
  };
}

function makeProvenance(): ProvenanceEnvelope {
  return {
    agentVersionHash: '',
    datasetVersion: 'snapshot',
    retrievalIndexVersion: '',
    toolRegistryVersion: '',
    generatorModelVersion: '',
    rubricIds: [],
    rubricPrompts: [],
    envelopeHash: '',
  };
}

/** Pre-create a capture.json under the temp root and return its posix URI. */
async function writeCaptureFixture(
  root: string,
  ref: CaseRef,
  response: string,
): Promise<string> {
  const variant = ref.variantId ?? 'single';
  const seed = ref.seed ?? 0;
  const key = `projects/${ref.projectId}/evaluations/${ref.evalId}/runs/${ref.runId}/cases/${ref.caseId}/${variant}/${ref.model}/${seed}/capture.json`;
  const abs = path.join(root, key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const file: CaptureFile = {
    schemaVersion: 1,
    caseRef: ref,
    envelopeHash: 'env',
    capturedAt: new Date().toISOString(),
    capture: {
      response,
      citations: [],
      retrievedChunks: [{ id: 'chunk-1', content: 'cited text', score: 0.9, source: 's3://x' }],
      toolCalls: [],
      perAgent: [],
      telemetry: { e2eMs: 1000 },
      retrievalAnnotation: null,
      resolvedRuntimeParams: { model: ref.model },
    },
  };
  await fs.writeFile(abs, JSON.stringify(file), 'utf8');
  return `posix:///${key}`;
}

describe('artifact.activities — POSIX path (NEMO_DEFAULT_STORE_ROOT set)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'evw-test-'));
    process.env['NEMO_DEFAULT_STORE_ROOT'] = root;
  });

  afterEach(async () => {
    delete process.env['NEMO_DEFAULT_STORE_ROOT'];
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writeResultsFile creates the directory tree + file on disk', async () => {
    const ref = makeCaseRef('c1', { runId: 'run-p1' });
    const capturePath = await writeCaptureFixture(root, ref, 'ok');
    const slot = makeSlot('c1', capturePath, { caseRef: ref });

    const { resultsFileUri } = await writeResultsFile({
      runId: 'run-p1',
      projectId: 'proj-x',
      evalId: 'eval-x',
      results: makeResults(),
      perCaseSlots: [slot],
      provenance: makeProvenance(),
    });
    expect(resultsFileUri).toBe(
      'posix:///projects/proj-x/evaluations/eval-x/runs/run-p1/results.json',
    );
    const abs = path.join(
      root,
      'projects/proj-x/evaluations/eval-x/runs/run-p1/results.json',
    );
    // readFile is the single point of access — it throws if the file is
    // missing or isn't a regular file, which is the same signal the
    // earlier stat/isFile check provided without the TOCTOU window.
    const body = JSON.parse(await fs.readFile(abs, 'utf8'));
    expect(body.runId).toBe('run-p1');
    expect(body.results.verdict).toBe('pass');
    expect(body.perCaseArtifacts).toHaveLength(1);
    // Verifies the materialization read the capture.json fixture and merged
    // `response` onto the row. Heavy fields (`retrievedChunks`, `toolCalls`,
    // `perAgent`, `raw`, `citations`) are intentionally NOT inlined — they
    // stay on PVC and are reachable via `capturePath` for drill-in.
    expect(body.perCaseArtifacts[0].response).toBe('ok');
    expect(body.perCaseArtifacts[0].retrievedChunks).toEqual([]);
    expect(body.perCaseArtifacts[0].toolCalls).toEqual([]);
    expect(body.perCaseArtifacts[0].perAgent).toEqual([]);
    expect(body.perCaseArtifacts[0].citations).toEqual([]);
    expect(body.perCaseArtifacts[0].rawProviderPayload).toBeUndefined();
    expect(body.perCaseArtifacts[0].capturePath).toBe(capturePath);
  });

  it('writeStakeholderReport writes markdown at the matching key', async () => {
    const { reportUri } = await writeStakeholderReport({
      runId: 'run-p2',
      projectId: 'proj-x',
      evalId: 'eval-x',
      evalName: 'pdf-test',
      results: makeResults(),
    });
    expect(reportUri).toBe(
      'posix:///projects/proj-x/evaluations/eval-x/runs/run-p2/stakeholder-report.md',
    );
    const abs = path.join(
      root,
      'projects/proj-x/evaluations/eval-x/runs/run-p2/stakeholder-report.md',
    );
    const body = await fs.readFile(abs, 'utf8');
    expect(body).toContain('# Evaluation Report — pdf-test');
  });

  it('slugifies evalName when evalId is omitted', async () => {
    const { resultsFileUri } = await writeResultsFile({
      runId: 'run-p3',
      projectId: 'proj-x',
      evalName: 'My RAG Eval!',
      results: makeResults(),
      perCaseSlots: [],
      provenance: makeProvenance(),
    });
    expect(resultsFileUri).toBe(
      'posix:///projects/proj-x/evaluations/my-rag-eval/runs/run-p3/results.json',
    );
    const abs = path.join(
      root,
      'projects/proj-x/evaluations/my-rag-eval/runs/run-p3/results.json',
    );
    await expect(fs.stat(abs)).resolves.toBeDefined();
  });

  it('overwrites the same key on Temporal-retry re-execution', async () => {
    const refs = ['c1', 'c2', 'c3'].map((id) =>
      makeCaseRef(id, { runId: 'run-p-retry' }),
    );
    const paths = await Promise.all(
      refs.map((r) => writeCaptureFixture(root, r, `r-${r.caseId}`)),
    );
    const slots = refs.map((r, i) => makeSlot(r.caseId, paths[i], { caseRef: r }));

    const writeOnce = (s: CaseRunSlot[]) =>
      writeResultsFile({
        runId: 'run-p-retry',
        projectId: 'proj-x',
        evalId: 'eval-x',
        results: makeResults(),
        perCaseSlots: s,
        provenance: makeProvenance(),
      });
    await writeOnce(slots.slice(0, 1));
    await writeOnce(slots);
    const abs = path.join(
      root,
      'projects/proj-x/evaluations/eval-x/runs/run-p-retry/results.json',
    );
    const body = JSON.parse(await fs.readFile(abs, 'utf8'));
    expect(body.perCaseArtifacts).toHaveLength(3);
  });

  it('FAILED slots without a capturePath still produce a row with the error metadata', async () => {
    const slot: CaseRunSlot = makeSlot('c-fail', undefined, {
      caseRef: makeCaseRef('c-fail', { runId: 'run-fail' }),
      status: 'FAILED',
      passed: false,
      error: 'agent-service 503',
      errorType: 'infra',
    });
    await writeResultsFile({
      runId: 'run-fail',
      projectId: 'proj-x',
      evalId: 'eval-x',
      results: makeResults(),
      perCaseSlots: [slot],
      provenance: makeProvenance(),
    });
    const abs = path.join(
      root,
      'projects/proj-x/evaluations/eval-x/runs/run-fail/results.json',
    );
    const body = JSON.parse(await fs.readFile(abs, 'utf8'));
    expect(body.perCaseArtifacts).toHaveLength(1);
    const row = body.perCaseArtifacts[0];
    expect(row.status).toBe('FAILED');
    expect(row.error).toBe('agent-service 503');
    expect(row.response).toBeUndefined();
  });

  it('maps filesystem errors to non-retryable PosixWriteError', async () => {
    // Pointing the root at a regular file (not a directory) makes the
    // mkdir-then-write under it fail with ENOTDIR — covered by the
    // PosixWriteError mapping in uploadArtifact.
    const sentinel = path.join(root, 'not-a-dir');
    await fs.writeFile(sentinel, 'i am a file');
    process.env['NEMO_DEFAULT_STORE_ROOT'] = sentinel;
    await expect(
      writeResultsFile({
        runId: 'run-p4',
        projectId: 'proj-x',
        evalId: 'eval-x',
        results: makeResults(),
        perCaseSlots: [],
        provenance: makeProvenance(),
      }),
    ).rejects.toMatchObject({ type: 'PosixWriteError', nonRetryable: true });
  });
});

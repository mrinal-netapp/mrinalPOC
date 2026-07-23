// Integration tests for `validateTestCases` — exercises the activity
// against a real tmp-PVC mount so we hit the real `parseGoldenJsonl` +
// `readObject` / `writeObject` path without mocking the file system.
//
// Failure modes covered:
//   - Happy path: parses + stages `_input/cases.jsonl` + returns URIs.
//   - Missing file → NotFoundError ApplicationFailure.
//   - Invalid row (missing input.query) → SchemaDrift ApplicationFailure
//     with the per-row error list on `details`.
//   - Empty file (zero valid rows after blank/comment lines) → InvalidInputError.
//
// The Temporal `ApplicationFailure` shape is mocked because `temporalio/activity`
// can't be loaded outside a worker context.

jest.mock('@temporalio/activity', () => ({
  ApplicationFailure: class extends Error {
    public type: string;
    public nonRetryable: boolean;
    public details?: unknown[];
    constructor(message: string, type: string, ...details: unknown[]) {
      super(message);
      this.type = type;
      this.nonRetryable = true;
      this.details = details;
    }
    static nonRetryable(message: string, type: string, ...details: unknown[]) {
      return new this(message, type, ...details);
    }
  },
  heartbeat: jest.fn(),
}));

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { validateTestCases } from '../../src/activities/testcases.activities';

let storeRoot: string;

beforeEach(async () => {
  storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'evw-testcases-'));
  process.env['NEMO_DEFAULT_STORE_ROOT'] = storeRoot;
});

afterEach(async () => {
  delete process.env['NEMO_DEFAULT_STORE_ROOT'];
  await fs.rm(storeRoot, { recursive: true, force: true });
});

async function stageTestCasesFile(
  projectId: string,
  evalId: string,
  body: string,
  filename = 'cases.jsonl',
): Promise<void> {
  const dir = path.join(
    storeRoot,
    'projects',
    projectId,
    'evaluations',
    evalId,
    'testcases',
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), body, 'utf8');
}

function row(id: string, query = `q for ${id}`): string {
  return JSON.stringify({
    id,
    input: { query },
    evaluation: { expected_response: { final: { expected_answer: 'x' } } },
  });
}

describe('validateTestCases — happy path', () => {
  it('reads the JSONL from the eval-scoped PVC path, parses, stages a copy, and returns the parsed cases', async () => {
    const projectId = 'p-1';
    const evalId = 'eval-x';
    const runId = 'run-1';
    const body = [row('q-1'), row('q-2')].join('\n') + '\n';
    await stageTestCasesFile(projectId, evalId, body);

    const out = await validateTestCases({
      projectId,
      evalId,
      runId,
    });

    expect(out.rowCount).toBe(2);
    expect(out.cases.map((c) => c.id)).toEqual(['q-1', 'q-2']);
    expect(out.testCasesUri).toBe(
      `posix:///projects/${projectId}/evaluations/${evalId}/testcases/cases.jsonl`,
    );
    expect(out.inputCopyUri).toBe(
      `posix:///projects/${projectId}/evaluations/${evalId}/runs/${runId}/_input/cases.jsonl`,
    );

    // Audit copy is byte-for-byte identical to the source.
    const stagedAbs = path.join(
      storeRoot,
      'projects',
      projectId,
      'evaluations',
      evalId,
      'runs',
      runId,
      '_input',
      'cases.jsonl',
    );
    const stagedBytes = await fs.readFile(stagedAbs, 'utf8');
    expect(stagedBytes).toBe(body);
  });

  it('honours a custom filename when the eval uses a non-default name', async () => {
    await stageTestCasesFile(
      'p-1',
      'eval-x',
      [row('q-1')].join('\n'),
      'rag-eval-v3.jsonl',
    );

    const out = await validateTestCases({
      projectId: 'p-1',
      evalId: 'eval-x',
      runId: 'run-1',
      filename: 'rag-eval-v3.jsonl',
    });
    expect(out.rowCount).toBe(1);
    expect(out.testCasesUri).toMatch(/rag-eval-v3\.jsonl$/);
  });

});

describe('validateTestCases — failure modes', () => {
  it('throws NotFoundError when the test-cases file is missing', async () => {
    await expect(
      validateTestCases({
        projectId: 'p-1',
        evalId: 'eval-x',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({
      type: 'NotFoundError',
      nonRetryable: true,
    });
  });

  it('throws SchemaDrift with row errors when a row is invalid', async () => {
    const bad = JSON.stringify({ id: 'q-1', input: {}, evaluation: {} });
    await stageTestCasesFile('p-1', 'eval-x', bad);

    expect.assertions(3);
    try {
      await validateTestCases({
        projectId: 'p-1',
        evalId: 'eval-x',
        runId: 'run-1',
      });
    } catch (err) {
      const e = err as Error & { type: string; details?: unknown[] };
      expect(e.type).toBe('SchemaDrift');
      expect(e.message).toMatch(/input\.query/);
      // The non-retryable wrapper attaches the per-row errors so the
      // GUI can render them inline.
      expect(e.details).toBeDefined();
    }
  });

  it('throws InvalidInputError when the file has zero valid rows', async () => {
    // All comment + blank lines.
    const empty = '# header\n\n# more notes\n';
    await stageTestCasesFile('p-1', 'eval-x', empty);
    await expect(
      validateTestCases({
        projectId: 'p-1',
        evalId: 'eval-x',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({
      type: 'InvalidInputError',
    });
  });
});

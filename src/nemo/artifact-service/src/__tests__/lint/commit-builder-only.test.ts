import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Lint test: every commit object written by artifact-service MUST go
 * through `CommitBuilder` (via `GitEngine.buildCommit`).
 *
 * This test scans the service's source tree and fails if any file
 * outside `engine/GitEngine.ts` calls `git.writeCommit(...)` or
 * `git.commit(...)` directly.
 *
 * The invariant matters because `CommitBuilder` is the only code path
 * that stamps audit trailers (X-Principal, X-Session-Id, X-Op, …) onto
 * commit messages. Bypassing it would silently break the audit log.
 */

const ROOT = path.resolve(__dirname, '..', '..'); // → src/
const ALLOWED = new Set([
  path.join('engine', 'GitEngine.ts'), // single legitimate caller
]);

const FORBIDDEN = [
  /\bgit\.writeCommit\s*\(/,
  /\bgit\.commit\s*\(/,
];

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') {
        continue;
      }
      out.push(...(await listTsFiles(full)));
    } else if (e.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Best-effort stripper for line and block comments so the lint only
 * matches real code, not docstrings/examples referencing the API.
 * Naive but sufficient — we don't try to handle comments inside strings.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  return out;
}

describe('commit-builder-only invariant', () => {
  it('only GitEngine.ts calls git.writeCommit / git.commit', async () => {
    const files = await listTsFiles(ROOT);
    const offenders: { file: string; pattern: string }[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const raw = await fs.readFile(file, 'utf8');
      const src = stripComments(raw);
      for (const re of FORBIDDEN) {
        if (re.test(src)) offenders.push({ file: rel, pattern: re.source });
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file} matches /${o.pattern}/`)
        .join('\n');
      throw new Error(
        'Forbidden direct git-commit call(s) outside CommitBuilder/GitEngine:\n' +
          detail +
          '\nRoute all commit creation through GitEngine.buildCommit / CommitBuilder.',
      );
    }
  });
});

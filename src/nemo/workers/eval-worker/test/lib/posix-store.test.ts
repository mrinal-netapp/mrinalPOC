import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  fullPath,
  readObject,
  runDirKey,
  writeObject,
} from '../../src/lib/posix-store';

describe('posix-store path containment', () => {
  let root: string;
  let prevRoot: string | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'posix-store-test-'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    prevRoot = process.env['NEMO_DEFAULT_STORE_ROOT'];
    process.env['NEMO_DEFAULT_STORE_ROOT'] = root;
  });

  afterEach(() => {
    if (prevRoot === undefined) {
      delete process.env['NEMO_DEFAULT_STORE_ROOT'];
    } else {
      process.env['NEMO_DEFAULT_STORE_ROOT'] = prevRoot;
    }
  });

  it('resolves a normal nested key under the root', () => {
    const key = runDirKey({ projectId: 'p1', evalId: 'e1', runId: 'r1' });
    expect(fullPath(key)).toBe(
      path.join(root, 'projects/p1/evaluations/e1/runs/r1'),
    );
  });

  it('rejects keys that escape via `..` segments', () => {
    expect(() => fullPath('../../etc/passwd')).toThrow(
      /resolves outside store root/,
    );
    expect(() => fullPath('projects/p/../../../escape')).toThrow(
      /resolves outside store root/,
    );
  });

  it('rejects absolute keys', () => {
    expect(() => fullPath('/etc/passwd')).toThrow(
      /resolves outside store root/,
    );
  });

  it('rejects traversal via tainted projectId interpolated into runDirKey', () => {
    // projectId is the topmost path segment, so two `..` are enough to
    // climb above the store root once `projects/` and `<projectId>/` are
    // popped off.
    const key = runDirKey({
      projectId: '../../escape',
      evalId: 'e1',
      runId: 'r1',
    });
    expect(() => fullPath(key)).toThrow(/resolves outside store root/);
  });

  it('writeObject and readObject refuse traversing keys', async () => {
    await expect(
      writeObject('../escape.json', 'pwned'),
    ).rejects.toThrow(/resolves outside store root/);
    await expect(readObject('../escape.json')).rejects.toThrow(
      /resolves outside store root/,
    );
  });

  it('writeObject then readObject round-trips a safe key', async () => {
    const key = `${runDirKey({
      projectId: 'p1',
      evalId: 'e1',
      runId: 'r1',
    })}/manifest.json`;
    await writeObject(key, '{"ok":true}');
    await expect(readObject(key)).resolves.toBe('{"ok":true}');
  });
});

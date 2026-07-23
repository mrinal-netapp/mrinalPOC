import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../engine/PathResolver';
import { LfsSidecar } from '../../engine/LfsSidecar';

describe('LfsSidecar', () => {
  let tmpRoot: string;
  let paths: PathResolver;
  let lfs: LfsSidecar;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lfs-test-'));
    paths = new PathResolver(tmpRoot);
    lfs = new LfsSidecar(paths);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('stores content under sha-sharded CAS path', async () => {
    const content = new TextEncoder().encode('hello world');
    const pointer = await lfs.store('proj1', content, 'text/plain');
    expect(pointer.size).toBe(content.length);
    expect(pointer.sha256).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = await fs.readFile(paths.blobPath('proj1', pointer.sha256));
    expect(onDisk.equals(Buffer.from(content))).toBe(true);
  });

  it('is idempotent on identical content', async () => {
    const c = new TextEncoder().encode('hello');
    const p1 = await lfs.store('proj1', c);
    const p2 = await lfs.store('proj1', c);
    expect(p2.sha256).toBe(p1.sha256);
  });

  it('encodes + parses a pointer round-trip', () => {
    const ptr = { sha256: 'a'.repeat(64), size: 1234, mime: 'application/json' };
    const encoded = LfsSidecar.encodePointer(ptr);
    expect(LfsSidecar.isPointer(encoded)).toBe(true);
    const parsed = LfsSidecar.parsePointer(encoded);
    expect(parsed).toEqual(ptr);
  });

  it('detects non-pointer bytes', () => {
    expect(LfsSidecar.isPointer(new TextEncoder().encode('hello'))).toBe(false);
  });

  it('loads back the stored bytes', async () => {
    const original = new TextEncoder().encode('round-trip me');
    const ptr = await lfs.store('proj1', original);
    const loaded = await lfs.load('proj1', ptr);
    expect(Buffer.from(loaded).equals(Buffer.from(original))).toBe(true);
  });
});

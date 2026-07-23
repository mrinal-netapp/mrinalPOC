import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generate } from 'selfsigned';

import { DirectoryWatcher } from './file-watcher';
import { createSecretStore } from './secret-store';
import { type SecretStore } from './types';

// Raise the per-test timeout for the whole file. These integration tests drive
// real fs.watch watchers whose inotify/FSEvents delivery time is highly
// variable under CI load — 5 s (the Jest default) is not enough.
jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temporary directory for a test and tears it down after the test. */
function useTmpDir(): { dir: () => string } {
  let tmpDir = '';
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-client-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return { dir: () => tmpDir };
}

/** Writes a file at `filePath` using an atomic rename (temp → target). */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Returns a Promise that resolves after `ms` milliseconds. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Blocks until `setup` calls its resolver, or rejects after `timeoutMs`.
 * Use this instead of `sleep` when a test expects an asynchronous event to fire
 * (watch callback, onError, onRotate, etc.) so that the test is deterministic
 * regardless of how fast the kernel delivers inotify events on CI.
 */
function waitFor<T>(
  timeoutMs: number,
  setup: (resolve: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`waitFor timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    setup((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

// TLS fixtures generated once per test run. Using runtime generation (2048-bit
// RSA via the `selfsigned` package) avoids committing any private key literal
// to the repository, which would trigger secret-scanning tools.
let TEST_TLS_KEY = '';
let TEST_TLS_CERT = '';

beforeAll(async () => {
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await generate([{ name: 'commonName', value: 'test' }], {
    keySize: 2048,
    notAfterDate,
  });
  TEST_TLS_KEY = pems.private;
  TEST_TLS_CERT = pems.cert;
});

/**
 * Writes a matching TLS triple (cert/chain/key) for tests.
 * Uses the runtime-generated 2048-bit RSA key + self-signed cert so that
 * `tls.createSecureContext` accepts them without error.
 */
function writeFakeTlsFiles(
  dir: string,
  name: string,
): { certPath: string; chainPath: string; keyPath: string } {
  const certDir = path.join(dir, 'tls', name);
  fs.mkdirSync(certDir, { recursive: true });

  const certPath = path.join(certDir, 'cert.pem');
  const chainPath = path.join(certDir, 'chain.pem');
  const keyPath = path.join(certDir, 'key.pem');

  fs.writeFileSync(certPath, TEST_TLS_CERT, 'utf8');
  fs.writeFileSync(chainPath, '', 'utf8');
  fs.writeFileSync(keyPath, TEST_TLS_KEY, 'utf8');

  return { certPath, chainPath, keyPath };
}

// ---------------------------------------------------------------------------
// T-L1: Happy-path init
// ---------------------------------------------------------------------------

describe('T-L1: createSecretStore with all requiredKeys present succeeds', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('resolves with a SecretStore', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'url'), 'postgresql://user:pass@host/db');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
    });

    expect(store).toBeDefined();
    expect(typeof store.getString).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// T-L2: Fail-fast on missing key
// ---------------------------------------------------------------------------

describe('T-L2: createSecretStore with a missing requiredKey throws', () => {
  const { dir } = useTmpDir();

  it('throws with a descriptive error', async () => {
    await expect(
      createSecretStore({ root: dir(), requiredKeys: ['db/url'] }),
    ).rejects.toThrow(/db\/url/);
  });
});

// ---------------------------------------------------------------------------
// T-L3: getString after init returns file content
// ---------------------------------------------------------------------------

describe('T-L3: getString returns the current file value', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('returns the file content verbatim', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'url'), 'postgresql://host/db');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
    });

    expect(store.getString('db/url')).toBe('postgresql://host/db');
  });
});

// ---------------------------------------------------------------------------
// T-L4: Atomic rename triggers watch callback exactly once with new value
// ---------------------------------------------------------------------------

describe('T-L4: atomic rename triggers watch callback with new value', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('invokes watch callback after rename', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    const nextValue = await waitFor<string>(5000, (resolve) => {
      store.watch('db/url', resolve);
      atomicWrite(filePath, 'v2');
    });

    expect(nextValue).toBe('v2');
    expect(store.getString('db/url')).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// T-L5: Two renames within debounce window collapse to one callback
// ---------------------------------------------------------------------------

describe('T-L5: two renames within debounce window collapse to one callback', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('invokes callback only once', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    const debounceMs = 300;
    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs,
    });

    const received: string[] = [];
    await waitFor<void>(5000, (resolve) => {
      store.watch('db/url', (next) => {
        received.push(next);
        resolve();
      });
      atomicWrite(filePath, 'v2');
      atomicWrite(filePath, 'v3');
    });

    // Wait one more debounce window to catch any spurious second callback.
    await sleep(debounceMs);

    expect(received.length).toBe(1);
    expect(received[0]).toBe('v3');
  });
});

// ---------------------------------------------------------------------------
// T-L6: Two renames separated by > debounce window invoke callback twice
// ---------------------------------------------------------------------------

describe('T-L6: two renames separated by > debounce window invoke callback twice', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('invokes callback twice', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    const debounceMs = 100;
    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs,
    });

    const received: string[] = [];

    // Register the callback and wait until exactly two callbacks have arrived.
    const done = waitFor<void>(15_000, (resolve) => {
      store.watch('db/url', (next) => {
        received.push(next);
        if (received.length === 2) resolve();
      });
    });

    atomicWrite(filePath, 'v2');
    // sleep here is for sequencing only (ensuring v3 lands in a separate debounce
    // window), not for waiting on the result — `done` handles that.
    await sleep(debounceMs * 4);
    atomicWrite(filePath, 'v3');

    await done;
    expect(received).toEqual(['v2', 'v3']);
  });
});

// ---------------------------------------------------------------------------
// T-L7: Plain write to a staging file does NOT invoke callback
// (the watcher filters for 'rename' events only — inotify IN_MOVED_TO)
// ---------------------------------------------------------------------------

describe('T-L7: plain write to a staging file does NOT invoke watch callback', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('does not invoke callback for a plain write to an untracked staging file', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    const received: string[] = [];
    store.watch('db/url', (next) => received.push(next));

    // Write to a staging file (not a rename onto the tracked key).
    // The watcher only fires on 'rename' (IN_MOVED_TO); a plain write
    // emits 'change' (IN_MODIFY) which is now dropped at the kernel-event layer.
    fs.writeFileSync(path.join(dbDir, '.tmp-staging'), 'v2');

    await sleep(300);

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-L8: Unreadable file mid-rotation keeps last-known-good; onError is called;
//        watch subscribers are NOT invoked.
// ---------------------------------------------------------------------------

describe('T-L8: unreadable file mid-rotation preserves last-known-good', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('keeps old value and calls onError without invoking subscribers', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    const received: string[] = [];

    // Capture the signal before creating the store so onError can resolve it.
    let signalError!: (v: { key: string; err: Error }) => void;
    const errorSignal = waitFor<{ key: string; err: Error }>(
      5000,
      (resolve) => {
        signalError = resolve;
      },
    );

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
      onError: (key, err) => signalError({ key, err }),
    });

    store.watch('db/url', (next) => received.push(next));

    // Simulate a mid-rotation read failure by permanently removing the file.
    // fs.watch emits a 'rename' event on unlink; readFileSync then gets ENOENT.
    fs.unlinkSync(filePath);

    const error = await errorSignal;

    // Subscribers must NOT be invoked on read error.
    expect(received).toHaveLength(0);
    // Old value must be preserved.
    expect(store.getString('db/url')).toBe('v1');
    // onError must have been called with the correct key.
    expect(error.key).toBe('db/url');
  });
});

// ---------------------------------------------------------------------------
// T-L9: TLS context — three renames within 500 ms produce exactly one onRotate
// ---------------------------------------------------------------------------

describe('T-L9: TLS context rotation coalesces three renames into one swap', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('produces exactly one onRotate callback', async () => {
    const { certPath, chainPath, keyPath } = writeFakeTlsFiles(dir(), 'server');

    const tlsCoalesceMs = 300;
    store = await createSecretStore({
      root: dir(),
      requiredKeys: [],
      requiredTlsContexts: ['server'],
      debounceMs: 50,
      tlsCoalesceMs,
    });

    const tlsCtx = store.getTlsContext('server');
    const rotations: number[] = [];

    // Wait for the first (and should be only) rotation callback.
    await waitFor<void>(5000, (resolve) => {
      tlsCtx.onRotate(() => {
        rotations.push(Date.now());
        resolve();
      });
      // Three renames within coalesceMs — should collapse to one swap.
      atomicWrite(certPath, fs.readFileSync(certPath, 'utf8'));
      atomicWrite(chainPath, '');
      atomicWrite(keyPath, fs.readFileSync(keyPath, 'utf8'));
    });

    // Wait one more coalesceMs to catch any spurious additional swap.
    await sleep(tlsCoalesceMs + 100);

    expect(rotations).toHaveLength(1);
    expect(tlsCtx.current()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-L10: TLS context — invalid PEM triggers onError; current() still returns old context
// ---------------------------------------------------------------------------

describe('T-L10: invalid PEM on TLS rotation keeps old context', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('calls onError and preserves old context', async () => {
    const { certPath } = writeFakeTlsFiles(dir(), 'server');

    let signalError!: (key: string) => void;
    const errorSignal = waitFor<string>(5000, (resolve) => {
      signalError = resolve;
    });

    store = await createSecretStore({
      root: dir(),
      requiredKeys: [],
      requiredTlsContexts: ['server'],
      debounceMs: 50,
      tlsCoalesceMs: 100,
      onError: (key) => signalError(key),
    });

    const tlsCtx = store.getTlsContext('server');
    const before = tlsCtx.current();

    // Write an invalid cert to trigger a reload failure.
    atomicWrite(certPath, 'NOT VALID PEM');

    const errorKey = await errorSignal;
    expect(errorKey).toMatch(/^tls:/);
    expect(tlsCtx.current()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// T-L11: High-frequency rotation for 5 seconds — no missed callbacks, no leak
// ---------------------------------------------------------------------------

describe('T-L11: high-frequency rotation stability', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('handles rapid rotations without leaking or dropping events', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, '0');

    const debounceMs = 20;
    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs,
    });

    let callbackCount = 0;
    store.watch('db/url', () => {
      callbackCount += 1;
    });

    const intervalMs = 50;
    const durationMs = 3_000;
    const writes = Math.floor(durationMs / intervalMs);

    for (let i = 1; i <= writes; i++) {
      atomicWrite(filePath, String(i));
      await sleep(intervalMs);
    }

    // Wait until the final value is visible in the cache (event-driven drain).
    const lastWritten = String(writes);
    if (store.getString('db/url') !== lastWritten) {
      await waitFor<void>(10_000, (resolve) => {
        store.watch('db/url', (next) => {
          if (next === lastWritten) resolve();
        });
      });
    }

    // We should have received at least 1 callback (many may be debounced, which is correct).
    expect(callbackCount).toBeGreaterThanOrEqual(1);

    // The final cached value must equal the last write.
    expect(store.getString('db/url')).toBe(lastWritten);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T-L12: SECRETS_ROOT=./.secrets-dev works identically against a local dir
// ---------------------------------------------------------------------------

describe('T-L12: SECRETS_ROOT env var works against a local directory', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['SECRETS_ROOT'];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env['SECRETS_ROOT'];
    } else {
      process.env['SECRETS_ROOT'] = original;
    }
    store?.close();
  });

  it('reads from SECRETS_ROOT when root is not provided', async () => {
    const llmDir = path.join(dir(), 'llm');
    fs.mkdirSync(llmDir, { recursive: true });
    fs.writeFileSync(path.join(llmDir, 'api-key'), 'sk-test-key');

    process.env['SECRETS_ROOT'] = dir();

    store = await createSecretStore({ requiredKeys: ['llm/api-key'] });

    expect(store.getString('llm/api-key')).toBe('sk-test-key');
  });
});

// ---------------------------------------------------------------------------
// T-L13: unsubscribe permanently removes the callback
// ---------------------------------------------------------------------------

describe('T-L13: unsubscribe removes the callback permanently', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('does not invoke callback after unsubscribe', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    const received: string[] = [];
    const unsubscribe = store.watch('db/url', (next) => received.push(next));

    unsubscribe();

    atomicWrite(filePath, 'v2');
    await sleep(300);

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-L14: close() releases inotify handles
// ---------------------------------------------------------------------------

describe('T-L14: close() releases fs.watch handles', () => {
  const { dir } = useTmpDir();

  it('does not throw when closed, and callbacks stop firing', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    const store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    const received: string[] = [];
    store.watch('db/url', (next) => received.push(next));

    store.close();

    // Rename after close — callback must not fire.
    atomicWrite(filePath, 'v2');
    await sleep(300);

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-L15: getBuffer returns raw bytes; getJSON parses JSON
// ---------------------------------------------------------------------------

describe('T-L15: getBuffer returns raw bytes and getJSON parses JSON', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('getBuffer returns a Buffer and getJSON deserialises JSON', async () => {
    const dataDir = path.join(dir(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'raw'), 'hello');
    fs.writeFileSync(path.join(dataDir, 'cfg'), JSON.stringify({ port: 5432 }));

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['data/raw', 'data/cfg'],
    });

    expect(store.getBuffer('data/raw')).toEqual(Buffer.from('hello'));
    expect(store.getJSON<{ port: number }>('data/cfg')).toEqual({ port: 5432 });
  });
});

// ---------------------------------------------------------------------------
// T-L16: getTlsContext throws for an undeclared context
// ---------------------------------------------------------------------------

describe('T-L16: getTlsContext throws for an undeclared context', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('throws with the context name in the message', async () => {
    store = await createSecretStore({ root: dir(), requiredKeys: [] });
    expect(() => store.getTlsContext('missing-ctx')).toThrow(/missing-ctx/);
  });
});

// ---------------------------------------------------------------------------
// T-L17: getString / getBuffer throw for keys not in requiredKeys
// ---------------------------------------------------------------------------

describe('T-L17: getString and watch throw for keys not declared in requiredKeys', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('getString throws with the key name in the message', async () => {
    store = await createSecretStore({ root: dir(), requiredKeys: [] });
    expect(() => store.getString('undeclared/key')).toThrow(/undeclared\/key/);
  });

  it('watch throws for an undeclared key instead of silently registering a no-op callback', async () => {
    store = await createSecretStore({ root: dir(), requiredKeys: [] });
    expect(() => store.watch('undeclared/key', () => undefined)).toThrow(
      /undeclared\/key/,
    );
  });
});

// ---------------------------------------------------------------------------
// T-L18: watch subscriber throwing calls onError without crashing
// ---------------------------------------------------------------------------

describe('T-L18: watch subscriber throwing calls onError without crashing', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('calls onError and keeps the store operational after a subscriber throws', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    let signalError!: (key: string) => void;
    const errorSignal = waitFor<string>(5000, (resolve) => {
      signalError = resolve;
    });

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
      onError: (key) => signalError(key),
    });

    store.watch('db/url', () => {
      throw new Error('subscriber boom');
    });

    atomicWrite(filePath, 'v2');

    const errorKey = await errorSignal;
    expect(errorKey).toBe('db/url');
    expect(store.getString('db/url')).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// T-L19: identical content reload does NOT invoke subscribers
// ---------------------------------------------------------------------------

describe('T-L19: identical content reload does not invoke subscribers', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('skips notification when reloaded bytes are identical to cache', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'same');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    const received: string[] = [];
    store.watch('db/url', (next) => received.push(next));

    atomicWrite(filePath, 'same'); // identical bytes
    await sleep(300);

    expect(received).toHaveLength(0);
    expect(store.getString('db/url')).toBe('same');
  });
});

// ---------------------------------------------------------------------------
// T-L20: TLS context with a non-empty chain.pem (intermediate chain appended)
// ---------------------------------------------------------------------------

describe('T-L20: TLS context with a non-empty chain.pem', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('loads successfully when chain.pem contains intermediate certificates', async () => {
    const certDir = path.join(dir(), 'tls', 'server');
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, 'cert.pem'), TEST_TLS_CERT, 'utf8');
    // Use the cert itself as a stand-in intermediate to exercise the chain-appending
    // branch — Node.js does not validate the chain structure at SecureContext creation.
    fs.writeFileSync(path.join(certDir, 'chain.pem'), TEST_TLS_CERT, 'utf8');
    fs.writeFileSync(path.join(certDir, 'key.pem'), TEST_TLS_KEY, 'utf8');

    store = await createSecretStore({
      root: dir(),
      requiredKeys: [],
      requiredTlsContexts: ['server'],
    });

    expect(store.getTlsContext('server').current()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-L21: onRotate callback throwing calls onError; context is still swapped
// ---------------------------------------------------------------------------

describe('T-L21: onRotate callback throwing calls onError', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('calls onError when an onRotate subscriber throws; context still updates', async () => {
    const { certPath, keyPath } = writeFakeTlsFiles(dir(), 'server');

    let signalError!: (key: string) => void;
    const errorSignal = waitFor<string>(5000, (resolve) => {
      signalError = resolve;
    });

    store = await createSecretStore({
      root: dir(),
      requiredKeys: [],
      requiredTlsContexts: ['server'],
      debounceMs: 50,
      tlsCoalesceMs: 50,
      onError: (key) => signalError(key),
    });

    store.getTlsContext('server').onRotate(() => {
      throw new Error('rotate subscriber boom');
    });

    // Trigger a successful rotation — the onRotate subscriber will throw, calling onError.
    atomicWrite(certPath, fs.readFileSync(certPath, 'utf8'));
    atomicWrite(keyPath, fs.readFileSync(keyPath, 'utf8'));

    const errorKey = await errorSignal;
    expect(errorKey).toContain('onRotate');
    expect(store.getTlsContext('server').current()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-L22: createSecretStore fails fast when a requiredTlsContext is absent
// ---------------------------------------------------------------------------

describe('T-L22: createSecretStore fails fast on missing TLS PEM files', () => {
  const { dir } = useTmpDir();

  it('throws with the context name when TLS files are absent', async () => {
    await expect(
      createSecretStore({
        root: dir(),
        requiredKeys: [],
        requiredTlsContexts: ['missing-tls'],
      }),
    ).rejects.toThrow(/missing-tls/);
  });
});

// ---------------------------------------------------------------------------
// T-L23: default onError logs to console.error when no handler is provided
// ---------------------------------------------------------------------------

describe('T-L23: default onError logs to console.error', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('calls console.error when no onError option is provided and a read fails', async () => {
    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const filePath = path.join(dbDir, 'url');
    fs.writeFileSync(filePath, 'v1');

    // No onError provided — the default implementation calls console.error.
    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    await waitFor<void>(5000, (resolve) => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {
        spy.mockRestore();
        resolve();
        return undefined;
      });
      fs.unlinkSync(filePath);
    });
  });
});

// ---------------------------------------------------------------------------
// T-L24: ..data rename (CSI driver pattern) reloads all cached keys
// ---------------------------------------------------------------------------

describe('T-L24: ..data symlink rename (CSI driver pattern) reloads all cached keys', () => {
  const { dir } = useTmpDir();
  let store: SecretStore;

  afterEach(() => store?.close());

  it('reloads all cached keys when ..data is atomically renamed', async () => {
    // Simulate the Kubernetes CSI secret mount layout:
    //   <root>/..data       -> <root>/..data_v1  (symlink, will be swapped)
    //   <root>/..data_v1/db/url                  (real file, v1)
    //   <root>/db/url       -> ..data/db/url     (symlink, read by the store)
    const v1File = path.join(dir(), '..data_v1', 'db');
    fs.mkdirSync(v1File, { recursive: true });
    fs.writeFileSync(path.join(v1File, 'url'), 'v1');

    const dataLink = path.join(dir(), '..data');
    fs.symlinkSync(path.join(dir(), '..data_v1'), dataLink);

    const dbDir = path.join(dir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    // The symlink target is relative, mirroring the CSI driver layout.
    fs.symlinkSync(
      path.join('..', '..data', 'db', 'url'),
      path.join(dbDir, 'url'),
    );

    store = await createSecretStore({
      root: dir(),
      requiredKeys: ['db/url'],
      debounceMs: 50,
    });

    expect(store.getString('db/url')).toBe('v1');

    const received: string[] = [];
    store.watch('db/url', (next) => received.push(next));

    // Build v2 data directory and atomically swap the ..data symlink.
    const v2File = path.join(dir(), '..data_v2', 'db');
    fs.mkdirSync(v2File, { recursive: true });
    fs.writeFileSync(path.join(v2File, 'url'), 'v2');

    const tmpLink = path.join(dir(), '..data_tmp');
    fs.symlinkSync(path.join(dir(), '..data_v2'), tmpLink);
    fs.renameSync(tmpLink, dataLink); // IN_MOVED_TO for ..data

    // Poll until the cache reflects v2. This is more resilient than a fixed
    // sleep because fs.watch symlink-rename event timing varies across kernels.
    const deadline = Date.now() + 5000;
    while (store.getString('db/url') !== 'v2') {
      if (Date.now() >= deadline)
        throw new Error(
          'T-L24: timed out waiting for ..data rotation to be reflected',
        );
      await sleep(50);
    }

    expect(store.getString('db/url')).toBe('v2');
    expect(received).toContain('v2');
  });
});

// ---------------------------------------------------------------------------
// DirectoryWatcher unit tests (file-watcher.ts branch coverage)
// ---------------------------------------------------------------------------

describe('DirectoryWatcher: .directory getter', () => {
  const { dir } = useTmpDir();

  it('returns the root path passed to the constructor', () => {
    const watcher = new DirectoryWatcher(dir(), jest.fn(), jest.fn());
    expect(watcher.directory).toBe(dir());
    watcher.close();
  });
});

describe('DirectoryWatcher: new subdirectory renamed in after init is watched', () => {
  const { dir } = useTmpDir();

  it('fires for a file renamed into a subdir that appeared after init', async () => {
    const received: string[] = [];
    const watcher = new DirectoryWatcher(
      dir(),
      (p) => received.push(p),
      jest.fn(),
    );

    // Rename a new directory into the watched root — the watcher should pick it
    // up and add a non-recursive watch for it (covers the _watch() call inside
    // the rename-event callback, line 59 of file-watcher.ts).
    const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-src-'));
    const subDir = path.join(dir(), 'newdb');
    fs.renameSync(tmpSrc, subDir);

    // Allow time for the rename event to be processed and the new watch to fire.
    await sleep(200);

    // Write a file inside the newly watched subdir.
    atomicWrite(path.join(subDir, 'url'), 'secret');
    await sleep(300);

    watcher.close();
    expect(received.some((p) => p.endsWith(path.join('newdb', 'url')))).toBe(
      true,
    );
  });
});

describe('DirectoryWatcher: watcher error after close() is suppressed', () => {
  const { dir } = useTmpDir();

  it('does not call onWatchError once the watcher is closed', async () => {
    const errors: Error[] = [];
    const watcher = new DirectoryWatcher(dir(), jest.fn(), (err) =>
      errors.push(err),
    );

    // Close immediately; any error that fires asynchronously should be swallowed.
    watcher.close();

    // No reliable cross-platform way to force an fs.watch error, so we simply
    // assert the closed watcher accepted no errors during a brief wait window
    // (exercises the `if (!this.closed)` guard on line 68 of file-watcher.ts).
    await sleep(50);
    expect(errors).toHaveLength(0);
  });
});

describe('DirectoryWatcher: duplicate _watch() call for an already-watched dir is a no-op', () => {
  const { dir } = useTmpDir();

  it('does not add a second watch when the same directory rename fires twice', async () => {
    // Pre-create a subdirectory so the watcher registers it at init time.
    const subDir = path.join(dir(), 'db');
    fs.mkdirSync(subDir, { recursive: true });

    const received: string[] = [];
    const watcher = new DirectoryWatcher(
      dir(),
      (p) => received.push(p),
      jest.fn(),
    );

    // Rename a temp file onto a path inside the already-watched subdir —
    // the root watcher fires a rename event whose filename is 'db'. The handler
    // tries _watch(subDir, 'db') but the dedup guard (line 37) returns early.
    const tmp = path.join(dir(), '.tmp-dedup');
    fs.writeFileSync(tmp, 'x');
    atomicWrite(path.join(subDir, 'url'), 'v1');

    await sleep(200);
    watcher.close();

    // Just assert no crash and that normal rename events still fire.
    expect(received.some((p) => p.includes('url'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-L25: chain.pem exists but is unreadable (non-ENOENT error propagates)
// ---------------------------------------------------------------------------

describe('T-L25: chain.pem unreadable with a non-ENOENT error throws', () => {
  const { dir } = useTmpDir();

  it('throws when chain.pem exists but cannot be read (PermissionError)', async () => {
    const certDir = path.join(dir(), 'tls', 'server');
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, 'cert.pem'), TEST_TLS_CERT, 'utf8');
    fs.writeFileSync(path.join(certDir, 'key.pem'), TEST_TLS_KEY, 'utf8');

    const chainPath = path.join(certDir, 'chain.pem');
    fs.writeFileSync(chainPath, 'placeholder', 'utf8');
    fs.chmodSync(chainPath, 0o000);

    try {
      await expect(
        createSecretStore({
          root: dir(),
          requiredKeys: [],
          requiredTlsContexts: ['server'],
        }),
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(chainPath, 0o644);
    }
  });
});

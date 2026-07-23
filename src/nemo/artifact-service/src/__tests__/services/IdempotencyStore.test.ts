import { IdempotencyStore } from '../../services/IdempotencyStore';

describe('IdempotencyStore (Redis-disabled)', () => {
  it('always returns miss when redis is null', async () => {
    const store = new IdempotencyStore(null);
    const result = await store.lookup<string>('ns', 'key', 'hash');
    expect(result.status).toBe('miss');
  });

  it('hashBody produces stable sha256 for identical payloads', () => {
    const a = IdempotencyStore.hashBody({ a: 1, b: [2, 3] });
    const b = IdempotencyStore.hashBody({ a: 1, b: [2, 3] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashBody distinguishes different payloads', () => {
    const a = IdempotencyStore.hashBody({ a: 1 });
    const b = IdempotencyStore.hashBody({ a: 2 });
    expect(a).not.toBe(b);
  });

  it('store is a no-op when redis is null', async () => {
    const store = new IdempotencyStore(null);
    await expect(store.store('ns', 'k', 'h', 'v')).resolves.toBeUndefined();
  });
});

describe('IdempotencyStore (mock Redis)', () => {
  function mockRedis() {
    const data = new Map<string, string>();
    return {
      data,
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string, _mode: string, _ttl: number) => {
        data.set(k, v);
        return 'OK';
      },
    } as unknown as import('ioredis').Redis;
  }

  it('hit replays cached value on same body hash', async () => {
    const redis = mockRedis();
    const store = new IdempotencyStore(redis);
    await store.store<{ commit: string }>('ns', 'k', 'bh', { commit: 'sha1' });
    const r = await store.lookup<{ commit: string }>('ns', 'k', 'bh');
    expect(r.status).toBe('hit');
    if (r.status === 'hit') {
      expect(r.value).toEqual({ commit: 'sha1' });
    }
  });

  it('collision when body hash differs', async () => {
    const redis = mockRedis();
    const store = new IdempotencyStore(redis);
    await store.store<{ commit: string }>('ns', 'k', 'bh1', { commit: 'sha1' });
    const r = await store.lookup<{ commit: string }>('ns', 'k', 'bh-different');
    expect(r.status).toBe('collision');
  });

  it('miss when key not present', async () => {
    const redis = mockRedis();
    const store = new IdempotencyStore(redis);
    const r = await store.lookup<{ commit: string }>('ns', 'never-seen', 'bh');
    expect(r.status).toBe('miss');
  });
});

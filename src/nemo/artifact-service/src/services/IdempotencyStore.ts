import { createHash } from 'crypto';
import type { Redis } from 'ioredis';

/**
 * Best-effort dedup cache for write-tool retries. Per the plan it is
 * never the source of truth: bare repos on NFS are the durability
 * boundary, and if Redis is unreachable we degrade gracefully — every
 * lookup returns "miss" and the write proceeds (git's content
 * addressing handles identical retries on its own).
 *
 * Same key + same body → cached `commitSha` is replayed.
 * Same key + different body → reject (`status: 'collision'`).
 */
export interface IdempotencyHit<T> {
  status: 'hit';
  value: T;
}
export interface IdempotencyMiss {
  status: 'miss';
}
export interface IdempotencyCollision {
  status: 'collision';
}
export type IdempotencyLookup<T> =
  | IdempotencyHit<T>
  | IdempotencyMiss
  | IdempotencyCollision;

export interface IdempotencyEntry<T> {
  /** sha256 of the canonicalised request body, for collision detection. */
  bodyHash: string;
  value: T;
}

const DEFAULT_TTL_SEC = 86_400;

export class IdempotencyStore {
  constructor(
    private readonly redis: Redis | null,
    private readonly ttlSec: number = DEFAULT_TTL_SEC,
  ) {}

  static hashBody(body: unknown): string {
    let payload: string;
    try {
      payload = JSON.stringify(body, (_k, v) =>
        v instanceof Uint8Array ? `bytes:${v.length}:${Buffer.from(v.subarray(0, 64)).toString('hex')}` : v,
      );
    } catch {
      payload = String(body);
    }
    return createHash('sha256').update(payload).digest('hex');
  }

  async lookup<T>(
    namespace: string,
    key: string,
    bodyHash: string,
  ): Promise<IdempotencyLookup<T>> {
    if (!this.redis) return { status: 'miss' };
    try {
      const raw = await this.redis.get(this.k(namespace, key));
      if (!raw) return { status: 'miss' };
      const entry = JSON.parse(raw) as IdempotencyEntry<T>;
      if (entry.bodyHash !== bodyHash) return { status: 'collision' };
      return { status: 'hit', value: entry.value };
    } catch {
      return { status: 'miss' };
    }
  }

  async store<T>(
    namespace: string,
    key: string,
    bodyHash: string,
    value: T,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const entry: IdempotencyEntry<T> = { bodyHash, value };
      await this.redis.set(
        this.k(namespace, key),
        JSON.stringify(entry),
        'EX',
        this.ttlSec,
      );
    } catch {
      // best-effort: swallow
    }
  }

  private k(namespace: string, key: string): string {
    return `artifact_idem:${namespace}:${key}`;
  }
}

/**
 * Build an ioredis client from env vars, returning null when no Redis
 * config is present. Treats null as "no cross-pod dedup" — service
 * still works (git's content addressing handles identical retries).
 *
 * Honours REDIS_URL first (platform convention), falls back to
 * REDIS_HOST/PORT/PASSWORD for local-dev convenience.
 */
export async function maybeCreateRedis(): Promise<Redis | null> {
  const url = process.env.REDIS_URL;
  const host = process.env.REDIS_HOST;
  if (!url && !host) return null;
  const { default: Redis } = await import('ioredis');
  const opts = {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  } as const;
  if (url) {
    return new Redis(url, opts);
  }
  return new Redis({
    host: host!,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    ...opts,
  });
}

import { randomBytes } from 'crypto';
import { Db } from '../db/Db';
import { ArtifactStoreRow, ArtifactStoreState } from '../types/ArtifactStore';

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Mirror of `services/ArtifactStoreIdGenerator.ts` in config-service.
 * Lives here so artifact-service can synthesise ids without taking a
 * cross-service dependency. Format: `as<8 base36>`.
 *
 * 16 random bytes (128 bits) is enough headroom to produce 8 base36
 * characters (~41 bits) via the unbiased BigInt div/mod loop without
 * a fallback path that could introduce modulo bias. CodeQL flagged
 * the previous `byte % 36` fallback even though it was unreachable
 * in practice; this version avoids it entirely.
 */
function generateStoreId(): string {
  const RANDOM_BYTES = 16;
  const bytes = randomBytes(RANDOM_BYTES);
  let num = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  while (num > 0n && result.length < 8) {
    result = BASE36[Number(num % 36n)] + result;
    num = num / 36n;
  }
  // 128 random bits produce 8 base36 chars in all but ~2^-91 of
  // outcomes; on that astronomical tail, left-pad with '0' instead
  // of throwing so store creation never 500s. The result stays
  // unbiased across the full 36^8 id space.
  while (result.length < 8) {
    result = '0' + result;
  }
  return 'as' + result;
}

const COLUMNS = `
  "id", "projectId", "name", "description", "ownerUserId",
  "defaultBranch", "lfsThresholdBytes", "quotaBytes",
  "state", "createdAt", "updatedAt"
`;

export interface CreateStoreInput {
  projectId: string;
  name: string;
  ownerUserId: string;
  description?: string;
  defaultBranch?: string;
  lfsThresholdBytes?: number;
  quotaBytes?: number | null;
}

export interface ListStoresFilter {
  projectId: string;
  ownerUserId?: string;
  states?: ArtifactStoreState[];
  limit?: number;
}

export interface UpdateStoreInput {
  name?: string;
  description?: string | null;
  quotaBytes?: number | null;
  state?: ArtifactStoreState;
}

export class StoreRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateStoreInput): Promise<ArtifactStoreRow> {
    const id = generateStoreId();
    const row = await this.db.one<ArtifactStoreRow>(
      `INSERT INTO "artifact_stores" (
         "id", "projectId", "name", "description", "ownerUserId",
         "defaultBranch", "lfsThresholdBytes", "quotaBytes",
         "state", "createdAt", "updatedAt"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW(), NOW())
       RETURNING ${COLUMNS}`,
      [
        id,
        input.projectId,
        input.name,
        input.description ?? null,
        input.ownerUserId,
        input.defaultBranch ?? 'main',
        input.lfsThresholdBytes ?? 102400,
        input.quotaBytes ?? null,
      ],
    );
    if (!row) throw new Error('store insert returned no row');
    return row;
  }

  async findById(id: string): Promise<ArtifactStoreRow | null> {
    return this.db.one<ArtifactStoreRow>(
      `SELECT ${COLUMNS} FROM "artifact_stores" WHERE "id" = $1`,
      [id],
    );
  }

  async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ArtifactStoreRow | null> {
    return this.db.one<ArtifactStoreRow>(
      `SELECT ${COLUMNS} FROM "artifact_stores" WHERE "projectId" = $1 AND "name" = $2`,
      [projectId, name],
    );
  }

  async list(filter: ListStoresFilter): Promise<ArtifactStoreRow[]> {
    const where: string[] = ['"projectId" = $1'];
    const params: unknown[] = [filter.projectId];
    if (filter.ownerUserId) {
      params.push(filter.ownerUserId);
      where.push(`"ownerUserId" = $${params.length}`);
    }
    if (filter.states && filter.states.length > 0) {
      params.push(filter.states);
      where.push(`"state" = ANY($${params.length})`);
    } else {
      where.push(`"state" <> 'deleting'`);
    }
    const limit = filter.limit ?? 200;
    return this.db.query<ArtifactStoreRow>(
      `SELECT ${COLUMNS} FROM "artifact_stores"
       WHERE ${where.join(' AND ')}
       ORDER BY "createdAt" DESC
       LIMIT ${Math.max(1, Math.min(1000, limit))}`,
      params,
    );
  }

  async update(
    id: string,
    patch: UpdateStoreInput,
  ): Promise<ArtifactStoreRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      params.push(patch.name);
      sets.push(`"name" = $${params.length}`);
    }
    if (patch.description !== undefined) {
      params.push(patch.description);
      sets.push(`"description" = $${params.length}`);
    }
    if (patch.quotaBytes !== undefined) {
      params.push(patch.quotaBytes);
      sets.push(`"quotaBytes" = $${params.length}`);
    }
    if (patch.state !== undefined) {
      params.push(patch.state);
      sets.push(`"state" = $${params.length}`);
    }
    if (sets.length === 0) {
      return this.findById(id);
    }
    sets.push(`"updatedAt" = NOW()`);
    params.push(id);
    return this.db.one<ArtifactStoreRow>(
      `UPDATE "artifact_stores"
       SET ${sets.join(', ')}
       WHERE "id" = $${params.length}
       RETURNING ${COLUMNS}`,
      params,
    );
  }

  /**
   * Hard-delete a row from the catalog. Used by the create route to
   * roll back the DB insert when `engine.initStore` fails — otherwise
   * the row would be left behind pointing at a non-existent bare repo
   * and every subsequent request for that id would 5xx.
   */
  async hardDelete(id: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `DELETE FROM "artifact_stores" WHERE "id" = $1 RETURNING "id"`,
      [id],
    );
    return row !== null;
  }

  /** Soft-delete: mark the row as archived. Hard-delete is a P3 worker. */
  async softDelete(id: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `UPDATE "artifact_stores"
       SET "state" = 'archived', "updatedAt" = NOW()
       WHERE "id" = $1 AND "state" <> 'deleting'
       RETURNING "id"`,
      [id],
    );
    return row !== null;
  }
}

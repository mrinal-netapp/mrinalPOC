import { Db } from '../db/Db';
import {
  ArtifactStoreAclRow,
  ArtifactStoreAclRole,
  ArtifactStorePrincipalType,
} from '../types/ArtifactStore';

const COLUMNS = `
  "id", "storeId", "principalType", "principalId",
  "role", "grantedBy", "grantedAt"
`;

export interface UpsertAclInput {
  storeId: string;
  principalType: ArtifactStorePrincipalType;
  principalId: string;
  role: ArtifactStoreAclRole;
  grantedBy?: string;
}

export class AclRepo {
  constructor(private readonly db: Db) {}

  async listForStore(storeId: string): Promise<ArtifactStoreAclRow[]> {
    return this.db.query<ArtifactStoreAclRow>(
      `SELECT ${COLUMNS} FROM "artifact_store_acls" WHERE "storeId" = $1`,
      [storeId],
    );
  }

  /**
   * Find a specific (store, principal) ACL row, if any.
   */
  async find(
    storeId: string,
    principalType: ArtifactStorePrincipalType,
    principalId: string,
  ): Promise<ArtifactStoreAclRow | null> {
    return this.db.one<ArtifactStoreAclRow>(
      `SELECT ${COLUMNS} FROM "artifact_store_acls"
       WHERE "storeId" = $1 AND "principalType" = $2 AND "principalId" = $3`,
      [storeId, principalType, principalId],
    );
  }

  /**
   * Batch-fetch ACL rows for a list of storeIds AND a set of
   * `(principalType, principalId)` pairs of interest. Returns every
   * row across the cartesian product where a grant exists. Used by
   * `AclResolver.resolveMany` to avoid the N+1 query pattern when
   * listing many stores at once. The principal-pair list typically
   * contains the caller's own principal plus their team (when an
   * agent acts within a team).
   */
  async findManyForStores(
    storeIds: string[],
    principals: Array<{ principalType: ArtifactStorePrincipalType; principalId: string }>,
  ): Promise<ArtifactStoreAclRow[]> {
    if (storeIds.length === 0 || principals.length === 0) return [];
    // Build a flat list of (type, id) pairs for the IN ANY(ARRAY[...]) clause.
    const principalTypes = principals.map((p) => p.principalType);
    const principalIds = principals.map((p) => p.principalId);
    return this.db.query<ArtifactStoreAclRow>(
      `SELECT ${COLUMNS} FROM "artifact_store_acls"
       WHERE "storeId" = ANY($1::text[])
         AND ("principalType", "principalId") IN (
           SELECT * FROM UNNEST($2::text[], $3::text[])
         )`,
      [storeIds, principalTypes, principalIds],
    );
  }

  async upsert(input: UpsertAclInput): Promise<ArtifactStoreAclRow> {
    const row = await this.db.one<ArtifactStoreAclRow>(
      `INSERT INTO "artifact_store_acls"
         ("storeId", "principalType", "principalId", "role", "grantedBy", "grantedAt")
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT ("storeId", "principalType", "principalId")
       DO UPDATE SET "role" = EXCLUDED."role",
                     "grantedBy" = EXCLUDED."grantedBy",
                     "grantedAt" = NOW()
       RETURNING ${COLUMNS}`,
      [
        input.storeId,
        input.principalType,
        input.principalId,
        input.role,
        input.grantedBy ?? null,
      ],
    );
    if (!row) throw new Error('acl upsert returned no row');
    return row;
  }

  async remove(
    storeId: string,
    principalType: ArtifactStorePrincipalType,
    principalId: string,
  ): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `DELETE FROM "artifact_store_acls"
       WHERE "storeId" = $1 AND "principalType" = $2 AND "principalId" = $3
       RETURNING "id"`,
      [storeId, principalType, principalId],
    );
    return row !== null;
  }
}

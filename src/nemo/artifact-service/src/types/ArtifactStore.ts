/**
 * Type mirrors of the TypeORM entities in config-service. The schema
 * is owned by config-service (it runs the TypeORM synchronize); we
 * only read/write rows via raw SQL.
 */

export type ArtifactStoreState = 'active' | 'archived' | 'deleting';

export interface ArtifactStoreRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  defaultBranch: string;
  lfsThresholdBytes: number;
  quotaBytes: number | null;
  state: ArtifactStoreState;
  createdAt: Date;
  updatedAt: Date;
}

export type ArtifactStorePrincipalType = 'user' | 'agent' | 'team' | 'service';
export type ArtifactStoreAclRole = 'owner' | 'writer' | 'reader';

export interface ArtifactStoreAclRow {
  id: string;
  storeId: string;
  principalType: ArtifactStorePrincipalType;
  principalId: string;
  role: ArtifactStoreAclRole;
  grantedBy: string | null;
  grantedAt: Date;
}

/** Public-facing shape returned by REST endpoints. */
export interface ArtifactStoreView {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  ownerUserId: string;
  defaultBranch: string;
  lfsThresholdBytes: number;
  quotaBytes?: number;
  state: ArtifactStoreState;
  createdAt: string;
  updatedAt: string;
}

export function toStoreView(r: ArtifactStoreRow): ArtifactStoreView {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    description: r.description ?? undefined,
    ownerUserId: r.ownerUserId,
    defaultBranch: r.defaultBranch,
    lfsThresholdBytes: r.lfsThresholdBytes,
    quotaBytes: r.quotaBytes ?? undefined,
    state: r.state,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  };
}

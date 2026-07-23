import * as path from 'path';

/**
 * Resolves on-disk paths for artifact-store bare repos and the
 * project-scoped CAS sidecar.
 *
 * Layout (matches projects/{projectId}/knowledge_bases/{kbId}/ style):
 *
 *   <root>/projects/{projectId}/artifacts/{storeId}/   # bare git repo
 *   <root>/projects/{projectId}/artifacts/_blobs/sha256/aa/bb/aabb…cdef
 *
 * `root` defaults to the env var NEMO_DEFAULT_STORE_ROOT, falling back to
 * /mnt/pvcs/default-nemo (the platform's shared NFS PVC mount).
 */
export class PathResolver {
  private readonly root: string;

  constructor(root?: string) {
    this.root =
      root ??
      process.env.NEMO_DEFAULT_STORE_ROOT ??
      '/mnt/pvcs/default-nemo';
  }

  rootDir(): string {
    return this.root;
  }

  projectDir(projectId: string): string {
    this.assertSafeId(projectId, 'projectId');
    return path.join(this.root, 'projects', projectId);
  }

  artifactsDir(projectId: string): string {
    return path.join(this.projectDir(projectId), 'artifacts');
  }

  /** Bare git repo directory for a store. The directory IS the repo. */
  repoDir(projectId: string, storeId: string): string {
    this.assertSafeId(storeId, 'storeId');
    return path.join(this.artifactsDir(projectId), storeId);
  }

  /** Project-scoped CAS sidecar root. */
  blobsDir(projectId: string): string {
    return path.join(this.artifactsDir(projectId), '_blobs');
  }

  /** Returns the sha256-sharded path for a CAS blob. */
  blobPath(projectId: string, sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`invalid sha256 hex: ${sha256}`);
    }
    return path.join(
      this.blobsDir(projectId),
      'sha256',
      sha256.slice(0, 2),
      sha256.slice(2, 4),
      sha256,
    );
  }

  private assertSafeId(id: string, label: string): void {
    if (!id || typeof id !== 'string') {
      throw new Error(`${label} is required`);
    }
    if (id.includes('/') || id.includes('..') || id.startsWith('.')) {
      throw new Error(`${label} contains illegal characters: ${id}`);
    }
  }
}

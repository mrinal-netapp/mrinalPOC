/**
 * Default bucket configuration utilities.
 *
 * The default bucket (e.g. "default-nemo") is provisioned at app/install start
 * by Helm/s3gateway. It is not created per-project. All projects share this
 * single bucket and are isolated by path prefix: projects/<projectId>/...
 */

/** Default warehouse name used in Lakekeeper (static, not the bucket name). */
export const DEFAULT_WAREHOUSE_NAME = 'nemo';

/** Return the configured default bucket name (env DEFAULT_BUCKET_NAME, default "default-nemo"). */
export function getDefaultBucketName(): string {
  return process.env.DEFAULT_BUCKET_NAME || 'default-nemo';
}

/** Return the configured default bucket deployment ID (env DEFAULT_BUCKET_DEPLOYMENT_ID). */
export function getDefaultBucketDeploymentId(): string | undefined {
  return process.env.DEFAULT_BUCKET_DEPLOYMENT_ID || undefined;
}

/**
 * Parse a project home_dir URI into bucket name and path prefix.
 *
 * @example
 *   getProjectStorageRoot({ home_dir: 's3://default-nemo/projects/abc123' })
 *   // => { bucketName: 'default-nemo', pathPrefix: 'projects/abc123' }
 */
export function getProjectStorageRoot(project: { home_dir: string }): {
  bucketName: string;
  pathPrefix: string;
} {
  const homeDir = project.home_dir;

  const match = homeDir.match(/^s3:\/\/([^/]+)\/(.+?)\/?\s*$/);
  if (!match) {
    throw new Error(`Invalid home_dir format: ${homeDir}. Expected s3://<bucket>/<path>`);
  }

  return {
    bucketName: match[1],
    pathPrefix: match[2].replace(/\/+$/, ''), // normalise trailing slash
  };
}

/**
 * Convenience: is the given bucket name the default (global) bucket?
 */
export function isDefaultBucket(bucketName: string): boolean {
  return bucketName === getDefaultBucketName();
}

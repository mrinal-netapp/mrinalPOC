/**
 * Parse project `home_dir` into S3 bucket and key prefix.
 * Matches config-service `getProjectStorageRoot` (s3://bucket/path).
 */
export function parseProjectStorageRoot(homeDir: string | undefined | null): {
  bucketName: string
  pathPrefix: string
} | null {
  if (!homeDir || typeof homeDir !== 'string') return null
  const m = homeDir.match(/^s3:\/\/([^/]+)\/(.+?)\/?\s*$/)
  if (!m) return null
  return {
    bucketName: m[1],
    pathPrefix: m[2].replace(/\/+$/, ''),
  }
}

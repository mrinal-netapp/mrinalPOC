/**
 * project-storage.ts
 *
 * Parse a project `home_dir` into its S3 bucket and key prefix.
 * Mirrors the GUI helper `parseProjectStorageRoot` and the config-service
 * `getProjectStorageRoot` (home_dir is always `s3://bucket/path`).
 */
export interface ProjectStorageRoot {
  bucketName: string;
  pathPrefix: string;
}

export function parseProjectStorageRoot(
  homeDir: string | undefined | null,
): ProjectStorageRoot | null {
  if (!homeDir || typeof homeDir !== "string") return null;
  const m = homeDir.match(/^s3:\/\/([^/]+)\/(.+?)\/?\s*$/);
  if (!m) return null;
  return {
    bucketName: m[1],
    pathPrefix: m[2].replace(/\/+$/, ""),
  };
}

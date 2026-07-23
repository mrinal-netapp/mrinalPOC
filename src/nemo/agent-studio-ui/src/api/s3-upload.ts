/**
 * s3-upload.ts
 *
 * Browser-side helpers for manual dataset uploads. Files are PUT directly to
 * the deployment S3 gateway (path-style, authenticated with the same Bearer
 * token used by the API slices) at:
 *   {origin}/s3/{bucket}/{pathPrefix}/datasets/{datasetId}/data_files/{relPath}
 *
 * Ported from the GUI (`services/api.ts` s3Api.putObject + ProjectDatasets.tsx
 * upload helpers) so behavior matches the existing dataset wizard exactly.
 */
import { resolveAccessToken } from "./auth-access-token";

/** Parallel browser uploads for manual datasets (limits concurrent connections). */
export const MANUAL_UPLOAD_CONCURRENCY = 4;

/** Default S3 gateway endpoint — current origin with the `/s3` proxy prefix. */
export function getDefaultS3Endpoint(): string {
  return `${window.location.protocol}//${window.location.host}/s3`;
}

/** Encode an S3 key path segment-by-segment, keeping "/" as the separator. */
function encodeS3KeyPath(objectKey: string): string {
  if (!objectKey) return "";
  return objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Build a path-style S3 URL path: /{bucket}/{encoded-key}. */
export function buildS3ObjectPath(bucketName: string, objectKey?: string): string {
  const encodedBucket = encodeURIComponent(bucketName);
  if (!objectKey) return `/${encodedBucket}`;
  return `/${encodedBucket}/${encodeS3KeyPath(objectKey)}`;
}

/**
 * GET a single object from S3 via the gateway proxy. Returns `null` when the
 * object is missing (HTTP 404). Throws for other non-2xx responses.
 */
export async function getObjectText(
  bucketName: string,
  objectKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const endpoint = getDefaultS3Endpoint().replace(/\/+$/, "");
  const fullUrl = `${endpoint}${buildS3ObjectPath(bucketName, objectKey)}`;
  const headers: Record<string, string> = {};
  const token = resolveAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(fullUrl, { method: "GET", headers, signal });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Download failed (${response.status}): ${body || response.statusText}`);
  }
  return response.text();
}

/** Upload-relative path for a File: directory-relative path, or the file name. */
export function getFileRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

/** Replace spaces/special chars in each path segment with "_" for S3 keys. */
export function sanitizeUploadRelativePath(relativePath: string): string {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const sanitized = segment.replace(/[^A-Za-z0-9._-]/g, "_");
      return sanitized || "file";
    })
    .join("/");
}

/**
 * PUT a single object to S3 via the gateway proxy. Reports progress and
 * supports cancellation via an AbortSignal.
 */
export function putObject(
  bucketName: string,
  objectKey: string,
  file: File | Blob,
  onProgress?: (uploaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Upload aborted", "AbortError"));
  }

  const endpoint = getDefaultS3Endpoint().replace(/\/+$/, "");
  const fullUrl = `${endpoint}${buildS3ObjectPath(bucketName, objectKey)}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      xhr.abort();
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    xhr.open("PUT", fullUrl, true);

    const token = resolveAccessToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    const contentType = (file as File).type || "application/octet-stream";
    xhr.setRequestHeader("Content-Type", contentType);

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }

    xhr.onload = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText || xhr.statusText}`));
      }
    };

    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Network error during upload"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    xhr.send(file);
  });
}

/**
 * Run `runIndex` over `[0, taskCount)` with bounded parallelism. Stops early
 * when the signal aborts. Order of results is the caller's responsibility.
 */
export async function runWithConcurrency(
  taskCount: number,
  concurrency: number,
  runIndex: (index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (taskCount <= 0) return;
  const workers = Math.min(Math.max(1, concurrency), taskCount);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= taskCount) return;
      await runIndex(i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

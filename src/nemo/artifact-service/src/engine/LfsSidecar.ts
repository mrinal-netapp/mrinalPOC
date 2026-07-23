import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver } from './PathResolver';

/**
 * Content-addressable LFS-style sidecar for large blobs.
 *
 * Files at or above `lfsThresholdBytes` are stored once under the
 * project-scoped `_blobs/sha256/...` tree; the in-repo blob is a small
 * pointer JSON. This keeps git pack sizes bounded even when a store
 * accumulates many large ML/data artifacts, and dedups across stores
 * within a project.
 *
 * Pointer shape (UTF-8 JSON, no trailing newline):
 *   {"_lfs":"sha256:<hex>","size":<int>,"mime":"<string>"}
 *
 * Callers commit the pointer's bytes as the git blob; on read we
 * detect the magic prefix and transparently dereference.
 */
export const LFS_POINTER_MAGIC = '{"_lfs":"sha256:';

export interface LfsPointer {
  sha256: string;
  size: number;
  mime?: string;
}

export class LfsSidecar {
  constructor(private readonly paths: PathResolver) {}

  /** True if the blob bytes look like a pointer JSON we generated. */
  static isPointer(blob: Uint8Array): boolean {
    if (blob.length < LFS_POINTER_MAGIC.length) return false;
    for (let i = 0; i < LFS_POINTER_MAGIC.length; i++) {
      if (blob[i] !== LFS_POINTER_MAGIC.charCodeAt(i)) return false;
    }
    return true;
  }

  static parsePointer(blob: Uint8Array): LfsPointer {
    const text = new TextDecoder().decode(blob);
    const obj = JSON.parse(text);
    if (typeof obj?._lfs !== 'string' || !obj._lfs.startsWith('sha256:')) {
      throw new Error('not an LFS pointer JSON');
    }
    return {
      sha256: obj._lfs.slice('sha256:'.length),
      size: Number(obj.size),
      mime: typeof obj.mime === 'string' ? obj.mime : undefined,
    };
  }

  static encodePointer(p: LfsPointer): Uint8Array {
    const payload: Record<string, unknown> = {
      _lfs: `sha256:${p.sha256}`,
      size: p.size,
    };
    if (p.mime) payload.mime = p.mime;
    return new TextEncoder().encode(JSON.stringify(payload));
  }

  /**
   * Write content to the project's CAS tree, returning the resulting
   * pointer. Idempotent on identical content (sha collision → same path).
   */
  async store(
    projectId: string,
    content: Uint8Array,
    mime?: string,
  ): Promise<LfsPointer> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const finalPath = this.paths.blobPath(projectId, sha256);
    try {
      await fs.access(finalPath);
      // Already present — content-addressed; nothing more to do.
    } catch {
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, content);
      await fs.rename(tmp, finalPath);
    }
    return { sha256, size: content.length, mime };
  }

  async load(projectId: string, pointer: LfsPointer): Promise<Uint8Array> {
    const file = this.paths.blobPath(projectId, pointer.sha256);
    const buf = await fs.readFile(file);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

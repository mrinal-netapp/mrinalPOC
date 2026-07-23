import type { KnowledgeBase } from '../models/KnowledgeBase';
import { jsonFieldEqual } from './jsonFieldEquals';

/** Fields that affect indexing — deferred on PUT until the workflow succeeds. */
export const KB_PROCESSING_UPDATE_KEYS = [
  'sourceDataset',
  'embeddingModel',
  'embeddingModelId',
  'chunkSize',
  'vectorSize',
  'dataType',
  'chunkStrategy',
  'chunkOverlap',
  'chunkOptions',
  'indexingMode',
  'quantizationType',
  'quantizationOptions',
  'textColumns',
] as const;

/** User-editable metadata fields applied immediately on PUT. */
export const KB_METADATA_UPDATE_KEYS = [
  'name',
  'description',
  'labels',
  'synchronizationConfig',
] as const;

/** Workflow-writer fields (workflow-engine / kb-processor PUT on completion). */
export const KB_WORKFLOW_UPDATE_KEYS = [
  'status',
  'lanceTablePath',
  'errorMessage',
  'stats',
  'lastSyncedAt',
  'jobId',
] as const;

const KB_PROCESSING_UPDATE_KEY_SET = new Set<string>(KB_PROCESSING_UPDATE_KEYS);
const KB_METADATA_UPDATE_KEY_SET = new Set<string>(KB_METADATA_UPDATE_KEYS);
const KB_WORKFLOW_UPDATE_KEY_SET = new Set<string>(KB_WORKFLOW_UPDATE_KEYS);

/** Processing keys where an empty string intentionally clears the persisted value. */
const KB_PROCESSING_EMPTY_STRING_CLEAR_KEYS = new Set<string>(['textColumns']);

/**
 * Strict regex sanitizer for keys copied from caller-supplied PUT bodies.
 * Must start with a letter so reserved names like `__proto__` are rejected.
 * CodeQL `js/property-injection` recognises a `.test()` call against a
 * literal regex as a sanitizer for tainted property names.
 */
const SAFE_KB_UPDATE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

function isSafeKnowledgeBaseUpdateKey(key: string): boolean {
  if (!SAFE_KB_UPDATE_KEY.test(key)) return false;
  if (key === 'constructor' || key === 'prototype' || key === '__proto__') {
    return false;
  }
  return true;
}

export function splitKnowledgeBaseUpdateBody(body: Record<string, unknown>): {
  metadataUpdate: Record<string, unknown>;
  processingOverrides: Record<string, unknown>;
} {
  const metadataUpdate: Record<string, unknown> = Object.create(null);
  const processingOverrides: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || !isSafeKnowledgeBaseUpdateKey(key)) continue;
    if (KB_PROCESSING_UPDATE_KEY_SET.has(key)) {
      const isWhitespaceOnlyString = typeof value === 'string' && value.trim() === '';
      if (
        value == null
        || (isWhitespaceOnlyString && !KB_PROCESSING_EMPTY_STRING_CLEAR_KEYS.has(key))
      ) {
        continue;
      }
      processingOverrides[key] =
        KB_PROCESSING_EMPTY_STRING_CLEAR_KEYS.has(key) && typeof value === 'string'
          ? value.trim()
          : value;
    } else if (KB_METADATA_UPDATE_KEY_SET.has(key)) {
      metadataUpdate[key] = value;
    }
  }
  return { metadataUpdate, processingOverrides };
}

/**
 * Extract workflow completion fields when `status` is present in the PUT body.
 * Also commits deferred processing fields sent by the workflow on success.
 * Returns null for user-metadata PUTs (no `status` key).
 */
export function extractKnowledgeBaseWorkflowUpdate(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (body.status === undefined) return null;

  const workflowUpdate: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || !isSafeKnowledgeBaseUpdateKey(key)) continue;
    if (KB_WORKFLOW_UPDATE_KEY_SET.has(key) || KB_PROCESSING_UPDATE_KEY_SET.has(key)) {
      workflowUpdate[key] = value;
    }
  }

  const status = workflowUpdate.status;
  if (status === 'ready' || status === 'in_progress') {
    workflowUpdate.errorMessage = null;
  }

  return workflowUpdate;
}

export function knowledgeBaseProcessingOverridesChanged(
  kb: KnowledgeBase,
  overrides: Record<string, unknown>,
): boolean {
  const kbRecord = kb as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (!jsonFieldEqual(kbRecord[key], value)) {
      return true;
    }
  }
  return false;
}

import type { DataSet } from '../models/DataSet';
import { jsonFieldEqual } from './jsonFieldEquals';

/** Fields whose change should trigger a new acquisition workflow on PUT update. */
export const DATASET_ACQUISITION_SCOPE_KEYS = [
  'filterSpec',
  'acquisitionConfig',
  'sqlQuery',
  'sourceDatabase',
  'sourceSchema',
  'resourceSelector',
  'originConnector',
  'originVolume',
] as const;

/** Snake_case aliases accepted by dataset validators mapped to canonical scope keys. */
const DATASET_ACQUISITION_SCOPE_PATCH_ALIASES: Partial<
  Record<(typeof DATASET_ACQUISITION_SCOPE_KEYS)[number], string>
> = {
  originVolume: 'origin_volume',
};

function acquisitionScopePatchValue(
  patch: Record<string, unknown>,
  key: (typeof DATASET_ACQUISITION_SCOPE_KEYS)[number],
): unknown | undefined {
  if (key in patch && patch[key] !== undefined) return patch[key];
  const alias = DATASET_ACQUISITION_SCOPE_PATCH_ALIASES[key];
  if (alias && alias in patch && patch[alias] !== undefined) return patch[alias];
  return undefined;
}

export function isAcquiredDataset(dataset: DataSet): boolean {
  return dataset.type === 'acquired' || !!(dataset.originConnector || dataset.originVolume);
}

export function datasetAcquisitionScopeChanged(
  current: DataSet,
  patch: Record<string, unknown>,
): boolean {
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const key of DATASET_ACQUISITION_SCOPE_KEYS) {
    const patchValue = acquisitionScopePatchValue(patch, key);
    if (patchValue === undefined) continue;
    if (!jsonFieldEqual(patchValue, currentRecord[key])) {
      return true;
    }
  }
  return false;
}

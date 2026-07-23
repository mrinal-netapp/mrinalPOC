import type { DatasetListItem } from '@/api/dataset.types';
import type { KBAssignedDataset } from '@/api/kb.types';

function formatFileScopeSegments(rawFiles: number | undefined, rawFolders: number | undefined): string {
  const files = Math.max(0, Math.trunc(rawFiles ?? 0));
  const filesLabel = `${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'}`;

  let foldersSegment = 'n/a';
  if (typeof rawFolders === 'number' && Number.isFinite(rawFolders)) {
    const folders = Math.max(0, Math.trunc(rawFolders));
    foldersSegment = `${folders.toLocaleString('en-US')} folder${folders === 1 ? '' : 's'}`;
  }

  return `${filesLabel} / ${foldersSegment}`;
}

/** KB dataset picker: `x files / y folders`; folder segment is `n/a` when count is unknown. */
export function formatKbDatasetPickerFileScope(row: DatasetListItem): string {
  return formatFileScopeSegments(row.files_count, row.latest_snapshot?.total_folders);
}

/** Assigned dataset card: `x files / n/a` (folder count not available on KBAssignedDataset). */
export function formatKbAssignedDatasetFileScope(dataset: KBAssignedDataset): string {
  const rawFiles = dataset.file_scope !== undefined ? Number(dataset.file_scope) : undefined;
  return formatFileScopeSegments(Number.isFinite(rawFiles) ? rawFiles : undefined, undefined);
}

/** List payloads do not include schedule flags; show placeholder until API exposes them. */
export function getKbDatasetPickerSyncScheduleLabel(): string {
  return '—';
}

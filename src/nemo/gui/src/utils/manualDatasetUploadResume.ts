/** Stored S3 entry for a successfully uploaded file (same shape as manifest entry). */
export type ManualUploadResumeEntry = {
  key: string
  url: string
  size?: number
  originalName?: string
}

export function manualUploadResumeStorageKey(projectId: string, datasetId: string): string {
  return `nemo-manual-dset-upload:${projectId}:${datasetId}`
}

function readMap(key: string): Record<string, ManualUploadResumeEntry> {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, ManualUploadResumeEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(key: string, map: Record<string, ManualUploadResumeEntry>) {
  try {
    sessionStorage.setItem(key, JSON.stringify(map))
  } catch {
    // Quota exceeded or private mode — resume is best-effort
  }
}

export function loadManualUploadResume(
  projectId: string,
  datasetId: string
): Record<string, ManualUploadResumeEntry> {
  return readMap(manualUploadResumeStorageKey(projectId, datasetId))
}

export function saveManualUploadResumeEntry(
  projectId: string,
  datasetId: string,
  fileId: string,
  entry: ManualUploadResumeEntry
) {
  const key = manualUploadResumeStorageKey(projectId, datasetId)
  const map = readMap(key)
  map[fileId] = entry
  writeMap(key, map)
}

export function clearManualUploadResume(projectId: string, datasetId: string) {
  try {
    sessionStorage.removeItem(manualUploadResumeStorageKey(projectId, datasetId))
  } catch {
    /* ignore */
  }
}

/** Remove all manual-upload resume blobs for a project (e.g. wizard reset). */
export function clearAllManualUploadResumeForProject(projectId: string) {
  const prefix = `nemo-manual-dset-upload:${projectId}:`
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k?.startsWith(prefix)) {
        sessionStorage.removeItem(k)
      }
    }
  } catch {
    /* ignore */
  }
}

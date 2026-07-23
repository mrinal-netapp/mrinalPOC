/**
 * Overall availability of a knowledge base, shown in the Status column.
 * Mapped from the config-service KB status (`ready | in_progress | errored |
 * deprecated`):
 * "Available"     — `ready`: index built, serving queries
 * "Synchronizing" — `in_progress`: ingesting / re-indexing
 * "Errored"       — `errored`: processing workflow failed
 * "Deprecated"    — `deprecated`: soft-retired
 */
export type KnowledgeBaseStatus =
  | "Available"
  | "Synchronizing"
  | "Errored"
  | "Deprecated";

/**
 * State of the latest ingestion / sync job, surfaced in the Job details
 * column next to the progress bar.
 */
export type KnowledgeBaseJobState = "Ready" | "Processing";

/**
 * Progress-bar payload for the Job details column.
 *
 * `progress` is a 0..1 ratio (not 0..100) so the bar component can scale
 * it without knowing about the underlying unit. Values are clamped at
 * the render layer, not here.
 */
export interface KnowledgeBaseJobDetails {
  state: KnowledgeBaseJobState;
  progress: number;
}

/**
 * Raw counts behind the "Indexed data" column. The cell formats them
 * via `Intl.NumberFormat` (I18-002) — never store the formatted string.
 *
 * e.g. `{ fileCount: 1247, vectorCount: 24900 }` → "1,247 files / 24,900 vectors".
 */
export interface KnowledgeBaseIndexedData {
  fileCount: number;
  vectorCount: number;
}

/**
 * One row in the Assigned knowledge bases tab of the Agent details page.
 *
 * Column ←→ field mapping (screenshot order):
 *   Name                 → `name`
 *   Status               → `status`
 *   Job details          → `job` (progress bar + state label)
 *   Indexed data         → `indexed`
 *   Last synchronization → `lastSyncISO` (formatted via Intl.DateTimeFormat)
 *   Labels               → `labels`
 *   Actions              → kebab menu (View details / Unassign / etc.)
 */
export interface AssignedKnowledgeBaseRow {
  id: string;
  name: string;
  status: KnowledgeBaseStatus;
  job: KnowledgeBaseJobDetails;
  indexed: KnowledgeBaseIndexedData;
  lastSyncISO: string;
  labels: string[];
}

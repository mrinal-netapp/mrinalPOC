import {
  IconCircleCheck,
  IconCircleX,
  IconCircleMinus,
  IconClock,
  IconLoader,
} from "@tabler/icons-react";

import type { KBStatus, KBSnapshotBuildStatus } from "@/api/kb.types";
import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";
import { POLLING_INTERVAL } from "@/consts/api.consts";

const KB_STATUS_ICON_MAP: Record<KBStatus, StatusVisualConfig> = {
  in_progress: { type: "spinner", color: "var(--notification-information)" },
  ready: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  errored: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  deprecated: { type: "icon", Icon: IconCircleMinus, color: "var(--text-disabled)" },
};

function getKBStatusVisual(status: KBStatus): StatusVisualConfig {
  return KB_STATUS_ICON_MAP[status] ?? KB_STATUS_ICON_MAP.in_progress;
}

function getKBStatusLabel(status: KBStatus, deprecated: boolean): string {
  if (deprecated) {
    return "Deprecated";
  }
  switch (status) {
    case "in_progress":
      return "In Progress";
    case "ready":
      return "Ready";
    case "errored":
      return "Errored";
    case "deprecated":
      return "Deprecated";
  }
}

function formatKBIndexedData(filesIndexed: number | undefined, vectors: number | undefined): string {
  const files = filesIndexed ?? 0;
  const vectorsCount = vectors ?? 0;
  return `${files.toLocaleString("en-US")} files / ${vectorsCount.toLocaleString("en-US")} vectors`;
}

const KB_SNAPSHOT_STATUS_MAP: Record<KBSnapshotBuildStatus, StatusVisualConfig> = {
  pending: { type: "icon", Icon: IconClock, color: "var(--notification-information)" },
  "in-progress": { type: "icon", Icon: IconLoader, color: "var(--notification-information)" },
  completed: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  errored: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
};

/**
 * Poll a single KB's detail query while it's still being processed so the UI
 * picks up the `ready`/`errored` transition on its own instead of requiring a
 * manual refresh. Returns `undefined` (no polling) once the KB has reached a
 * terminal state.
 */
function kbStatusPollingInterval(status: KBStatus | undefined): number | undefined {
  return status === "in_progress" ? POLLING_INTERVAL : undefined;
}

/**
 * Poll the KB list while any row is still `in_progress` (e.g. a newly
 * created KB that hasn't finished indexing yet). Stops polling once every
 * row has reached a terminal state, so a hard refresh is never required to
 * see a KB move from "In Progress" to "Ready".
 */
function kbListPollingInterval(statuses: KBStatus[] | undefined): number | undefined {
  const hasInProgress = statuses ? statuses.some((status) => status === "in_progress") : true;
  return hasInProgress ? POLLING_INTERVAL : undefined;
}

export {
  KB_STATUS_ICON_MAP,
  KB_SNAPSHOT_STATUS_MAP,
  getKBStatusVisual,
  getKBStatusLabel,
  formatKBIndexedData,
  kbStatusPollingInterval,
  kbListPollingInterval,
};

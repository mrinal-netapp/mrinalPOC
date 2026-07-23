import {
  IconAlertCircle,
  IconArchive,
  IconCircleCheck,
} from "@tabler/icons-react";

import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";
import type { KnowledgeBaseStatus } from "./assigned-kb-panel.types";

// Status column visuals. "Synchronizing" uses the shared spinner so it
// animates while the KB is ingesting; "Available" uses the green check;
// "Errored" uses a red alert; "Deprecated" uses a muted archive icon.
const KB_STATUS_VISUAL: Record<KnowledgeBaseStatus, StatusVisualConfig> = {
  Available: {
    type: "icon",
    Icon: IconCircleCheck,
    color: "var(--notification-success)",
  },
  Synchronizing: {
    type: "spinner",
    color: "var(--notification-information)",
  },
  Errored: {
    type: "icon",
    Icon: IconAlertCircle,
    color: "var(--notification-error)",
  },
  Deprecated: {
    type: "icon",
    Icon: IconArchive,
    color: "var(--text-disabled)",
  },
};

function getKbStatusVisual(status: KnowledgeBaseStatus): StatusVisualConfig {
  return KB_STATUS_VISUAL[status];
}

export { getKbStatusVisual };

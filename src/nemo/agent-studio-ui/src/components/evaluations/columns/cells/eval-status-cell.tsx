import type { ReactElement } from "react";
import {
  IconCircleCheck,
  IconCircleX,
  IconPlayerStop,
  IconCircleMinus,
} from "@tabler/icons-react";

import type { EvalRunStatus } from "@/routes/pages/evaluations/api/eval.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";

type StatusVisual = {
  type: "icon" | "spinner";
  Icon?: typeof IconCircleCheck;
  color: string;
  label: string;
};

const STATUS_MAP: Record<EvalRunStatus, StatusVisual> = {
  queued: { type: "icon", Icon: IconCircleMinus, color: "var(--text-disabled)", label: "Queued" },
  running: { type: "spinner", color: "var(--notification-information)", label: "Running" },
  // Canonical eval-worker values.
  aggregating: { type: "spinner", color: "var(--notification-information)", label: "Aggregating" },
  success: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)", label: "Completed" },
  failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)", label: "Failed" },
  cancelled: { type: "icon", Icon: IconPlayerStop, color: "var(--text-disabled)", label: "Cancelled" },
  // Legacy aliases — kept so any stale row / test fixture using the
  // old vocabulary still renders something sane instead of crashing.
  scoring: { type: "spinner", color: "var(--notification-information)", label: "Scoring" },
  completed: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)", label: "Completed" },
  stopped: { type: "icon", Icon: IconPlayerStop, color: "var(--text-disabled)", label: "Stopped" },
};

function EvalStatusCell({ status }: { status?: EvalRunStatus }): ReactElement {
  if (!status) {
    return <span className="eval-list-cell-placeholder">—</span>;
  }

  // Unknown status (status enum extended on the backend without a UI
  // patch) — render a neutral placeholder rather than crashing on
  // `visual.type`.
  const visual = STATUS_MAP[status];
  if (!visual) {
    return <span className="eval-list-cell-placeholder">{String(status)}</span>;
  }

  return (
    <span className="eval-list-status-cell">
      {visual.type === "spinner" ? (
        <Spinner size="cell" className="ds-status-spinner" />
      ) : (
        visual.Icon && <visual.Icon size={16} style={{ color: visual.color, flexShrink: 0 }} />
      )}
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {visual.label}
      </Typography>
    </span>
  );
}

export { EvalStatusCell };

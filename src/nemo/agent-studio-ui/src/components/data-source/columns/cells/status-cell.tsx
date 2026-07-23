import type { ReactElement } from "react";
import { IconCircleMinus } from "@tabler/icons-react";

import type { ActivityStatus, DataSourceStatus, ScanStatus } from "@/api/data-source.types";
import type { DatasetStatus } from "@/api/dataset.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import {
  STATUS_ICON_MAP,
  SCAN_STATUS_ICON_MAP,
  DATASET_STATUS_ICON_MAP,
  ACTIVITY_STATUS_ICON_MAP,
  DEPRECATED_VISUAL,
  getScanStatusLabel,
} from "@/components/data-source/utils/data-source.utils";

function StatusCell({ status, deprecated }: { status: DataSourceStatus; deprecated: boolean }): ReactElement {
  const visual = deprecated ? DEPRECATED_VISUAL : STATUS_ICON_MAP[status];
  const label = deprecated ? "Deprecated" : status;

  return (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">{label}</Typography>
    </span>
  );
}

const UNTESTED_VISUAL = { type: "icon" as const, Icon: IconCircleMinus, color: "var(--text-disabled)" };

/**
 * Connection status in the Test Connection vocabulary, derived from the
 * backend-persisted state:
 *   - Connector sources expose an explicit Test Connection outcome
 *     (`connectionTestStatus`): success → Success, failed → Failed,
 *     never tested → Untested.
 *   - Volume sources fall back to mount validation: never validated → Untested,
 *     Healthy → Success, everything else → Failed.
 */
function ConnectionStatusCell({
  status,
  lastValidatedAt,
  connectionTestStatus,
  deprecated,
}: {
  status: DataSourceStatus;
  lastValidatedAt: string | null;
  connectionTestStatus?: "success" | "failed" | null;
  deprecated: boolean;
}): ReactElement {
  let visual = UNTESTED_VISUAL as typeof DEPRECATED_VISUAL;
  let label = "Untested";

  if (deprecated) {
    visual = DEPRECATED_VISUAL;
    label = "Deprecated";
  } else if (connectionTestStatus === "success") {
    visual = STATUS_ICON_MAP.Healthy;
    label = "Success";
  } else if (connectionTestStatus === "failed") {
    visual = STATUS_ICON_MAP.Failed;
    label = "Failed";
  } else if (!lastValidatedAt) {
    visual = UNTESTED_VISUAL;
    label = "Untested";
  } else if (status === "Healthy") {
    visual = STATUS_ICON_MAP.Healthy;
    label = "Success";
  } else {
    visual = STATUS_ICON_MAP.Failed;
    label = "Failed";
  }

  return (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">{label}</Typography>
    </span>
  );
}

function ScanStatusCell({ status }: { status: ScanStatus }): ReactElement {
  const visual = SCAN_STATUS_ICON_MAP[status];

  return (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {getScanStatusLabel(status)}
      </Typography>
    </span>
  );
}

function DatasetStatusCell({ status }: { status: DatasetStatus }): ReactElement {
  const visual = DATASET_STATUS_ICON_MAP[status];

  return (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">{status}</Typography>
    </span>
  );
}

function ActivityStatusCell({ status }: { status: ActivityStatus }): ReactElement {
  const visual = ACTIVITY_STATUS_ICON_MAP[status];

  return (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">{status}</Typography>
    </span>
  );
}

export { StatusCell, ConnectionStatusCell, ScanStatusCell, DatasetStatusCell, ActivityStatusCell };

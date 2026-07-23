import { type MouseEvent, type ReactElement } from "react";
import { IconCopy } from "@tabler/icons-react";

import type { DatasetStatus, SynchronizationStatus, SnapshotStatus, DatasetInputType } from "@/api/dataset.types";
import { DatasetStatusCell as BaseDatasetStatusCell } from "@/components/data-source/columns/cells/status-cell";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Button } from "@/ui-lib/base-components/button/button";
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import {
  SYNC_STATUS_ICON_MAP,
  getSyncStatusLabel,
  getSnapshotResolvedStatus,
  isManualUploadSyncDisabled,
  isManualUploadListSyncHidden,
  resolveManualUploadImportStatus,
} from "@/components/dataset/utils/dataset.utils";

import "./status-cell.scss";

function StatusErrorTooltipContent({ message }: { message: string }): ReactElement {
  const handleCopy = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (!navigator.clipboard?.writeText) {
      toast.error("Clipboard is not available in this browser.");
      return;
    }
    void navigator.clipboard.writeText(message)
      .then(() => {
        toast.success("Copied to clipboard");
      })
      .catch(() => {
        toast.error("Could not copy to clipboard.");
      });
  };

  return (
    <div className="ds-status-error-tooltip">
      <div className="ds-status-error-tooltip__header">
        <Button
          type="button"
          variant="icon"
          size="small"
          icon={<IconCopy size={16} />}
          className="ds-status-error-tooltip__copy-btn"
          aria-label="Copy error message"
          onClick={handleCopy}
        />
      </div>
      <p className="ds-status-error-tooltip__message">{message}</p>
    </div>
  );
}

function withErrorTooltip(
  content: ReactElement,
  errorMessage?: string | null,
): ReactElement {
  if (!errorMessage) return content;

  return (
    <Tooltip
      className="ds-status-error-tooltip-popup"
      side="bottom"
      sideOffset={8}
      content={<StatusErrorTooltipContent message={errorMessage} />}
      trigger={(
        <button type="button" className="ds-status-error-tooltip-trigger">
          {content}
        </button>
      )}
    />
  );
}

function DatasetStatusCell({
  status,
  errorMessage,
}: {
  status: DatasetStatus;
  errorMessage?: string | null;
}): ReactElement {
  const content = <BaseDatasetStatusCell status={status} />;
  return withErrorTooltip(content, status === "Failed" ? errorMessage : undefined);
}

function SyncStatusCell({
  status,
  boldness = "regular",
  errorMessage,
  inputType,
  variant = "detail",
}: {
  status: SynchronizationStatus;
  boldness?: "regular" | "semibold";
  errorMessage?: string | null;
  inputType?: DatasetInputType;
  /** list/sync: sync N/A for manual uploads; import: detail-header import lifecycle. */
  variant?: "list" | "sync" | "import" | "detail";
}): ReactElement {
  if (variant === "import" && inputType === "upload") {
    const importStatus = resolveManualUploadImportStatus(status);
    const visual = SYNC_STATUS_ICON_MAP[importStatus];
    const content = (
      <span className="ds-status-cell">
        <StatusIcon visual={visual} />
        <Typography Component="span" fontSize="fs14" boldness={boldness}>
          {getSyncStatusLabel(importStatus)}
        </Typography>
      </span>
    );
    return withErrorTooltip(content, importStatus === "Failed" ? errorMessage : undefined);
  }

  if (variant === "list" && isManualUploadListSyncHidden(inputType)) {
    return <span className="ds-cell-placeholder">—</span>;
  }

  if (variant === "sync" && isManualUploadSyncDisabled(inputType)) {
    return (
      <Typography Component="span" fontSize="fs14" boldness={boldness} color="var(--text-disabled)">
        Disabled
      </Typography>
    );
  }

  const visual = SYNC_STATUS_ICON_MAP[status];

  const content = (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness={boldness}>
        {getSyncStatusLabel(status)}
      </Typography>
    </span>
  );

  return withErrorTooltip(content, status === "Failed" ? errorMessage : undefined);
}

interface SnapshotStatusCellProps {
  expired: boolean;
  isCurrent: boolean;
  status: SnapshotStatus;
}

function SnapshotDisplayStatusCell({ expired, isCurrent, status }: SnapshotStatusCellProps): ReactElement {
  const { visual, label } = getSnapshotResolvedStatus({ expired, isCurrent, status });

  return (
    <span className="ds-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {label}
      </Typography>
    </span>
  );
}

export { DatasetStatusCell, SyncStatusCell, SnapshotDisplayStatusCell };

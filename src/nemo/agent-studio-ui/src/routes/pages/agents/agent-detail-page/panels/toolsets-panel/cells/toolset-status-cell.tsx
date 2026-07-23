import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";

import type { ToolsetHealthStatus } from "../toolsets-panel.types";
import { getToolsetStatusVisual } from "../toolsets-panel.utils";

interface ToolsetStatusCellProps {
  status: ToolsetHealthStatus;
}

function ToolsetStatusCell({ status }: ToolsetStatusCellProps): ReactElement {
  const visual = getToolsetStatusVisual(status);
  return (
    <span className="agent-list-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {status}
      </Typography>
    </span>
  );
}

export { ToolsetStatusCell };
export type { ToolsetStatusCellProps };

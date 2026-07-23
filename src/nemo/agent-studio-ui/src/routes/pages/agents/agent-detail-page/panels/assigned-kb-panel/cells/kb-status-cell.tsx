import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";

import type { KnowledgeBaseStatus } from "../assigned-kb-panel.types";
import { getKbStatusVisual } from "../assigned-kb-panel.utils";

interface KbStatusCellProps {
  status: KnowledgeBaseStatus;
}

function KbStatusCell({ status }: KbStatusCellProps): ReactElement {
  const visual = getKbStatusVisual(status);
  return (
    <span className="agent-list-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {status}
      </Typography>
    </span>
  );
}

export { KbStatusCell };
export type { KbStatusCellProps };

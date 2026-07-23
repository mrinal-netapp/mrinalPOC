import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import { getAgentHealthVisual } from "@/routes/pages/agents/utils/agents.utils";
import type { AgentHealthStatus } from "@/routes/pages/agents/agents.types";

interface AgentHealthCellProps {
  status: AgentHealthStatus;
}

function AgentHealthCell({ status }: AgentHealthCellProps): ReactElement {
  const visual = getAgentHealthVisual(status);
  return (
    <span className="agent-list-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {status}
      </Typography>
    </span>
  );
}

export { AgentHealthCell };
export type { AgentHealthCellProps };

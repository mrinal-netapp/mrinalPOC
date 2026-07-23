import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import {
  formatDeploymentStatusLabel,
  getAgentDeploymentVisual,
} from "@/routes/pages/agents/utils/agents.utils";
import type { AgentDeploymentStatus } from "@/routes/pages/agents/agents.types";

interface AgentDeploymentCellProps {
  status: AgentDeploymentStatus;
}

function AgentDeploymentCell({ status }: AgentDeploymentCellProps): ReactElement {
  const visual = getAgentDeploymentVisual(status);
  return (
    <span className="agent-list-status-cell">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {formatDeploymentStatusLabel(status)}
      </Typography>
    </span>
  );
}

export { AgentDeploymentCell };
export type { AgentDeploymentCellProps };

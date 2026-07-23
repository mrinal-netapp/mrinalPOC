import type { ReactElement } from "react";
import { IconExternalLink } from "@tabler/icons-react";

import { Card } from "@/ui-lib/base-components/card/card";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { agentsPaths } from "@/routes/pages/agents/agents.consts";
import { getAppBasePath } from "@/consts/app-base-path";

import type { AgentSubEntity } from "./agent-form.consts";

interface AgentSubEntityCardProps {
  entity: AgentSubEntity;
}

function toAppHref(path: string): string {
  return `${getAppBasePath()}${path.startsWith("/") ? path : `/${path}`}`;
}

function AgentSubEntityCard({ entity }: AgentSubEntityCardProps): ReactElement {
  return (
    <Card className="agent-form__sub-entity-card">
      <div className="agent-form__resource-body">
        <Typography fontSize="fs14" className="agent-form__resource-row-label">
          Name
        </Typography>
        <span className="agent-form__sub-entity-name">
          <Typography fontSize="fs14" color="var(--primary-main, var(--link-primary, #0d6efd))">
            {entity.name}
          </Typography>
          <a
            href={toAppHref(agentsPaths.detail(entity.id))}
            target="_blank"
            rel="noreferrer"
            className="agent-form__resource-icon-link"
            aria-label={`Open agent "${entity.name}" in a new tab`}
          >
            <IconExternalLink size={14} aria-hidden="true" />
          </a>
        </span>

        <Typography fontSize="fs14" className="agent-form__resource-row-label">
          Status
        </Typography>
        <span className="agent-form__status">
          <span className={`agent-form__status-dot agent-form__status-dot--${entity.status}`} />
          <Typography fontSize="fs14">
            {entity.status === "healthy" ? "Healthy" : entity.status}
          </Typography>
        </span>

        <Typography fontSize="fs14" className="agent-form__resource-row-label">
          Deployment
        </Typography>
        <Typography fontSize="fs14">{entity.deployment}</Typography>

        <Typography fontSize="fs14" className="agent-form__resource-row-label">
          Labels
        </Typography>
        <Typography fontSize="fs14">{entity.labels.join(", ")}</Typography>
      </div>
    </Card>
  );
}

export { AgentSubEntityCard };
export type { AgentSubEntityCardProps };

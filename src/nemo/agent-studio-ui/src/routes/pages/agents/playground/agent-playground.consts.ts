import { ROUTES } from "@/routes/routes.consts";

const AGENT_PLAYGROUND_BASE = `/${ROUTES.AGENT_PLAYGROUND}`;

export const agentPlaygroundPaths = {
  workspace: (agentId: string) =>
    `${AGENT_PLAYGROUND_BASE}/${ROUTES.AGENT_PLAYGROUND_WORKSPACE}/${agentId}`,
} as const;

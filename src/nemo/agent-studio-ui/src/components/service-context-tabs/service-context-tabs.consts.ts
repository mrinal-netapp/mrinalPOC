import { createElement } from "react";
import { IconCategory, IconSparkles } from "@tabler/icons-react";

import { ROUTES } from "@/routes/routes.consts";
import { projectsPaths } from "@/routes/pages/projects/projects.consts";

export const SERVICE_CONTEXT_TAB_IDS = {
  AGENT_STUDIO: "agent-studio",
  MANAGEMENT: "management",
} as const;

export type ServiceContextTabId = (typeof SERVICE_CONTEXT_TAB_IDS)[keyof typeof SERVICE_CONTEXT_TAB_IDS];

export const SERVICE_CONTEXT_TABS = [
  {
    id: SERVICE_CONTEXT_TAB_IDS.AGENT_STUDIO,
    label: "Agent Studio",
    icon: createElement(IconSparkles, { size: 20 }),
  },
  {
    id: SERVICE_CONTEXT_TAB_IDS.MANAGEMENT,
    label: "Management",
    icon: createElement(IconCategory, { size: 20 }),
  },
] as const;

export const SERVICE_CONTEXT_TAB_PATHS: Record<ServiceContextTabId, string> = {
  [SERVICE_CONTEXT_TAB_IDS.AGENT_STUDIO]: `/${ROUTES.OVERVIEW}`,
  [SERVICE_CONTEXT_TAB_IDS.MANAGEMENT]: projectsPaths.root,
};

export const SERVICE_CONTEXT_TABS_ARIA_LABEL = "Service context";

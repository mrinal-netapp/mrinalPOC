import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconPlugConnectedX,
} from "@tabler/icons-react";

import type { ModelsStatusVisual } from "@/components/models/columns/cells/models-status-cell";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";

import type { ProviderHealth } from "./models-overview.types";

/** Top-level tab strip on the Models overview screen. */
const OVERVIEW_TABS: TabItem[] = [
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
];

/*
 * Shared visual map for the four Bifrost connection-health states. Used by the
 * Providers tab (provider health) and the Models tab (each model's health,
 * derived from its provider). Lives at module scope so cells receive a stable
 * visual reference and never recreate icon/color objects per render.
 */
const CONNECTION_STATUS_VISUALS: Record<ProviderHealth, ModelsStatusVisual> = {
  Healthy: {
    Icon: IconCircleCheck,
    color: "var(--notification-success)",
    label: "Healthy",
  },
  Degraded: {
    Icon: IconAlertTriangle,
    color: "var(--notification-warning)",
    label: "Degraded",
  },
  Error: {
    Icon: IconCircleX,
    color: "var(--notification-error)",
    label: "Error",
  },
  Disconnected: {
    Icon: IconPlugConnectedX,
    color: "var(--text-secondary)",
    label: "Disconnected",
  },
};

export { CONNECTION_STATUS_VISUALS, OVERVIEW_TABS };

import { useCallback, useMemo, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router";

import { TabGroup } from "@/ui-lib/base-components/tab/tab-group";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";
import {
  SERVICE_CONTEXT_TABS,
  SERVICE_CONTEXT_TABS_ARIA_LABEL,
  SERVICE_CONTEXT_TAB_PATHS,
  type ServiceContextTabId,
} from "./service-context-tabs.consts";
import { resolveActiveServiceTab } from "./service-context-tabs.utils";
import "./service-context-tabs.scss";

function ServiceContextTabs(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTabId = resolveActiveServiceTab(location.pathname);

  const tabs = useMemo<TabItem[]>(
    () => SERVICE_CONTEXT_TABS.map((tab) => ({
      id: tab.id,
      label: tab.label,
      icon: tab.icon,
    })),
    [],
  );

  const handleTabChange = useCallback((tabId: string) => {
    const nextTabId = tabId as ServiceContextTabId;
    if (nextTabId === activeTabId) {
      return;
    }

    navigate(SERVICE_CONTEXT_TAB_PATHS[nextTabId]);
  }, [activeTabId, navigate]);

  return (
    <div className="service-context-tabs" data-testid="service-context-tabs">
      <TabGroup
        tabs={tabs}
        activeTabId={activeTabId}
        variant="general"
        fitting="fit-content"
        orientation="vertical"
        onTabChange={handleTabChange}
        ariaLabel={SERVICE_CONTEXT_TABS_ARIA_LABEL}
      />
    </div>
  );
}

export { ServiceContextTabs };

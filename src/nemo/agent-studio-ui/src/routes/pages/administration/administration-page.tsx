import { useCallback, useMemo, useState, type ReactElement } from "react";

import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  ADMINISTRATION_STRINGS,
  ADMINISTRATION_TABS,
  type AdministrationTabId,
} from "./administration.consts";
import { AdministrationMembers } from "./administration-members";
import { AdministrationOverview } from "./administration-overview";
import { useAdministrationMemberCount } from "./hooks/use-administration-member-count";
import "./administration-page.scss";

function AdministrationPage(): ReactElement {
  const [activeTabId, setActiveTabId] = useState<AdministrationTabId>("overview");
  const activeProjectId = useAppSelector(projectContextSelector.activeProjectId);
  const fetchedMemberCount = useAdministrationMemberCount();
  const [membersTabCount, setMembersTabCount] = useState<{
    projectId: string;
    count: number;
  } | null>(null);

  const memberCount = useMemo(() => {
    if (membersTabCount?.projectId === activeProjectId) {
      return membersTabCount.count;
    }
    return fetchedMemberCount;
  }, [activeProjectId, fetchedMemberCount, membersTabCount]);

  const handleMemberCountChange = useCallback((count: number) => {
    if (!activeProjectId) {
      return;
    }
    setMembersTabCount({ projectId: activeProjectId, count });
  }, [activeProjectId]);

  const handleTabChange = useCallback((tabId: string) => {
    setActiveTabId(tabId as AdministrationTabId);
  }, []);

  const tabs: TabItem[] = useMemo(
    () => ADMINISTRATION_TABS.map((tab) => ({
      id: tab.id,
      label: tab.id === "members" && memberCount !== null
        ? `Members (${memberCount})`
        : tab.label,
    })),
    [memberCount],
  );

  return (
    <div className="administration-page">
      <header className="administration-page__header">
        <h1 className="administration-page__title">{ADMINISTRATION_STRINGS.PAGE_TITLE}</h1>
        <p className="administration-page__subtitle">{ADMINISTRATION_STRINGS.PAGE_SUBTITLE}</p>
      </header>

      <div className="administration-page__content">
        <TabGroup
          tabs={tabs}
          activeTabId={activeTabId}
          variant="general"
          onTabChange={handleTabChange}
          ariaLabel="Administration tabs"
        >
          <TabContent tabId="overview">
            <AdministrationOverview />
          </TabContent>

          <TabContent tabId="members">
            <AdministrationMembers onMemberCountChange={handleMemberCountChange} />
          </TabContent>
        </TabGroup>
      </div>
    </div>
  );
}

export { AdministrationPage };

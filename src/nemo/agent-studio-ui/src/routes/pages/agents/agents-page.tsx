import { useCallback, type ReactElement } from "react";
import { useAppSelector, useAppDispatch } from "@/store";

import { TabContent, TabGroup } from "@/ui-lib/base-components/tab/tab-group";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";

import { AGENTS_STRINGS, AGENTS_TABS } from "./agents.consts";
import { SingleAgentsList } from "./single-agents-list";
import { TeamAgentsList } from "./team-agents-list";
import {
  selectActiveTab,
  setActiveTab,
  type AgentsTabId,
} from "@/store";
import "./agents-page.scss";

const TABS: TabItem[] = AGENTS_TABS.map((t) => ({ id: t.id, label: t.label }));

function AgentsPage(): ReactElement {
  const dispatch = useAppDispatch();
  const activeTab = useAppSelector(selectActiveTab);

  const handleTabChange = useCallback((tabId: string) => {
    dispatch(setActiveTab(tabId as AgentsTabId));
  }, [dispatch]);

  return (
    <div className="agents-page">
      <header className="agents-page__header">
        <h1 className="agents-page__title">{AGENTS_STRINGS.PAGE_TITLE}</h1>
        <p className="agents-page__subtitle">{AGENTS_STRINGS.PAGE_SUBTITLE}</p>
      </header>

      <div className="agents-page__content">
        <TabGroup
          tabs={TABS}
          activeTabId={activeTab}
          variant="general"
          onTabChange={handleTabChange}
          ariaLabel={AGENTS_STRINGS.TABS_ARIA_LABEL}
        >
          <TabContent tabId="single">
            <SingleAgentsList />
          </TabContent>
          <TabContent tabId="team">
            <TeamAgentsList />
          </TabContent>
        </TabGroup>
      </div>
    </div>
  );
}

export { AgentsPage };

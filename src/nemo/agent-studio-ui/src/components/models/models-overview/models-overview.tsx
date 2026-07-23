import { useState, type ReactElement } from "react";

import { TabContent, TabGroup } from "@/ui-lib/base-components/tab/tab-group";

import { OVERVIEW_TABS } from "./models-overview.consts";
import { ModelsTablePanel } from "./models-table-panel";
import { ProvidersTablePanel } from "./providers-table-panel";

import "./models-overview.scss";

function ModelsOverview(): ReactElement {
  const [overviewTab, setOverviewTab] = useState("providers");

  return (
    <div className="models-overview">
      <header className="models-overview__intro">
        <h1 className="models-overview__title">Models</h1>
        <p className="models-overview__lede">
          Manage the LLMs and embedding models for your agents and knowledge bases.
        </p>
      </header>

      <section className="models-overview__main" aria-labelledby="models-overview-tabs-heading">
        <span id="models-overview-tabs-heading" className="models-overview__sr-only">
          Models overview sections
        </span>
        <TabGroup
          tabs={OVERVIEW_TABS}
          activeTabId={overviewTab}
          onTabChange={setOverviewTab}
          ariaLabel="Providers and models"
          className="models-overview__tabs"
        >
          <TabContent tabId="providers" className="models-overview__tab-panel">
            <ProvidersTablePanel />
          </TabContent>
          <TabContent tabId="models" className="models-overview__tab-panel">
            <ModelsTablePanel />
          </TabContent>
        </TabGroup>
      </section>
    </div>
  );
}

export { ModelsOverview };

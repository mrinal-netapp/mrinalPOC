import type { ReactElement } from "react";

import { DataSourceListContent } from "./list/data-source-list";
import { DATA_SOURCE_STRINGS } from "../data-management.consts";
import "../data-management-page.scss";

function DataSourcePage(): ReactElement {
  return (
    <div className="data-management-page">
      <header className="data-management-page__header">
        <h1 className="data-management-page__title">
          {DATA_SOURCE_STRINGS.PAGE_TITLE}
        </h1>
        <p className="data-management-page__subtitle">
          {DATA_SOURCE_STRINGS.PAGE_SUBTITLE}
        </p>
      </header>

      <div className="data-management-page__content">
        <DataSourceListContent />
      </div>
    </div>
  );
}

export { DataSourcePage };

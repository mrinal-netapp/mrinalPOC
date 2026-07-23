import type { ReactElement } from "react";

import { DataSourceListContent } from "./data-source-list";
import "../../data-management-page.scss";

function DataSourceListPage(): ReactElement {
  return (
    <div className="data-management-page">
      <header className="data-management-page__header">
        <h1 className="data-management-page__title">Data sources</h1>
        <p className="data-management-page__subtitle">
          Connect your storage systems to make your data available for datasets.
        </p>
      </header>
      <div className="data-management-page__content">
        <DataSourceListContent />
      </div>
    </div>
  );
}

export { DataSourceListPage };

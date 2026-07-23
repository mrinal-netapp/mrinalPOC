import type { ReactElement } from "react";

import { DatasetListContent } from "./dataset-list-content";
import "../../data-management-page.scss";

function DatasetListPage(): ReactElement {
  return (
    <div className="data-management-page">
      <header className="data-management-page__header">
        <h1 className="data-management-page__title">Datasets</h1>
        <p className="data-management-page__subtitle">
          Create datasets that organize the content for knowledge bases and agents.
        </p>
      </header>
      <div className="data-management-page__content">
        <DatasetListContent />
      </div>
    </div>
  );
}

export { DatasetListPage };

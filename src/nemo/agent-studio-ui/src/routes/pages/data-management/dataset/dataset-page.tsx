import type { ReactElement } from "react";

import { DatasetListContent } from "./list/dataset-list-content";
import { DATASET_STRINGS } from "../data-management.consts";
import "../data-management-page.scss";

function DatasetPage(): ReactElement {
  return (
    <div className="data-management-page">
      <header className="data-management-page__header">
        <h1 className="data-management-page__title">
          {DATASET_STRINGS.PAGE_TITLE}
        </h1>
        <p className="data-management-page__subtitle">
          {DATASET_STRINGS.PAGE_SUBTITLE}
        </p>
      </header>

      <div className="data-management-page__content">
        <DatasetListContent />
      </div>
    </div>
  );
}

export { DatasetPage };

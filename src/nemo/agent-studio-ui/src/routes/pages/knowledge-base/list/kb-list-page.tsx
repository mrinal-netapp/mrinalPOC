import type { ReactElement } from "react";

import { KB_STRINGS } from "../knowledge-base.consts";
import { KBListContent } from "./kb-list-content";
import "./kb-list-page.scss";


function KBListPage(): ReactElement {
  return (
    <div className="kb-list-page">
      <header className="kb-list-page__header">
        <h1 className="kb-list-page__title">{KB_STRINGS.PAGE_TITLE}</h1>
        <p className="kb-list-page__subtitle">{KB_STRINGS.PAGE_SUBTITLE}</p>
      </header>

      <div className="kb-list-page__content">
        <KBListContent />
      </div>
    </div>
  );
}

export { KBListPage };

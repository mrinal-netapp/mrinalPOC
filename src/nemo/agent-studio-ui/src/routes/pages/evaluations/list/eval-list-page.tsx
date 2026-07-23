import type { ReactElement } from "react";

import { EVAL_STRINGS } from "../evaluations.consts";
import { EvalListContent } from "./eval-list-content";
import "./eval-list-page.scss";

function EvalListPage(): ReactElement {
  return (
    <div className="eval-list-page">
      <header className="eval-list-page__header">
        <h1 className="eval-list-page__title">{EVAL_STRINGS.PAGE_TITLE}</h1>
        <p className="eval-list-page__subtitle">{EVAL_STRINGS.PAGE_SUBTITLE}</p>
      </header>

      <div className="eval-list-page__content">
        <EvalListContent />
      </div>
    </div>
  );
}

export { EvalListPage };

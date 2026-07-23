import type { ReactElement } from "react";

import { CredentialsList } from "./credentials-list";
import { CREDENTIALS_STRINGS } from "./credentials.consts";
import "../data-management/data-management-page.scss";

function CredentialsPage(): ReactElement {
  return (
    <div className="data-management-page">
      <header className="data-management-page__header">
        <h1 className="data-management-page__title">
          {CREDENTIALS_STRINGS.PAGE_TITLE}
        </h1>
        <p className="data-management-page__subtitle">
          {CREDENTIALS_STRINGS.PAGE_SUBTITLE}
        </p>
      </header>

      <div className="data-management-page__content">
        <CredentialsList />
      </div>
    </div>
  );
}

export { CredentialsPage };

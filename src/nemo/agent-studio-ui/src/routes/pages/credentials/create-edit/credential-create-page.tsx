import type { ReactElement } from "react";
import { useLocation } from "react-router";

import { CredentialForm } from "./credential-form";

function CredentialCreatePage(): ReactElement {
  const location = useLocation();

  return <CredentialForm key={location.pathname} />;
}

export { CredentialCreatePage };

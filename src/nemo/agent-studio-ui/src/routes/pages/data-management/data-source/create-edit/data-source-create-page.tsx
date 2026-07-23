import type { ReactElement } from "react";
import { useLocation } from "react-router";

import { DataSourceForm } from "./form/data-source-form";

function DataSourceCreatePage(): ReactElement {
  const location = useLocation();

  return <DataSourceForm key={location.pathname} />;
}

export { DataSourceCreatePage };

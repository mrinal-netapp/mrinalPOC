import type { ReactElement } from "react";
import { useLocation } from "react-router";

import { DatasetForm } from "./form/dataset-form";

function DatasetCreatePage(): ReactElement {
  const location = useLocation();

  return <DatasetForm key={location.pathname} />;
}

export { DatasetCreatePage };

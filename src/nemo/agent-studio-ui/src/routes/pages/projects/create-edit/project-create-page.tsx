import type { ReactElement } from "react";
import { useLocation } from "react-router";

import { ProjectCreateForm } from "./project-create-form";

function ProjectCreatePage(): ReactElement {
  const location = useLocation();

  return <ProjectCreateForm key={location.pathname} />;
}

export { ProjectCreatePage };

import { useContext } from "react";

import { ProjectContext } from "../model/context";
import type { ProjectContextValue } from "../model/project.types";

function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (ctx == null) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return ctx;
}

export { useProject };

import { createContext, type Context } from "react";

import type { ProjectContextValue } from "./project.types";

const ProjectContext: Context<ProjectContextValue | null> = createContext<ProjectContextValue | null>(null);

export { ProjectContext };

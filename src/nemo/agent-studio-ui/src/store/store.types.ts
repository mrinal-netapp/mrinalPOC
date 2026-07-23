import type { DataSourceListParams } from "@/api/data-source.types";
import type { DatasetListParams } from "@/api/dataset.types";
import type { KBListParams } from "@/api/kb.types";
import type { EvalListParams } from "@/routes/pages/evaluations/api/eval.types";
import type { ModelListParams } from "@/routes/pages/models/models.api.types";
import type { ToolsetState } from "@/components/toolset/model";
import type { ProjectMemberRole } from "@/api/project.types";

type Store = typeof import("./store").store;

export interface LayoutState {
  isSidebarOpen: boolean
}

export interface DataSourceState {
  selectedDsrcId: string | null;
  listFilters: DataSourceListParams;
}

export interface DatasetState {
  selectedDsetId: string | null;
  listFilters: DatasetListParams;
}

export interface KBState {
  selectedKbId: string | null;
  listFilters: KBListParams;
}

export interface ModelState {
  selectedModelId: string | null;
  listFilters: Partial<ModelListParams>;
}

/**
 * The currently selected project together with the caller's role on it.
 * Replaces the earlier flat `{activeProjectId, activeProjectName,
 * activeProjectRole}` shape — bundling them keeps the three fields in
 * sync as a unit (e.g. when switching projects you can't accidentally
 * forget to update one).
 *
 * "Nothing selected" is represented with `id === ""` (and `name === ""`,
 * `role === null`) so the flat-string selectors keep their existing
 * fallback semantics without forcing null checks at every read site.
 * Treat `role === null` as "deny" for any role-gated UI action.
 */
export interface ActiveProject {
  id: string;
  name: string;
  role: ProjectMemberRole | null;
}

export interface EvalState {
  selectedTemplateId: string | null;
  listFilters: Partial<EvalListParams>;
}

export interface ProjectContextState {
  activeProject: ActiveProject;
}

export type { ToolsetState };

export type RootState = ReturnType<Store["getState"]>;
export type AppDispatch = Store["dispatch"];

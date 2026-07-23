import type { ProjectMemberRole } from "@/api/project.types";
import type { ActiveProject, RootState } from "../store.types";

const projectContextSelector = {
  /** The whole active-project bundle; prefer this over the flat selectors when reading more than one field. */
  activeProject: (state: RootState): ActiveProject => state.projectContext.activeProject,
  activeProjectId: (state: RootState): string => state.projectContext.activeProject.id,
  activeProjectName: (state: RootState): string => state.projectContext.activeProject.name,
  activeProjectRole: (state: RootState): ProjectMemberRole | null =>
    state.projectContext.activeProject.role,
  /**
   * Synchronous admin check against the Redux-stored role. Use for
   * route guards / quick gating where awaiting an RTK Query result is
   * awkward. Returns `false` when the role hasn't loaded yet — fail-closed
   * matches the `useIsProjectAdmin` hook's behaviour.
   */
  isActiveProjectAdmin: (state: RootState): boolean =>
    state.projectContext.activeProject.role === "admin",
  displayName: (state: RootState): string =>
    state.projectContext.activeProject.name || state.projectContext.activeProject.id,
};

export { projectContextSelector };

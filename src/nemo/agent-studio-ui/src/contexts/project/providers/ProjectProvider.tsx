import { useCallback, useEffect, useMemo, type ReactElement, type ReactNode } from "react";

import { agentApi } from "@/api/agent-api.slice";
import { apiSlice } from "@/api/api.slice";
import { utilitiesApi } from "@/api/utilities-api.slice";
import { useAppDispatch, useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  setActiveProject,
  setActiveProjectName,
  setActiveProjectRole,
} from "@/store/slices/project-context.slice";
import { useAccessibleProjects } from "@/routes/pages/projects/hooks/use-accessible-projects";

import { ProjectContext } from "../model/context";
import { hasAnyRole, rolesEqual } from "../model/projectAccess";
import type { ActiveProjectValue, ProjectContextValue } from "../model/project.types";

type ProjectProviderProps = { children?: ReactNode };

/**
 * Composes the persisted Redux slice with the caller-scoped `/projects`
 * list so consumers can read the active project, switch projects, and
 * reset RTK Query caches through a single hook (`useProject`).
 *
 * Sibling to `AuthProvider` — must be mounted *after* it (depends on
 * `useAccessibleProjects`, which gates on `useAuth().user`).
 */
function ProjectProvider({ children }: ProjectProviderProps): ReactElement {
  const dispatch = useAppDispatch();
  const activeProjectId = useAppSelector(projectContextSelector.activeProjectId);
  const activeProjectName = useAppSelector(projectContextSelector.activeProjectName);
  const activeProjectRole = useAppSelector(projectContextSelector.activeProjectRole);
  const { projects, isLoading, isError } = useAccessibleProjects();

  // Reconcile the persisted (localStorage-rehydrated or Redux-cached)
  // active project against the authoritative project list:
  //
  //   0. No active project set (first login, cleared session, or a
  //      revoked-then-restored membership) but the caller has at least
  //      one accessible project → auto-default to `projects[0]` so the
  //      UI never lands the user in the "Unnamed project" limbo where
  //      every project-scoped route is gated off. Ordering trusts the
  //      list as returned by `/projects`.
  //   1. Active project is still accessible → backfill its name/role if
  //      either is stale (slice only persists the id on legacy migration).
  //   2. Active project is NOT in the list (deleted, or the caller lost
  //      access since the last session) → clear it so the UI doesn't
  //      keep pointing the user at a project they can't reach. Also
  //      reset RTK Query caches (same as switch/clear) so any in-flight
  //      queries bound to the dead projectId are dropped.
  //
  // We wait for the query to settle (`!isLoading`) before deciding the
  // active id is gone — clearing during the first render's loading
  // window would wipe valid state before the list has even arrived.
  // Errors are treated as "leave it alone" so a transient outage doesn't
  // log the user out of their project.
  useEffect(() => {
    if (isLoading || isError) return;

    if (!activeProjectId) {
      // Case 0: no default → pick the first accessible project. When
      // the list is empty we leave the state at "no active project" and
      // let the empty state / create-project flow surface in the UI.
      const first = projects[0];
      if (first) {
        dispatch(setActiveProject({
          id: first.id,
          name: first.name,
          role: first.membershipRole,
        }));
      }
      return;
    }

    const match = projects.find((project) => project.id === activeProjectId);

    if (!match) {
      // Project was deleted or the user's membership was revoked.
      // Reset to the "no active project" state — the sidebar's
      // `requireProject` gates will hide project-scoped nav, and the
      // switcher will fall back to its "Unnamed project" label. The
      // next tick of this effect will re-enter Case 0 and pick a new
      // default from whatever remains in the list.
      dispatch(setActiveProject({ id: "", name: "", role: null }));
      dispatch(apiSlice.util.resetApiState());
      dispatch(agentApi.util.resetApiState());
      dispatch(utilitiesApi.util.resetApiState());
      return;
    }

    if (!activeProjectName) {
      dispatch(setActiveProjectName(match.name));
    }
    if (match.membershipRole !== activeProjectRole) {
      dispatch(setActiveProjectRole(match.membershipRole));
    }
  }, [
    activeProjectId,
    activeProjectName,
    activeProjectRole,
    dispatch,
    isError,
    isLoading,
    projects,
  ]);

  const switchProject = useCallback(
    (projectId: string) => {
      if (!projectId || projectId === activeProjectId) return;
      const selected = projects.find((project) => project.id === projectId);
      dispatch(setActiveProject({
        id: projectId,
        name: selected?.name ?? "",
        role: selected?.membershipRole ?? null,
      }));
      // Project switch invalidates per-project queries across all APIs.
      dispatch(apiSlice.util.resetApiState());
      dispatch(agentApi.util.resetApiState());
      dispatch(utilitiesApi.util.resetApiState());
    },
    [activeProjectId, dispatch, projects],
  );

  const clearProject = useCallback(() => {
    dispatch(setActiveProject({ id: "", name: "", role: null }));
    dispatch(apiSlice.util.resetApiState());
    dispatch(agentApi.util.resetApiState());
    dispatch(utilitiesApi.util.resetApiState());
  }, [dispatch]);

  const value = useMemo<ProjectContextValue>(() => {
    const activeProject: ActiveProjectValue | null = activeProjectId && activeProjectRole
      ? { id: activeProjectId, name: activeProjectName, role: activeProjectRole }
      : null;
    const hasActiveProject = activeProject != null;

    return {
      activeProject,
      accessibleProjects: projects,
      hasActiveProject,
      isAdmin: rolesEqual(activeProject?.role ?? null, "admin"),
      isMember: rolesEqual(activeProject?.role ?? null, "member"),
      isViewer: rolesEqual(activeProject?.role ?? null, "viewer"),
      hasAnyRole: (requiredRoles: readonly string[]) =>
        hasAnyRole(activeProject?.role ?? null, requiredRoles),
      loading: isLoading,
      error: isError ? "Failed to load projects." : null,
      switchProject,
      clearProject,
    };
  }, [
    activeProjectId,
    activeProjectName,
    activeProjectRole,
    clearProject,
    isError,
    isLoading,
    projects,
    switchProject,
  ]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export { ProjectProvider };

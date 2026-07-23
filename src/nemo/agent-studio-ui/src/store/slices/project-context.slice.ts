import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import { PROJECT_MEMBER_ROLES, type ProjectMemberRole } from "@/api/project.types";
import type { ActiveProject, ProjectContextState } from "../store.types";

const SLICE_NAME = "projectContext";
const ACTIVE_PROJECT_STORAGE_KEY = "agent-studio.active-project";
// Legacy keys from the pre-`activeProject` layout. Read once at boot for
// a one-time migration so existing users don't lose their selection.
const LEGACY_PROJECT_ID_KEY = "agent-studio.active-project-id";
const LEGACY_PROJECT_ROLE_KEY = "agent-studio.active-project-role";

function emptyActiveProject(): ActiveProject {
  return { id: "", name: "", role: null };
}

function isKnownRole(value: unknown): value is ProjectMemberRole {
  return (
    typeof value === "string"
    && (PROJECT_MEMBER_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Read the persisted active project. Validates each field independently
 * so a tampered / partially-corrupt JSON blob can't smuggle invalid
 * values into Redux: id and name must be strings, role must be in the
 * known-roles allowlist (otherwise it falls back to `null` and any
 * role-gated UI fails closed). Also migrates from the older two-key
 * layout if the new key is absent.
 */
function readStoredActiveProject(): ActiveProject {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ActiveProject>;
      return {
        id: typeof parsed.id === "string" ? parsed.id : "",
        name: typeof parsed.name === "string" ? parsed.name : "",
        role: isKnownRole(parsed.role) ? parsed.role : null,
      };
    }
    // Legacy migration: fall through to the old keys.
    const legacyId = localStorage.getItem(LEGACY_PROJECT_ID_KEY) ?? "";
    const legacyRole = localStorage.getItem(LEGACY_PROJECT_ROLE_KEY);
    if (legacyId) {
      return {
        id: legacyId,
        name: "",
        role: isKnownRole(legacyRole) ? legacyRole : null,
      };
    }
  } catch {
    // Fall through to empty.
  }
  return emptyActiveProject();
}

function writeStoredActiveProject(activeProject: ActiveProject): void {
  try {
    if (activeProject.id) {
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, JSON.stringify(activeProject));
    } else {
      localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
    // Best-effort cleanup of the legacy keys once the new key is in use;
    // failures here are non-fatal (only matters for tidy devtools view).
    localStorage.removeItem(LEGACY_PROJECT_ID_KEY);
    localStorage.removeItem(LEGACY_PROJECT_ROLE_KEY);
  } catch {
    // Ignore storage failures in private browsing or restricted environments.
  }
}

const initialState: ProjectContextState = {
  activeProject: readStoredActiveProject(),
};

export const projectContextSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    /**
     * Replace the active project as a unit. Role is optional so legacy
     * callers that haven't been updated yet don't accidentally retain
     * a stale role across switches — absent / null both clear it.
     */
    setActiveProject(
      state,
      action: PayloadAction<{
        id: string;
        name: string;
        role?: ProjectMemberRole | null;
      }>,
    ) {
      state.activeProject = {
        id: action.payload.id,
        name: action.payload.name,
        role: action.payload.role ?? null,
      };
      writeStoredActiveProject(state.activeProject);
    },
    /**
     * Backfill the name after `/projects` resolves, when the slice was
     * hydrated from localStorage with id-only (or migrated from the
     * legacy keys, which never stored a name). Does NOT change id or
     * role.
     */
    setActiveProjectName(state, action: PayloadAction<string>) {
      state.activeProject.name = action.payload;
      writeStoredActiveProject(state.activeProject);
    },
    /**
     * Backfill the role after `/projects` resolves, when the persisted
     * role is missing or stale. Does NOT change id or name.
     */
    setActiveProjectRole(state, action: PayloadAction<ProjectMemberRole | null>) {
      state.activeProject.role = action.payload;
      writeStoredActiveProject(state.activeProject);
    },
  },
});

export const {
  setActiveProject,
  setActiveProjectName,
  setActiveProjectRole,
} = projectContextSlice.actions;

export default projectContextSlice;

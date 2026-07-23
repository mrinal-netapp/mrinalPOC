import type { ReactElement, ReactNode } from "react";

import type { ProjectMemberRole } from "@/api/project.types";
import type { AccessibleProject } from "@/routes/pages/projects/hooks/use-accessible-projects";

export type ActiveProjectValue = {
  id: string;
  name: string;
  role: ProjectMemberRole;
};

export type ProjectContextValue = {
  activeProject: ActiveProjectValue | null;
  accessibleProjects: AccessibleProject[];
  hasActiveProject: boolean;
  isAdmin: boolean;
  isMember: boolean;
  isViewer: boolean;
  /** True if the user's role matches ANY entry in `requiredRoles` (exact, case-insensitive). */
  hasAnyRole: (requiredRoles: readonly string[]) => boolean;
  loading: boolean;
  error: string | null;
  switchProject: (projectId: string) => void;
  clearProject: () => void;
};

export type ProjectGuardProps = {
  /** `true` => active project required; `false` => skip project/role checks. */
  requireProject?: boolean;
  /** OR semantics: any element satisfying the user's role allows access. */
  requiredRoles?: readonly string[];
  fallback?: ReactNode;
  loadingFallback?: ReactNode;
  children?: ReactNode;
};

export type ProjectDisableableHostProps = {
  disabled?: boolean;
  "aria-disabled"?: boolean | "true" | "false";
};

export type ProjectDisableableCompositeProps = ProjectDisableableHostProps & {
  isDisabled?: boolean;
};

export type ProjectDisableProps = {
  requireProject?: boolean;
  /** OR semantics: any element satisfying the user's role allows access. */
  requiredRoles?: readonly string[];
  children: ReactElement<ProjectDisableableCompositeProps>;
};

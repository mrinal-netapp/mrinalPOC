import { Children, cloneElement, isValidElement, type ReactElement } from "react";

import { isProjectAccessAllowed } from "../model/projectAccess";
import type {
  ProjectDisableProps,
  ProjectDisableableCompositeProps,
  ProjectDisableableHostProps,
} from "../model/project.types";
import { useProject } from "../hooks/useProject";

const HOST_TYPES_WITH_NATIVE_DISABLED = new Set([
  "button",
  "input",
  "textarea",
  "select",
  "fieldset",
]);

/**
 * Keeps a single child mounted but forces disabled state when project /
 * role checks fail. Native elements get `disabled` + `aria-disabled`;
 * design-system `Button` gets `isDisabled` so it wins over default props.
 *
 * Sibling to `AuthDisable`.
 */
function ProjectDisable({
  requireProject = true,
  requiredRoles,
  children,
}: ProjectDisableProps): ReactElement {
  const { hasActiveProject, activeProject } = useProject();

  if (!isValidElement(children)) {
    throw new Error(
      "ProjectDisable expects a single ReactElement child that supports `disabled` (host) or `isDisabled` (e.g. design-system Button).",
    );
  }

  const allowed = isProjectAccessAllowed({
    requireProject,
    hasActiveProject,
    requiredRoles,
    // Project-membership role only — mirrors ProjectGuard's contract.
    // ProjectDisable is project-scoped guidance for inline controls;
    // platform realm roles aren't relevant here.
    userRoles: [activeProject?.role],
  });

  const child = Children.only(children);
  const props = child.props as ProjectDisableableCompositeProps;
  const useNativeDisabled
    = typeof child.type === "string" && HOST_TYPES_WITH_NATIVE_DISABLED.has(child.type);
  const prevBlocked = useNativeDisabled
    ? Boolean(props.disabled)
    : Boolean(props.isDisabled ?? props.disabled);
  const nextBlocked = !allowed || prevBlocked;

  if (useNativeDisabled) {
    return cloneElement(child, {
      disabled: nextBlocked,
      "aria-disabled": nextBlocked,
    } satisfies Partial<ProjectDisableableHostProps>);
  }

  return cloneElement(child, {
    isDisabled: nextBlocked,
  } satisfies Partial<ProjectDisableableCompositeProps>);
}

export { ProjectDisable };

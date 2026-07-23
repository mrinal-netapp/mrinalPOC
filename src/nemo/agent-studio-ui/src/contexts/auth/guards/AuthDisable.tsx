import { Children, cloneElement, isValidElement, type ReactElement } from "react";

import { isAccessAllowed } from "../model/authAccess";
import type { AuthDisableProps, DisableableCompositeProps, DisableableHostProps } from "../model/auth.types";
import { useAuth } from "../hooks/useAuth";

const HOST_TYPES_WITH_NATIVE_DISABLED = new Set(["button", "input", "textarea", "select", "fieldset"]);

/**
 * Keeps a **single** child mounted but forces disabled state when auth or role checks fail.
 * Native elements get `disabled` / `aria-disabled`; design-system `Button` uses merged `isDisabled`
 * so `disabled` from clone does not fight `{...props}` spread order on `Button`.
 */
function AuthDisable({
  requireAuth = true,
  roles: requiredRoles,
  permissions: requiredPermissions,
  children,
}: AuthDisableProps): ReactElement {
  const { isAuthenticated, roles: userRoles, permissions: userPermissions } = useAuth();

  if (!isValidElement(children)) {
    throw new Error(
      "AuthDisable expects a single ReactElement child that supports `disabled` (host) or `isDisabled` (e.g. design-system Button).",
    );
  }

  const allowed = isAccessAllowed({
    requireAuth,
    isAuthenticated,
    requiredRoles,
    requiredPermissions,
    userRoles,
    userPermissions,
  });

  const child = Children.only(children);
  const props = child.props as DisableableCompositeProps;
  const useNativeDisabled = typeof child.type === "string" && HOST_TYPES_WITH_NATIVE_DISABLED.has(child.type);
  const prevBlocked = useNativeDisabled
    ? Boolean(props.disabled)
    : Boolean(props.isDisabled ?? props.disabled);
  const nextBlocked = !allowed || prevBlocked;

  if (useNativeDisabled) {
    return cloneElement(child, {
      disabled: nextBlocked,
      "aria-disabled": nextBlocked,
    } satisfies Partial<DisableableHostProps>);
  }

  return cloneElement(child, {
    isDisabled: nextBlocked,
  } satisfies Partial<DisableableCompositeProps>);
}

export { AuthDisable };

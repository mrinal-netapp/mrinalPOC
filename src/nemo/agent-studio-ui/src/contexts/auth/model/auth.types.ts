import type { ReactElement, ReactNode } from "react";

type AuthClaims<TClaims extends readonly string[] | string[]> = {
  roles: TClaims;
  permissions: TClaims;
};

export type AuthUser = {
  id: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
};

export type AuthSessionData = AuthClaims<string[]> & {
  token: string;
  user: AuthUser;
};

export type AuthContextValue = AuthClaims<readonly string[]> & {
  isAuthenticated: boolean;
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
};

export type AuthGuardProps = {
  /** `true` => authenticated users only, `false` => public (skip auth/role/permission checks). */
  requireAuth?: boolean;
  roles?: string[];
  permissions?: string[];
  fallback?: ReactNode;
  loadingFallback?: ReactNode;
  children?: ReactNode;
};

export type DisableableHostProps = {
  disabled?: boolean;
  "aria-disabled"?: boolean | "true" | "false";
};

export type DisableableCompositeProps = DisableableHostProps & {
  isDisabled?: boolean;
};

export type AuthDisableProps = {
  /** `true` => authenticated users only, `false` => public (skip auth/role/permission checks). */
  requireAuth?: boolean;
  roles?: string[];
  permissions?: string[];
  /** Single element: native controls use `disabled`; design-system `Button` uses `isDisabled`. */
  children: ReactElement<DisableableCompositeProps>;
};

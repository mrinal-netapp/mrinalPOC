import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuthGuard } from "./AuthGuard";
import { AuthContext } from "../model/context";
import type { AuthContextValue } from "../model/auth.types";

const BASE_CTX: AuthContextValue = {
  isAuthenticated: true,
  token: "t",
  user: null,
  roles: ["user"],
  permissions: ["data:read"],
  loading: false,
  error: null,
  logout: async () => {},
  checkAuth: async () => {},
  refreshToken: async () => null,
};

type RenderOptions = {
  ctx?: Partial<AuthContextValue>;
  guardProps?: {
    requireAuth?: boolean;
    roles?: string[];
    permissions?: string[];
    fallback?: ReactNode;
    loadingFallback?: ReactNode;
  };
};

function renderGuard({ ctx, guardProps }: RenderOptions = {}): void {
  render(
    <AuthContext.Provider value={{ ...BASE_CTX, ...ctx }}>
      <AuthGuard
        fallback={<div data-testid="fallback">Denied</div>}
        loadingFallback={<div data-testid="loading">Loading</div>}
        {...guardProps}
      >
        <div data-testid="content">Allowed</div>
      </AuthGuard>
    </AuthContext.Provider>,
  );
}

describe("AuthGuard", () => {
  it("renders loading fallback while auth state is loading", () => {
    renderGuard({ ctx: { loading: true } });
    expect(screen.getByTestId("loading")).toBeInTheDocument();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("renders fallback when auth is required and user is unauthenticated", () => {
    renderGuard({ ctx: { isAuthenticated: false }, guardProps: { requireAuth: true } });
    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("renders children when required role matches", () => {
    renderGuard({
      ctx: { roles: ["admin", "user"] },
      guardProps: { requireAuth: true, roles: ["admin"] },
    });
    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  it("renders children when role is missing but permission matches", () => {
    renderGuard({
      ctx: { roles: ["user"], permissions: ["admin:manage"] },
      guardProps: { requireAuth: true, roles: ["admin"], permissions: ["admin:manage"] },
    });
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("treats requireAuth=false as public and renders children for authenticated users", () => {
    renderGuard({ ctx: { isAuthenticated: true }, guardProps: { requireAuth: false } });
    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(screen.queryByTestId("fallback")).toBeNull();
  });
});

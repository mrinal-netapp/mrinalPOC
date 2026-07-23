import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { AuthContext } from "../model/context";
import type { AuthContextValue } from "../model/auth.types";
import { useAuth } from "./useAuth";

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

describe("useAuth", () => {
  it("throws when used outside AuthProvider", () => {
    expect(() => renderHook(() => useAuth())).toThrow("useAuth must be used within an AuthProvider");
  });

  it("returns context value when provider exists", () => {
    function Wrapper({ children }: { children: ReactNode }): ReactElement {
      return <AuthContext.Provider value={BASE_CTX}>{children}</AuthContext.Provider>;
    }

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.roles).toEqual(["user"]);
  });
});

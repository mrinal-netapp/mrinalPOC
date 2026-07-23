import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuthDisable } from "./AuthDisable";
import { AuthContext } from "../model/context";
import { Button } from "@/ui-lib/base-components/button/button";
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

function renderWithContext(
  ctx: Partial<AuthContextValue>,
  child: ReactElement,
) {
  return render(<AuthContext.Provider value={{ ...BASE_CTX, ...ctx }}>{child}</AuthContext.Provider>);
}

function CompositeToggle({
  isDisabled,
  "aria-disabled": ariaDisabled,
}: {
  isDisabled?: boolean;
  "aria-disabled"?: boolean | "true" | "false";
}): ReactElement {
  return (
    <div data-testid="composite-toggle" data-disabled={String(Boolean(isDisabled))} aria-disabled={ariaDisabled}>
      Composite
    </div>
  );
}

describe("AuthDisable", () => {
  it("disables when unauthenticated and requireAuth is true", () => {
    renderWithContext(
      { isAuthenticated: false },
      <AuthDisable requireAuth>
        <Button variant="solid" size="medium" label="Admin action" onClick={() => {}} />
      </AuthDisable>,
    );

    expect(screen.getByRole("button", { name: /admin action/i })).toBeDisabled();
  });

  it("disables the child when the user lacks a required role", () => {
    renderWithContext(
      { roles: ["user"] },
      <AuthDisable requireAuth roles={["admin"]}>
        <Button variant="solid" size="medium" label="Admin action" onClick={() => {}} />
      </AuthDisable>,
    );

    expect(screen.getByRole("button", { name: /admin action/i })).toBeDisabled();
  });

  it("does not disable the child when the user has a required role", () => {
    renderWithContext(
      { roles: ["admin", "user"] },
      <AuthDisable requireAuth roles={["admin"]}>
        <Button variant="solid" size="medium" label="Admin action" onClick={() => {}} />
      </AuthDisable>,
    );

    expect(screen.getByRole("button", { name: /admin action/i })).not.toBeDisabled();
  });

  it("disables when required permission is missing", () => {
    renderWithContext(
      { permissions: ["data:read"] },
      <AuthDisable requireAuth permissions={["admin:manage"]}>
        <Button variant="solid" size="medium" label="Admin action" onClick={() => {}} />
      </AuthDisable>,
    );

    expect(screen.getByRole("button", { name: /admin action/i })).toBeDisabled();
  });

  it("applies native disabled and aria-disabled for host button", () => {
    renderWithContext(
      { isAuthenticated: false },
      <AuthDisable requireAuth>
        <button type="button">Native action</button>
      </AuthDisable>,
    );

    const button = screen.getByRole("button", { name: /native action/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("preserves existing composite disabled state without clobbering it", () => {
    renderWithContext(
      { isAuthenticated: true, roles: ["admin"], permissions: ["admin:manage"] },
      <AuthDisable requireAuth roles={["admin"]} permissions={["admin:manage"]}>
        <CompositeToggle isDisabled />
      </AuthDisable>,
    );

    const composite = screen.getByTestId("composite-toggle");
    expect(composite).toHaveAttribute("data-disabled", "true");
  });

  it("throws when child is not a React element", () => {
    expect(() => {
      renderWithContext(
        {},
        // @ts-expect-error intentionally invalid child to exercise runtime guard
        <AuthDisable requireAuth>{"invalid-child"}</AuthDisable>,
      );
    }).toThrow("AuthDisable expects a single ReactElement child");
  });
});

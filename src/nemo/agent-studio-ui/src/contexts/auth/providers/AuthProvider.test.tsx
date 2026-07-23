import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuthProvider } from "./AuthProvider";
import { useAuth } from "../hooks/useAuth";

function ContextProbe(): ReactElement {
  const auth = useAuth();

  return (
    <div data-testid="auth-probe">
      {String(auth.isAuthenticated)}|{auth.token ?? "null"}|{String(auth.loading)}
    </div>
  );
}

describe("AuthProvider", () => {
  it("provides auth context to descendants", async () => {
    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );

    const probe = await screen.findByTestId("auth-probe");
    expect(probe.textContent).toContain("false");
  });
});

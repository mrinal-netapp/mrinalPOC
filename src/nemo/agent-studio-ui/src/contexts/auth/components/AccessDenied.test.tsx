import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AccessDenied } from "./AccessDenied";

describe("AccessDenied", () => {
  it("renders access denied copy", () => {
    render(<AccessDenied errorCode={null} />);

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText(/platform-member or platform-admin/i)).toBeInTheDocument();
    expect(screen.queryByText("AUTH_SESSION_CHECK_FAILED")).toBeNull();
  });

  it("renders optional error code", () => {
    render(<AccessDenied errorCode="AUTH_SESSION_CHECK_FAILED" />);

    expect(screen.getByText("AUTH_SESSION_CHECK_FAILED")).toBeInTheDocument();
  });
});

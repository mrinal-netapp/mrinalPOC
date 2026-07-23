import { describe, expect, it } from "vitest";

import { extractApiErrorMessage } from "./api-error.utils";

describe("extractApiErrorMessage", () => {
  it("returns an Error instance message when present", () => {
    expect(extractApiErrorMessage(new Error("  boom  "), "fb")).toBe("boom");
  });

  it("returns the fallback for non-object errors", () => {
    expect(extractApiErrorMessage(null, "fb")).toBe("fb");
    expect(extractApiErrorMessage("boom", "fb")).toBe("fb");
    expect(extractApiErrorMessage(undefined, "fb")).toBe("fb");
  });

  it("prefers data.message and trims it", () => {
    expect(extractApiErrorMessage({ data: { message: "  bad input  " } }, "fb")).toBe("bad input");
  });

  it("falls back to data.error when message is absent", () => {
    expect(extractApiErrorMessage({ data: { error: "nope" } }, "fb")).toBe("nope");
  });

  it("falls back to express-validator errors[0].msg when message and error are absent", () => {
    expect(
      extractApiErrorMessage(
        {
          data: {
            errors: [{ msg: "structuredOutput.json_schema is required" }],
          },
        },
        "fb",
      ),
    ).toBe("structuredOutput.json_schema is required");
  });

  it("ignores a blank data.message and uses the next signal", () => {
    expect(extractApiErrorMessage({ data: { message: "   " }, error: "from error" }, "fb")).toBe(
      "from error",
    );
  });

  it("uses a string error field", () => {
    expect(extractApiErrorMessage({ error: "  fetch failed " }, "fb")).toBe("fetch failed");
  });

  it("appends the status code when only a status is present", () => {
    expect(extractApiErrorMessage({ status: 503 }, "Request failed")).toBe(
      "Request failed (HTTP 503)",
    );
  });

  it("returns the fallback when nothing useful is present", () => {
    expect(extractApiErrorMessage({}, "fb")).toBe("fb");
    expect(extractApiErrorMessage({ data: 123 }, "fb")).toBe("fb");
  });
});

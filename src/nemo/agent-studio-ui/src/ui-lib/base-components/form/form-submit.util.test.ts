import { describe, expect, it } from "vitest";

import type { AnyReactFormApi } from "./form.types";
import { collectFirstFormValidationError, collectFormValidationErrors } from "./form-submit.util";

function mockForm(partial: {
  fieldMeta?: Record<string, { errors?: unknown[] }>;
  errorMap?: { onSubmit?: unknown };
}): AnyReactFormApi {
  return {
    state: {
      fieldMeta: partial.fieldMeta ?? {},
      errorMap: partial.errorMap ?? {},
    },
  } as unknown as AnyReactFormApi;
}

describe("collectFormValidationErrors", () => {
  it("returns field meta errors", () => {
    const form = mockForm({
      fieldMeta: {
        kind: { errors: ["Dataset kind is required."] },
      },
    });
    expect(collectFormValidationErrors(form)).toEqual(["Dataset kind is required."]);
  });

  it("flattens nested onSubmit error maps with fields", () => {
    const form = mockForm({
      errorMap: {
        onSubmit: {
          fields: {
            resource_selector: "Select at least one table or view in Data source scope.",
          },
        },
      },
    });
    expect(collectFirstFormValidationError(form)).toBe(
      "Select at least one table or view in Data source scope.",
    );
  });

  it("dedupes identical messages", () => {
    const form = mockForm({
      fieldMeta: {
        schema_query: { errors: ["Query must start with SELECT (or WITH)."] },
      },
      errorMap: {
        onSubmit: {
          fields: {
            schema_query: "Query must start with SELECT (or WITH).",
          },
        },
      },
    });
    expect(collectFormValidationErrors(form)).toEqual([
      "Query must start with SELECT (or WITH).",
    ]);
  });
});

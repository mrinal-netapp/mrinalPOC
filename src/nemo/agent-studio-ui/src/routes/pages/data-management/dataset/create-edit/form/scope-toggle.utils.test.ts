import { describe, expect, it, vi } from "vitest";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import type { DatasetFormValues } from "./dataset-form.consts";
import {
  clearFileScope,
  clearFolderScope,
  clearSchemaScope,
  isFileScopeActive,
  isFolderScopeActive,
  isSchemaScopeActive,
} from "./scope-toggle.utils";

type Spec = DatasetFormValues["spec"];

function makeForm(
  spec: Partial<Spec> = {},
  schema_query = "",
): { form: AnyReactFormApi; setFieldValue: ReturnType<typeof vi.fn> } {
  const setFieldValue = vi.fn();
  const form = {
    state: {
      values: {
        spec: {
          folder_scope: "all",
          paths: [],
          file_types: "",
          last_modified_filter: "all",
          max_file_size_bytes: "",
          size_unit: "MB",
          exclude_patterns: "",
          ...spec,
        },
        schema_query,
      },
    },
    setFieldValue,
  } as unknown as AnyReactFormApi;
  return { form, setFieldValue: setFieldValue as ReturnType<typeof vi.fn> };
}

describe("scope-toggle predicates", () => {
  it("isFolderScopeActive reflects custom scope", () => {
    expect(isFolderScopeActive(makeForm({ folder_scope: "custom" }).form)).toBe(true);
    expect(isFolderScopeActive(makeForm({ folder_scope: "all" }).form)).toBe(false);
  });

  it("isFileScopeActive is true when any file filter is set", () => {
    expect(isFileScopeActive(makeForm().form)).toBe(false);
    expect(isFileScopeActive(makeForm({ file_types: ".pdf" }).form)).toBe(true);
    expect(isFileScopeActive(makeForm({ last_modified_filter: "7d" }).form)).toBe(true);
    expect(isFileScopeActive(makeForm({ max_file_size_bytes: "10" }).form)).toBe(true);
    expect(isFileScopeActive(makeForm({ exclude_patterns: "*.tmp" }).form)).toBe(true);
  });

  it("isFileScopeActive treats missing spec fields as inactive", () => {
    const setFieldValue = vi.fn();
    const form = {
      state: {
        values: {
          spec: {
            folder_scope: "all",
            paths: [],
          },
          schema_query: "",
        },
      },
      setFieldValue,
    } as unknown as AnyReactFormApi;

    expect(isFileScopeActive(form)).toBe(false);
  });

  it("isSchemaScopeActive reflects a non-empty query", () => {
    expect(isSchemaScopeActive(makeForm({}, "  ").form)).toBe(false);
    expect(isSchemaScopeActive(makeForm({}, "SELECT 1").form)).toBe(true);
  });
});

describe("scope-toggle clearers", () => {
  it("clearFolderScope resets folder scope to all", () => {
    const { form, setFieldValue } = makeForm();
    clearFolderScope(form);
    expect(setFieldValue).toHaveBeenCalledWith("spec.folder_scope", "all");
    expect(setFieldValue).toHaveBeenCalledWith("spec.paths", ["/"]);
  });

  it("clearFileScope clears every file filter", () => {
    const { form, setFieldValue } = makeForm();
    clearFileScope(form);
    expect(setFieldValue).toHaveBeenCalledWith("spec.file_types", "");
    expect(setFieldValue).toHaveBeenCalledWith("spec.last_modified_filter", "all");
    expect(setFieldValue).toHaveBeenCalledWith("spec.max_file_size_bytes", "");
    expect(setFieldValue).toHaveBeenCalledWith("spec.exclude_patterns", "");
  });

  it("clearSchemaScope clears the query", () => {
    const { form, setFieldValue } = makeForm();
    clearSchemaScope(form);
    expect(setFieldValue).toHaveBeenCalledWith("schema_query", "");
  });
});

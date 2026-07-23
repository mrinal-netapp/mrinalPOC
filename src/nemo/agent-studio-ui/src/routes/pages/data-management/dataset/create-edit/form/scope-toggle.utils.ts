import { useEffect } from "react";
import { useStore } from "@tanstack/react-store";

import type { DataSourceCategory, DataSourceProtocol } from "@/api/data-source.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import type { DatasetFormValues } from "./dataset-form.consts";
import { getScopeAvailability, isFileScopeAvailableForKind, isFolderScopeAvailableForSource } from "./dataset-form.consts";

/**
 * Helpers backing the "Apply folder/file/schema scope" toggles.
 *
 * The toggles are local component state, but they must genuinely control what is
 * submitted: turning a scope OFF clears its underlying form fields so it is not
 * sent (and, in edit mode, is removed from the dataset). The `is*Active`
 * predicates seed the toggles from the current form values so an existing scope
 * renders expanded instead of hidden.
 */

function specValues(form: AnyReactFormApi): DatasetFormValues["spec"] {
  return (form.state.values as DatasetFormValues).spec;
}

/** Folder scope is "active" when a custom selection (not "all") is in effect. */
export function isFolderScopeActive(form: AnyReactFormApi): boolean {
  return specValues(form).folder_scope === "custom";
}

/** File scope is "active" when any file filter is set. */
export function isFileScopeActive(form: AnyReactFormApi): boolean {
  const sp = specValues(form);
  return (
    String(sp.file_types ?? "").trim() !== "" ||
    (sp.last_modified_filter ?? "all") !== "all" ||
    String(sp.max_file_size_bytes ?? "") !== "" ||
    String(sp.exclude_patterns ?? "") !== ""
  );
}

/** Schema scope is "active" when a non-empty SQL query is present. */
export function isSchemaScopeActive(form: AnyReactFormApi): boolean {
  return Boolean((form.state.values as DatasetFormValues).schema_query?.trim());
}

/** Resets folder scope to the "use all folders" default. */
export function clearFolderScope(form: AnyReactFormApi): void {
  form.setFieldValue("spec.folder_scope", "all");
  form.setFieldValue("spec.paths", ["/"]);
}

/** Clears every file filter so file scope is omitted from the payload. */
export function clearFileScope(form: AnyReactFormApi): void {
  form.setFieldValue("spec.file_types", "");
  form.setFieldValue("spec.last_modified_filter", "all");
  form.setFieldValue("spec.max_file_size_bytes", "");
  form.setFieldValue("spec.exclude_patterns", "");
}

/** Clears the schema-scope SQL query. */
export function clearSchemaScope(form: AnyReactFormApi): void {
  form.setFieldValue("schema_query", "");
}

/**
 * Keeps the "Apply schema scope" toggle in sync when schema_query is populated
 * externally (e.g. after picking a database table in Data source scope).
 */
export function useSyncSchemaScopeToggle(
  form: AnyReactFormApi,
  setApplySchemaScope: (checked: boolean) => void,
): void {
  const schemaQuery = useStore(form.store, (s) => (s.values as DatasetFormValues).schema_query ?? "");
  useEffect(() => {
    if (schemaQuery.trim()) {
      setApplySchemaScope(true);
    }
  }, [schemaQuery, setApplySchemaScope]);
}

/**
 * Clears file-scope filters and turns the toggle off when the dataset kind or
 * data source category no longer supports file scope (e.g. structured kind).
 */
export function useClearFileScopeWhenUnavailable(
  form: AnyReactFormApi,
  kind: DatasetFormValues["kind"],
  category: DataSourceCategory | null | undefined,
  setApplyFileScope: (checked: boolean) => void,
): void {
  useEffect(() => {
    const scope = getScopeAvailability(category);
    if (!isFileScopeAvailableForKind(kind, scope)) {
      clearFileScope(form);
      setApplyFileScope(false);
    }
  }, [kind, category, form, setApplyFileScope]);
}

/**
 * Clears folder-scope filters and turns the toggle off once the selected data
 * source is known and isn't NFS. Guarded on `sourceType != null` so this never
 * fires before the data source detail has loaded (which would otherwise wipe
 * out a valid existing folder scope while `useGetDataSourceQuery` is pending).
 */
export function useClearFolderScopeWhenUnavailable(
  form: AnyReactFormApi,
  sourceType: DataSourceProtocol | null | undefined,
  category: DataSourceCategory | null | undefined,
  setApplyFolderScope: (checked: boolean) => void,
): void {
  useEffect(() => {
    if (sourceType == null) return;
    const scope = getScopeAvailability(category);
    if (!isFolderScopeAvailableForSource(scope, sourceType)) {
      clearFolderScope(form);
      setApplyFolderScope(false);
    }
  }, [sourceType, category, form, setApplyFolderScope]);
}

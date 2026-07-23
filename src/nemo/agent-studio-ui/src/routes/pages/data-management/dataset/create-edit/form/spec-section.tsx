import { useState, useCallback, useMemo, type ReactElement } from "react";
import { SQLMonacoEditor } from "@/components/sql-monaco-editor/sql-monaco-editor";
import { IconPlus, IconArrowsLeftRight, IconInfoCircle, IconAlertCircle } from "@tabler/icons-react";
import { useStore } from "@tanstack/react-store";
import type { AnyFieldApi } from "@tanstack/react-form";
import { ScopeToggleRow } from "./scope-toggle-row";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form";
import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { Button } from "@/ui-lib/base-components/button/button";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import { VolumeBrowserDialog } from "@/components/data-source/volume-browser/VolumeBrowserDialog";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { FOLDER_SCOPE_OPTIONS, LAST_MODIFIED_OPTIONS, SIZE_UNIT_OPTIONS, getScopeAvailability, isFileScopeAvailableForKind, isFolderScopeAvailableForSource, FILE_SCOPE_UNSUPPORTED_KIND_MESSAGE, FOLDER_SCOPE_UNSUPPORTED_SOURCE_MESSAGE } from "./dataset-form.consts";
import { useSelectedDataSource } from "./dataset-form.hooks";
import {
  isFolderScopeActive,
  isFileScopeActive,
  isSchemaScopeActive,
  clearFolderScope,
  clearFileScope,
  clearSchemaScope,
  useSyncSchemaScopeToggle,
  useClearFileScopeWhenUnavailable,
  useClearFolderScopeWhenUnavailable,
} from "./scope-toggle.utils";
import { pickSingleFolderPath } from "./database-scope.utils";
import { schemaQueryFieldValidators } from "./dataset-form.validation";
import { createPathColumns, PATHS_TABLE_OPTIONS, type PathRow } from "@/components/dataset/columns/spec-section.folder-paths.columns";
import type { FolderScope } from "@/api/dataset.types";
import { ScopeSummary } from "./scope-summary";

interface SpecSectionProps {
  form: AnyReactFormApi;
}

// -- Folder paths table --

function FolderPathsFieldError({ form }: { form: AnyReactFormApi }): ReactElement | null {
  const message = useStore(form.store, (s) => {
    const m = s.fieldMeta["spec.paths"];
    if (!m?.errors?.length) {
      return undefined;
    }
    return String(m.errors[0]);
  });
  if (message == null) {
    return null;
  }
  return <FormFieldErrorBlock message={message} className="dset-form__message-below" />;
}

function FolderPathsTable({ form }: { form: AnyReactFormApi }): ReactElement {
  const rawPaths: string[] | undefined = useStore(form.store, (s) => s.values.spec.paths);
  const paths = useMemo(() => rawPaths ?? [], [rawPaths]);
  const datasourceId: string = useStore(form.store, (s) => s.values.data_source_id);
  const datasourceName: string = useStore(form.store, (s) => s.values.data_source_name ?? datasourceId);
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const [addFoldersOpen, setAddFoldersOpen] = useState(false);

  const tableData: PathRow[] = useMemo(
    () => paths.map((p, idx) => ({ id: String(idx), path: p })),
    [paths],
  );

  const handleRemove = useCallback((row: PathRow) => {
    form.setFieldValue("spec.paths", paths.filter((_, i) => i !== Number(row.id)));
  }, [form, paths]);

  const handleAddFolders = useCallback((selectedPaths: string[]) => {
    const path = pickSingleFolderPath(selectedPaths);
    if (!path) {
      return;
    }
    form.setFieldValue("spec.folder_scope", "custom");
    form.setFieldValue("spec.paths", [path]);
  }, [form]);

  const columns = useMemo(() => createPathColumns(handleRemove), [handleRemove]);

  return (
    <div className="dset-form__custom-paths">
      <div className="dset-form__section-header">
        <Typography Component="h3" fontSize="fs16" boldness="semibold">Custom folder selection</Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          Select custom folder scope and apply filters
        </Typography>
      </div>

      <div className="dset-form__folder-paths-table">
        <BaseTable<PathRow>
          options={PATHS_TABLE_OPTIONS}
          data={tableData}
          columns={columns}
        />
      </div>

      <FolderPathsFieldError form={form} />

      <Button
        variant="outline"
        size="medium"
        label="Add Custom Folders"
        icon={<IconPlus size={16} />}
        isDisabled={!datasourceId}
        onClick={() => setAddFoldersOpen(true)}
      />

      <VolumeBrowserDialog
        open={addFoldersOpen}
        onOpenChange={(o) => { if (!o) setAddFoldersOpen(false); }}
        volumeId={datasourceId}
        volumeName={datasourceName}
        projectId={projectId}
        title="Add Custom Folders"
        onAdd={handleAddFolders}
      />
    </div>
  );
}

// -- Schema scope section --

function SchemaScopeSection({ form, sqlRequired = false }: { form: AnyReactFormApi; sqlRequired?: boolean }): ReactElement {
  return (
    <div className="dset-form__schema-scope">
      <div className="dset-form__section-header">
        <Typography Component="h3" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Schema scope
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Define the structure of your data by writing a query with the required schema constraints.
        </Typography>
      </div>

      <div className="dset-form__schema-query-card">
        <div className="dset-form__schema-query-title">
          <IconArrowsLeftRight size={16} />
          <Typography Component="span" fontSize="fs14" boldness="semibold">
            SQL query
          </Typography>
        </div>

        {/* Validated field: behaves like an input (inline errors on blur/submit).
            No preview/run during creation — the query executes after the dataset
            is created and its table exists. */}
        <form.Field name="schema_query" validators={schemaQueryFieldValidators}>
          {(field: AnyFieldApi) => {
            const value = (field.state.value as string) ?? "";
            const rawError = field.state.meta.errors?.[0];
            const errorMsg = rawError ? String(rawError) : undefined;
            // Validators run on blur + submit only, so an error message is only
            // present once it should be shown — no extra "touched" gate needed.
            const hasError = Boolean(errorMsg);
            return (
              <>
                <div className="dset-form__schema-query-actions">
                  <Button
                    variant="outline"
                    size="medium"
                    label="Clear"
                    onClick={() => field.handleChange("")}
                    isDisabled={!value.trim()}
                  />
                </div>

                <div className="dset-form__schema-query-editor-wrapper">
                  <div className="dset-form__schema-query-label-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Query{sqlRequired ? " *" : ""}
                  </Typography>
                    <IconInfoCircle size={14} color="var(--text-secondary)" />
                  </div>
                  <SQLMonacoEditor
                    value={value}
                    onChange={(val) => field.handleChange(val)}
                    onBlur={field.handleBlur}
                    hasError={hasError}
                    height="120px"
                  />
                </div>

                <Typography
                  Component="p"
                  fontSize="fs13"
                  boldness="regular"
                  className="dset-form__schema-query-hint"
                  color="var(--text-secondary)"
                >
                  Selecting a table from the scope replaces the editor contents with a default{" "}
                  <code>SELECT *</code>. Edit freely afterward. If the scope and query refer to
                  different tables, acquisition uses the SQL query.
                </Typography>

                {hasError ? (
                  <div className="dset-form__schema-query-error">
                    <IconAlertCircle size={14} color="var(--notification-error)" />
                    <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--notification-error)">
                      {errorMsg}
                    </Typography>
                  </div>
                ) : value.trim() ? (
                  <div className="dset-form__schema-query-info">
                    <IconInfoCircle size={14} color="var(--text-secondary)" />
                    <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                      This query runs when the dataset is created. Track its progress on the dataset page.
                    </Typography>
                  </div>
                ) : null}
              </>
            );
          }}
        </form.Field>
      </div>
    </div>
  );
}

// -- Main section --

function SpecSection({ form }: SpecSectionProps): ReactElement {
  const folderScope: FolderScope = useStore(form.store, (s) => s.values.spec.folder_scope);
  const sizeUnit: string = useStore(form.store, (s) => s.values.spec.size_unit ?? "MB");
  const kind = useStore(form.store, (s) => s.values.kind);
  const { category, ds } = useSelectedDataSource(form);
  const scope = getScopeAvailability(category);
  const sqlRequired = kind === "structured" && scope.schema;

  // Seed each toggle from the form so a pre-populated scope (e.g. values carried
  // over before submit) renders expanded. Toggling a scope OFF clears its form
  // fields so it is genuinely removed from the payload — the toggle is no longer
  // cosmetic-only.
  const [applyFolderScope, setApplyFolderScope] = useState(() => isFolderScopeActive(form));
  const [applyFileScope, setApplyFileScope] = useState(() => isFileScopeActive(form));
  const [applySchemaScope, setApplySchemaScope] = useState(() => isSchemaScopeActive(form));
  useSyncSchemaScopeToggle(form, setApplySchemaScope);
  useClearFileScopeWhenUnavailable(form, kind, category, setApplyFileScope);
  useClearFolderScopeWhenUnavailable(form, ds?.source_type, category, setApplyFolderScope);

  const handleToggleFolder = useCallback((checked: boolean) => {
    setApplyFolderScope(checked);
    if (!checked) clearFolderScope(form);
  }, [form]);

  const handleToggleFile = useCallback((checked: boolean) => {
    setApplyFileScope(checked);
    if (!checked) clearFileScope(form);
  }, [form]);

  const handleToggleSchema = useCallback((checked: boolean) => {
    setApplySchemaScope(checked);
    if (!checked) clearSchemaScope(form);
  }, [form]);

  // Effective on-state respects availability so a scope disabled by the data
  // source category, protocol, or dataset kind never renders its (now
  // inapplicable) content.
  const fileScopeAvailable = isFileScopeAvailableForKind(kind, scope);
  const folderScopeAvailable = isFolderScopeAvailableForSource(scope, ds?.source_type);
  const folderOn = folderScopeAvailable && applyFolderScope;
  const fileOn = fileScopeAvailable && applyFileScope;
  const schemaOn = scope.schema && applySchemaScope;

  return (
    <section className="dset-form__section">
      {/* Scope toggles */}
      <div className="dset-form__scope-toggles">
        {/* Folder scope toggle */}
        <ScopeToggleRow
          checked={folderOn}
          onCheckedChange={handleToggleFolder}
          disabled={!folderScopeAvailable}
          disabledTooltip={!folderScopeAvailable && scope.folder ? FOLDER_SCOPE_UNSUPPORTED_SOURCE_MESSAGE : undefined}
          label="Apply folder scope"
          ariaLabel="Apply folder scope"
        />

        {/* Folder scope content */}
        {folderOn && (
          <div className="dset-form__scope-toggle-content">
            <div className="dset-form__section-header">
              <Typography Component="h3" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
                Folder scope
              </Typography>
              <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
                Folder scope lets you define your dataset by choosing specific folders.
              </Typography>
            </div>

            <RadioGroup
              value={folderScope}
              onValueChange={(val) => form.setFieldValue("spec.folder_scope", String(val))}
              ariaLabel="Folder scope"
            >
              <div className="dset-form__input-type-radios">
                {FOLDER_SCOPE_OPTIONS.map((opt) => (
                  <SelectorWrapper
                    key={opt.value}
                    selectorType="radioButton"
                    selectorProps={{ value: opt.value }}
                    label={opt.label}
                  />
                ))}
              </div>
            </RadioGroup>

            {folderScope === "custom" && <FolderPathsTable form={form} />}
          </div>
        )}

        {/* File scope toggle */}
        <ScopeToggleRow
          checked={fileOn}
          onCheckedChange={handleToggleFile}
          disabled={!fileScopeAvailable}
          disabledTooltip={!fileScopeAvailable && scope.file ? FILE_SCOPE_UNSUPPORTED_KIND_MESSAGE : undefined}
          label="Apply file scope"
          ariaLabel="Apply file scope"
        />

        {/* File scope content */}
        {fileOn && (
          <div className="dset-form__scope-toggle-content">
            <div className="dset-form__section-header">
              <Typography Component="h3" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
                File scope
              </Typography>
              <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
                Create a file scope to define which files are included in your dataset.
              </Typography>
            </div>

            <div className="dset-form__fields">
              <div className="dset-form__field">
                <InputField
                  form={form}
                  name="spec.file_types"
                  label="Types"
                  placeholder="e.g. *.csv, *.parquet (comma-separated; leave empty for all files)"
                />
              </div>

              <div className="dset-form__field">
                <SelectDropdownField
                  form={form}
                  name="spec.last_modified_filter"
                  label="Last modified"
                  items={LAST_MODIFIED_OPTIONS.map((o) => ({ key: o.value, value: o.value, label: o.label }))}
                  placeholder="Any time"
                  size="fill"
                />
              </div>

              <div className="dset-form__field">
                <InputField
                  form={form}
                  name="spec.max_file_size_bytes"
                  label={`Size limit, ${sizeUnit}`}
                  placeholder=""
                  type="number"
                />
                <div className="dset-form__size-unit-hidden">
                  <SelectDropdownField
                    form={form}
                    name="spec.size_unit"
                    label=""
                    items={SIZE_UNIT_OPTIONS}
                    size="fill"
                  />
                </div>
              </div>

              <div className="dset-form__field">
                <InputField
                  form={form}
                  name="spec.exclude_patterns"
                  label="Exclude patterns"
                  isOptional
                  placeholder="temp/*, *.tmp, *.bak"
                  tooltip="Comma-separated glob patterns to exclude files"
                />
              </div>
            </div>
          </div>
        )}
        {/* Schema scope toggle */}
        <ScopeToggleRow
          checked={schemaOn}
          onCheckedChange={handleToggleSchema}
          disabled={!scope.schema}
          label="Apply schema scope"
          ariaLabel="Apply schema scope"
        />

        {/* Schema scope content */}
        {schemaOn && (
          <div className="dset-form__scope-toggle-content">
            <SchemaScopeSection form={form} sqlRequired={sqlRequired} />
          </div>
        )}
      </div>

      <ScopeSummary form={form} />
    </section>
  );
}

export { SpecSection, FolderPathsTable };
export type { SpecSectionProps };

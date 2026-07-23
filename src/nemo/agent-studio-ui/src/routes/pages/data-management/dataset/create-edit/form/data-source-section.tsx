import { useState, useCallback, useMemo, type ReactElement } from "react";
import { SQLMonacoEditor } from "@/components/sql-monaco-editor/sql-monaco-editor";
import { IconFile, IconDatabase, IconInfoCircle, IconArrowsLeftRight, IconPlus, IconEye, IconAlertCircle, IconDots } from "@tabler/icons-react";
import { useStore } from "@tanstack/react-store";

import type { DatasetDetail, DatasetKind, DatasetInputType, DatasetManifestFile, ResourceSelectorEntry } from "@/api/dataset.types";
import type { FolderScope } from "@/api/dataset.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { useGetDataSourceQuery } from "@/api/data-source-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { ScopeToggleRow } from "./scope-toggle-row";
import { Button } from "@/ui-lib/base-components/button/button";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { StatusCell } from "@/components/data-source/columns/cells/status-cell";
import { VolumeBrowserDialog } from "@/components/data-source/volume-browser/VolumeBrowserDialog";
import { ConnectorBrowserDialog } from "@/components/data-source/connector-browser/connector-browser-dialog";
import { SOURCE_TYPE_LABELS } from "../../../data-source/create-edit/form/data-source-form.consts";
import { DataSourcePicker } from "./data-source-picker";
import { UploadDropzone } from "./upload-dropzone";
import { FolderPathsTable } from "./spec-section";
import { ScopeSummary } from "./scope-summary";
import {
  INPUT_TYPE_OPTIONS,
  DATASET_KIND_OPTIONS,
  FOLDER_SCOPE_OPTIONS,
  LAST_MODIFIED_OPTIONS,
  SIZE_UNIT_OPTIONS,
  getScopeAvailability,
  isDataSourceCompatibleWithDatasetKind,
  isFileScopeAvailableForKind,
  isFolderScopeAvailableForSource,
  FILE_SCOPE_UNSUPPORTED_KIND_MESSAGE,
  FOLDER_SCOPE_UNSUPPORTED_SOURCE_MESSAGE,
} from "./dataset-form.consts";
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
import { validateSqlQuery } from "./dataset-form.validation";
import { useSelectedDataSource } from "./dataset-form.hooks";
import {
  mergeResourceSelectorEntriesForCategory,
  pickSingleFolderPath,
  populateSchemaQueryFromDatabaseTables,
  resourceEntryKey,
} from "./database-scope.utils";

// -- Types --

interface DataSourceSectionProps {
  form: AnyReactFormApi;
  isEdit: boolean;
  inputType: DatasetInputType;
  onInputTypeChange: (type: DatasetInputType) => void;
  initialData?: DatasetDetail;
  /** Manual-upload progress/errors keyed by each file's upload-relative path. */
  uploadProgress?: Record<string, number>;
  uploadErrors?: Record<string, string>;
  /** Existing manual-upload files (edit mode) shown alongside new uploads. */
  existingFiles?: DatasetManifestFile[];
  /** IDs of existing files the user has marked for removal. */
  removedExistingIds?: Set<string>;
  /** Toggles removal of an existing file by id. */
  onToggleRemoveExisting?: (id: string) => void;
}

// -- Readonly cards (edit mode — both input types) --

function DataSourceInfoCard({ initialData }: { initialData: DatasetDetail }): ReactElement {
  const dsrcId = initialData.data_source?.dsrc_id;
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: ds, isLoading } = useGetDataSourceQuery(
    { projectId, dsrcId: dsrcId ?? "" },
    { skip: !projectId || !dsrcId },
  );

  const rows: { label: string; value: ReactElement | string }[] = [
    {
      label: "Kind",
      value: (initialData.kind === "structured" ? "Structured" : "Unstructured"),
    },
    {
      label: "Name",
      value: ds?.name ?? initialData.data_source?.name ?? "—",
    },
    {
      label: "Connection status",
      value: ds
        ? <StatusCell status={ds.status} deprecated={ds.deprecated} />
        : "—",
    },
    {
      label: "Type",
      // Prefer the accurate 5-value category (e.g. "Volume", "Database");
      // fall back to the protocol label only when the category is unavailable.
      value: ds
        ? (ds.category ?? (ds.source_type ? SOURCE_TYPE_LABELS[ds.source_type] ?? ds.source_type : "—"))
        : "—",
    },
    {
      label: "Credential",
      value: String((ds?.connection as unknown as Record<string, unknown>)?.credential ?? "—"),
    },
    {
      label: "Project ID",
      value: projectId || "—",
    },
    {
      label: "Region",
      value: ds?.connection?.region ?? "—",
    },
    {
      label: "Labels",
      value: (ds?.labels ?? []).join(", ") || "—",
    },
  ];

  return (
    <Card className="dset-form__source-card">
      <CardHeader icon={<IconDatabase size={20} />} title="Data source" hasSeparator />
      <CardContent>
        <CardBlock type="key-value">
          {isLoading ? (
            <Spinner size="fitContent" />
          ) : (
            <div className="dset-form__access-info">
              {rows.map((row) => (
                <div key={row.label} className="dset-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    {row.label}
                  </Typography>
                  {typeof row.value === "string" ? (
                    <Typography Component="span" fontSize="fs14" boldness="regular">
                      {row.value}
                    </Typography>
                  ) : (
                    row.value
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBlock>
      </CardContent>
    </Card>
  );
}

function DataSourceReadonlyCard({ initialData }: { initialData: DatasetDetail }): ReactElement {
  if (initialData.input_type === "upload") {
    return (
      <Card className="dset-form__source-card">
        <CardHeader icon={<IconFile size={20} />} title="Uploaded files" />
        <CardContent>
          <CardBlock type="key-value">
            <div className="dset-form__access-info">
              <div className="dset-form__access-info-row">
                <Typography Component="span" fontSize="fs14" boldness="regular">Files</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular">{initialData.files_count}</Typography>
              </div>
            </div>
          </CardBlock>
        </CardContent>
      </Card>
    );
  }

  return <DataSourceInfoCard initialData={initialData} />;
}

// -- Dataset kind (structured / unstructured) --

interface DatasetKindSelectorProps {
  form: AnyReactFormApi;
  isEdit: boolean;
}

function DatasetKindFieldError({ form }: { form: AnyReactFormApi }): ReactElement | null {
  const message = useStore(form.store, (s) => {
    const m = s.fieldMeta.kind;
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

function ResourceSelectorFieldError({ form }: { form: AnyReactFormApi }): ReactElement | null {
  const message = useStore(form.store, (s) => {
    const m = s.fieldMeta.resource_selector;
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

function DatasetKindSelector({ form, isEdit }: DatasetKindSelectorProps): ReactElement {
  const kind: DatasetKind | "" = useStore(form.store, (s) => s.values.kind ?? "");

  if (isEdit) {
    return (
      <div className="dset-form__kind-readonly">
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          Dataset kind
        </Typography>
        <Typography Component="span" fontSize="fs14" boldness="semibold">
          {kind === "structured" ? "Structured" : "Unstructured"}
        </Typography>
      </div>
    );
  }

  return (
    <div className="dset-form__kind-section">
      <div className="dset-form__section-header">
        <Typography Component="h3" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Dataset kind
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Choose whether this dataset holds unstructured files or structured tabular data.
        </Typography>
      </div>

      <RadioGroup
        value={kind}
        onValueChange={(val) => {
          const nextKind = String(val) as DatasetKind;
          form.setFieldValue("kind", nextKind);
          const currentCategory = form.getFieldValue("data_source_category");
          if (!isDataSourceCompatibleWithDatasetKind(currentCategory, nextKind)) {
            form.setFieldValue("data_source_id", "");
            form.setFieldValue("data_source_category", null);
            form.setFieldValue("resource_selector", []);
            form.setFieldValue("schema_query", "");
          }
        }}
        ariaLabel="Dataset kind"
      >
        <div className="dset-form__input-type-radios">
          {DATASET_KIND_OPTIONS.map((opt) => (
            <SelectorWrapper
              key={opt.value}
              selectorType="radioButton"
              selectorProps={{ value: opt.value }}
              label={opt.title}
              description={opt.description}
            />
          ))}
        </div>
      </RadioGroup>
      <DatasetKindFieldError form={form} />
    </div>
  );
}

// -- Data source scope section (edit mode) --

interface ScopeEntry {
  id: string;
  path: string;
}

/**
 * Human-readable label for a connector resource-selector entry, covering the
 * common provider shapes (object store, database, metrics). Falls back to a
 * generic join so unknown shapes still render something meaningful.
 */
function labelResourceEntry(entry: ResourceSelectorEntry): string {
  const e = entry as Record<string, unknown>;
  if (typeof e.bucket === "string" && e.bucket) {
    const prefix = typeof e.prefix === "string" ? e.prefix.replace(/\/$/, "") : "";
    return prefix ? `${e.bucket}/${prefix}` : e.bucket;
  }
  if (typeof e.table === "string" && e.table) {
    return [e.database, e.schema, e.table].filter((v) => typeof v === "string" && v).join(".");
  }
  if (typeof e.category === "string" && e.category) {
    return `Metrics: ${e.category}`;
  }
  const joined = Object.values(e).filter((v) => typeof v === "string" && v).join(" / ");
  return joined || JSON.stringify(entry);
}

function ScopeEntryActionsMenu({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="icon"
            icon={<IconDots size={18} />}
            aria-label={`Actions for ${label}`}
          />
        }
      />
      <DropdownMenuContent side="bottom" align="end">
        <DropdownMenuItem onClick={onRemove}>
          <Typography Component="span" fontSize="fs14" boldness="regular">
            Remove
          </Typography>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DataSourceScopeSection({ initialData, form }: { initialData: DatasetDetail; form: AnyReactFormApi }): ReactElement {
  const existingPaths: string[] = initialData.spec?.paths ?? [];
  const [entries, setEntries] = useState<ScopeEntry[]>(
    existingPaths.map((p, i) => ({ id: String(i), path: p })),
  );

  const folderScope: FolderScope = useStore(form.store, (s) => s.values.spec.folder_scope);
  const sizeUnit: string = useStore(form.store, (s) => s.values.spec.size_unit ?? "MB");
  const kind: DatasetKind | "" = useStore(form.store, (s) => s.values.kind ?? "");

  // Seed each toggle from the saved dataset so an existing scope renders
  // expanded. Turning a scope OFF clears its form fields so it is genuinely
  // removed on save (the toggle is no longer cosmetic-only).
  const [applyFolderScope, setApplyFolderScope] = useState(() => isFolderScopeActive(form));
  const [applyFileScope, setApplyFileScope] = useState(() => isFileScopeActive(form));
  const [applySchemaScope, setApplySchemaScope] = useState(() => isSchemaScopeActive(form));
  useSyncSchemaScopeToggle(form, setApplySchemaScope);

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

  const sqlQuery: string = useStore(form.store, (s) => s.values.schema_query ?? "");
  // Inline format validation, mirroring the create form. `sqlTouched` defers the
  // error until the field blurs so it doesn't flash while the user is typing.
  const [sqlTouched, setSqlTouched] = useState(false);
  const sqlFormatError = useMemo(() => validateSqlQuery(sqlQuery), [sqlQuery]);
  const showSqlFormatError = sqlTouched && Boolean(sqlFormatError);

  // Catalog coordinates are still used to render the query placeholder.
  const catalogNamespace = initialData.catalog_namespace;
  const catalogTableName = initialData.catalog_table_name;

  // Volume browser — only applicable for Volume-category data sources, which
  // expose a browsable filesystem. Connector-based sources browse via Explorer.
  const browseProjectId = useAppSelector(projectContextSelector.activeProjectId);
  const {
    category,
    dataSourceId: volumeId,
    ds: dsForBrowse,
    isConnectorSource,
    isVolumeSource,
  } = useSelectedDataSource(form);
  useClearFileScopeWhenUnavailable(form, kind, category, setApplyFileScope);
  useClearFolderScopeWhenUnavailable(form, dsForBrowse?.source_type, category, setApplyFolderScope);
  const volumeName = dsForBrowse?.name ?? initialData.data_source?.name ?? volumeId ?? "Volume";
  const connectorProvider = dsForBrowse?.provider ?? null;
  const connectorScope = dsForBrowse?.connector_scope ?? null;
  const configuredDatabase = typeof dsForBrowse?.connector_config?.database === "string"
    ? dsForBrowse.connector_config.database
    : null;
  const resourceSelector: ResourceSelectorEntry[] = useStore(
    form.store,
    (s) => s.values.resource_selector ?? [],
  );

  const handleAddResources = useCallback((added: ResourceSelectorEntry[]) => {
    const current: ResourceSelectorEntry[] = form.getFieldValue("resource_selector") ?? [];
    form.setFieldValue("resource_selector", mergeResourceSelectorEntriesForCategory(current, added, connectorProvider, connectorScope));
    populateSchemaQueryFromDatabaseTables(form, added, connectorProvider);
  }, [form, connectorProvider, connectorScope]);

  const handleRemoveResource = useCallback((key: string) => {
    const current: ResourceSelectorEntry[] = form.getFieldValue("resource_selector") ?? [];
    form.setFieldValue("resource_selector", current.filter((e) => resourceEntryKey(e) !== key));
  }, [form]);

  // Gate scope options by category (Volume/Object Store → folder+file, etc.)
  // and, for folder scope specifically, by protocol (NFS only).
  const scope = getScopeAvailability(category);
  const fileScopeAvailable = isFileScopeAvailableForKind(kind, scope);
  const folderScopeAvailable = isFolderScopeAvailableForSource(scope, dsForBrowse?.source_type);
  const folderOn = folderScopeAvailable && applyFolderScope;
  const fileOn = fileScopeAvailable && applyFileScope;
  const schemaOn = scope.schema && applySchemaScope;
  const [browserPath, setBrowserPath] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [addFoldersOpen, setAddFoldersOpen] = useState(false);
  const [viewResource, setViewResource] = useState<ResourceSelectorEntry | null>(null);
  const [viewResourceOpen, setViewResourceOpen] = useState(false);

  const handleViewPath = useCallback((path: string) => {
    setBrowserPath(path);
    setBrowserOpen(true);
  }, []);

  const handleViewResource = useCallback((entry: ResourceSelectorEntry) => {
    setViewResource(entry);
    setViewResourceOpen(true);
  }, []);

  // Replace the scope entry with the latest folder pick and keep spec.paths in sync.
  const handleAddFolders = useCallback((selectedPaths: string[]) => {
    const path = pickSingleFolderPath(selectedPaths);
    if (!path) {
      return;
    }
    const next = [{ id: `${Date.now()}`, path }];
    setEntries(next);
    form.setFieldValue("spec.folder_scope", "custom");
    form.setFieldValue("spec.paths", [path]);
  }, [form]);

  const handleRemoveEntry = useCallback((id: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      form.setFieldValue("spec.paths", next.map((e) => e.path).filter(Boolean));
      return next;
    });
  }, [form]);

  const handleClearQuery = useCallback(() => {
    form.setFieldValue("schema_query", "");
    setSqlTouched(false);
  }, [form]);

  return (
    <div className="dset-form__ds-scope">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Data source scope
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Select the cloud resources for this data source. Only one type of service allowed for storage systems.
        </Typography>
      </div>

      {/* Scope entries table */}
      <div className="dset-form__ds-scope-table">
        <div className="dset-form__ds-scope-table-header">
          <Typography Component="span" fontSize="fs14" boldness="semibold">Scope</Typography>
        </div>
        {isConnectorSource
          ? resourceSelector.map((entry) => {
              const key = resourceEntryKey(entry);
              return (
                <div key={key} className="dset-form__ds-scope-table-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular" className="dset-form__ds-scope-row-path">
                    {labelResourceEntry(entry)}
                  </Typography>
                  <div className="dset-form__ds-scope-row-actions">
                    <button
                      type="button"
                      className="dset-form__ds-scope-row-view"
                      onClick={() => handleViewResource(entry)}
                      aria-label={`View contents of ${labelResourceEntry(entry)}`}
                      title="View contents"
                    >
                      <IconEye size={14} />
                      View
                    </button>
                    <ScopeEntryActionsMenu
                      label={labelResourceEntry(entry)}
                      onRemove={() => handleRemoveResource(key)}
                    />
                  </div>
                </div>
              );
            })
          : entries.map((entry) => (
              <div key={entry.id} className="dset-form__ds-scope-table-row">
                <Typography Component="span" fontSize="fs14" boldness="regular" className="dset-form__ds-scope-row-path">
                  {entry.path || "—"}
                </Typography>
                <div className="dset-form__ds-scope-row-actions">
                  {isVolumeSource && volumeId && (
                    <button
                      type="button"
                      className="dset-form__ds-scope-row-view"
                      onClick={() => handleViewPath(entry.path)}
                      aria-label={`View contents of ${entry.path || "root"}`}
                      title="View contents"
                    >
                      <IconEye size={14} />
                      View
                    </button>
                  )}
                  <ScopeEntryActionsMenu
                    label={entry.path || "scope entry"}
                    onRemove={() => handleRemoveEntry(entry.id)}
                  />
                </div>
              </div>
            ))}
      </div>

      <Button
        variant="outline"
        size="medium"
        label="Add"
        icon={<IconPlus size={16} />}
        isDisabled={!((isVolumeSource && volumeId) || isConnectorSource)}
        onClick={() => setAddFoldersOpen(true)}
      />

      <ResourceSelectorFieldError form={form} />

      {/* Scope toggles */}
      <div className="dset-form__scope-toggles">
        {/* Folder scope — available for NFS data sources only */}
        {/* Folder scope toggle */}
        <ScopeToggleRow
          checked={folderOn}
          onCheckedChange={handleToggleFolder}
          disabled={!folderScopeAvailable}
          disabledTooltip={!folderScopeAvailable && scope.folder ? FOLDER_SCOPE_UNSUPPORTED_SOURCE_MESSAGE : undefined}
          label="Apply folder scope"
          ariaLabel="Apply folder scope"
        />

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

        {/* Schema scope */}
        <ScopeToggleRow
          checked={schemaOn}
          onCheckedChange={handleToggleSchema}
          disabled={!scope.schema}
          label="Apply schema scope"
          ariaLabel="Apply schema scope"
        />

        {schemaOn && (
          <div className="dset-form__scope-toggle-content">
            <div className="dset-form__schema-scope">
              <div className="dset-form__section-header">
                <Typography Component="h3" fontSize="fs14" boldness="semibold">Schema scope</Typography>
                <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
                  Define the structure of your data by writing a query with the required schema constraints.
                </Typography>
              </div>

              <div className="dset-form__schema-query-card">
                <div className="dset-form__schema-query-title">
                  <IconArrowsLeftRight size={16} />
                  <Typography Component="span" fontSize="fs14" boldness="semibold">SQL query</Typography>
                </div>

                <div className="dset-form__schema-query-actions">
                  <Button variant="outline" size="medium" label="Clear" onClick={handleClearQuery} />
                </div>

                <div className="dset-form__schema-query-editor-wrapper">
                  <div className="dset-form__schema-query-label-row">
                    <Typography Component="span" fontSize="fs14" boldness="regular">Query</Typography>
                    <IconInfoCircle size={14} color="var(--text-secondary)" />
                  </div>
                  <SQLMonacoEditor
                    value={sqlQuery}
                    onChange={(val) => form.setFieldValue("schema_query", val)}
                    onBlur={() => setSqlTouched(true)}
                    hasError={showSqlFormatError}
                    height="120px"
                    tables={
                      catalogTableName
                        ? [{ name: `iceberg."${catalogNamespace ?? ""}"."${catalogTableName}"`, columns: [] }]
                        : undefined
                    }
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

                {showSqlFormatError && (
                  <div className="dset-form__schema-query-error">
                    <IconAlertCircle size={14} color="var(--notification-error)" />
                    <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--notification-error)">
                      {sqlFormatError}
                    </Typography>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ScopeSummary form={form} />

      {isVolumeSource && volumeId && (
        <VolumeBrowserDialog
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          projectId={browseProjectId}
          volumeId={volumeId}
          volumeName={volumeName}
          initialPath={browserPath}
        />
      )}

      {isVolumeSource && volumeId && (
        <VolumeBrowserDialog
          open={addFoldersOpen}
          onOpenChange={(o) => { if (!o) setAddFoldersOpen(false); }}
          projectId={browseProjectId}
          volumeId={volumeId}
          volumeName={volumeName}
          title="Add Datasource scope"
          onAdd={handleAddFolders}
        />
      )}

      {isConnectorSource && volumeId && (
        <ConnectorBrowserDialog
          open={addFoldersOpen}
          onClose={() => setAddFoldersOpen(false)}
          projectId={browseProjectId}
          connectorId={volumeId}
          provider={connectorProvider}
          connectorScope={connectorScope}
          configuredDatabase={configuredDatabase}
          title="Add Datasource scope"
          onAdd={handleAddResources}
        />
      )}

      {isConnectorSource && volumeId && (
        <ConnectorBrowserDialog
          open={viewResourceOpen}
          onClose={() => setViewResourceOpen(false)}
          projectId={browseProjectId}
          connectorId={volumeId}
          provider={connectorProvider}
          connectorScope={connectorScope}
          configuredDatabase={configuredDatabase}
          title="View contents"
          readOnly
          initialResource={viewResource}
          initialResourceLabel={viewResource ? labelResourceEntry(viewResource) : undefined}
        />
      )}
    </div>
  );
}

// -- Data source scope entries table (create mode) --

// Mirrors the edit-mode scope entries table, but reads/writes the form's
// spec.paths directly since there is no saved dataset to seed from yet. Shown
// once a data source has been picked.
function CreateScopeEntriesTable({ form }: { form: AnyReactFormApi }): ReactElement {
  const rawPaths: string[] | undefined = useStore(form.store, (s) => s.values.spec.paths);
  const paths = useMemo(() => rawPaths ?? [], [rawPaths]);
  const datasourceId: string = useStore(form.store, (s) => s.values.data_source_id);
  const datasourceName: string = useStore(form.store, (s) => s.values.data_source_name ?? datasourceId);
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const {
    ds,
    isConnectorSource,
    isVolumeSource,
  } = useSelectedDataSource(form);
  const connectorProvider = ds?.provider ?? null;
  const connectorScope = ds?.connector_scope ?? null;
  const configuredDatabase = typeof ds?.connector_config?.database === "string"
    ? ds.connector_config.database
    : null;
  const resourceSelector: ResourceSelectorEntry[] = useStore(
    form.store,
    (s) => s.values.resource_selector ?? [],
  );

  const [browserPath, setBrowserPath] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [addFoldersOpen, setAddFoldersOpen] = useState(false);
  const [viewResource, setViewResource] = useState<ResourceSelectorEntry | null>(null);
  const [viewResourceOpen, setViewResourceOpen] = useState(false);

  const handleViewPath = useCallback((path: string) => {
    setBrowserPath(path);
    setBrowserOpen(true);
  }, []);

  const handleViewResource = useCallback((entry: ResourceSelectorEntry) => {
    setViewResource(entry);
    setViewResourceOpen(true);
  }, []);

  const handleRemovePath = useCallback((path: string) => {
    const current: string[] = form.getFieldValue("spec.paths") ?? [];
    form.setFieldValue("spec.paths", current.filter((p) => p !== path));
  }, [form]);

  const handleAddFolders = useCallback((selectedPaths: string[]) => {
    const path = pickSingleFolderPath(selectedPaths);
    if (!path) {
      return;
    }
    form.setFieldValue("spec.folder_scope", "custom");
    form.setFieldValue("spec.paths", [path]);
  }, [form]);

  const handleAddResources = useCallback((added: ResourceSelectorEntry[]) => {
    const current: ResourceSelectorEntry[] = form.getFieldValue("resource_selector") ?? [];
    form.setFieldValue("resource_selector", mergeResourceSelectorEntriesForCategory(current, added, connectorProvider, connectorScope));
    populateSchemaQueryFromDatabaseTables(form, added, connectorProvider);
  }, [form, connectorProvider, connectorScope]);

  const handleRemoveResource = useCallback((key: string) => {
    const current: ResourceSelectorEntry[] = form.getFieldValue("resource_selector") ?? [];
    form.setFieldValue("resource_selector", current.filter((e) => resourceEntryKey(e) !== key));
  }, [form]);

  return (
    <div className="dset-form__ds-scope">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Data source scope
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Select the cloud resources for this data source. Only one type of service allowed for storage systems.
        </Typography>
      </div>

      <div className="dset-form__ds-scope-table">
        <div className="dset-form__ds-scope-table-header">
          <Typography Component="span" fontSize="fs14" boldness="semibold">Scope</Typography>
        </div>
        {isConnectorSource
          ? resourceSelector.map((entry) => {
              const key = resourceEntryKey(entry);
              return (
                <div key={key} className="dset-form__ds-scope-table-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular" className="dset-form__ds-scope-row-path">
                    {labelResourceEntry(entry)}
                  </Typography>
                  <div className="dset-form__ds-scope-row-actions">
                    <button
                      type="button"
                      className="dset-form__ds-scope-row-view"
                      onClick={() => handleViewResource(entry)}
                      aria-label={`View contents of ${labelResourceEntry(entry)}`}
                      title="View contents"
                    >
                      <IconEye size={14} />
                      View
                    </button>
                    <ScopeEntryActionsMenu
                      label={labelResourceEntry(entry)}
                      onRemove={() => handleRemoveResource(key)}
                    />
                  </div>
                </div>
              );
            })
          : paths.map((path, idx) => (
              <div key={`${path}-${idx}`} className="dset-form__ds-scope-table-row">
                <Typography Component="span" fontSize="fs14" boldness="regular" className="dset-form__ds-scope-row-path">
                  {path || "—"}
                </Typography>
                <div className="dset-form__ds-scope-row-actions">
                  {isVolumeSource && (
                    <button
                      type="button"
                      className="dset-form__ds-scope-row-view"
                      onClick={() => handleViewPath(path)}
                      aria-label={`View contents of ${path || "root"}`}
                      title="View contents"
                    >
                      <IconEye size={14} />
                      View
                    </button>
                  )}
                  <ScopeEntryActionsMenu
                    label={path || "scope entry"}
                    onRemove={() => handleRemovePath(path)}
                  />
                </div>
              </div>
            ))}
      </div>

      <Button
        variant="outline"
        size="medium"
        label="Add"
        icon={<IconPlus size={16} />}
        isDisabled={!(isVolumeSource || isConnectorSource)}
        onClick={() => setAddFoldersOpen(true)}
      />

      <ResourceSelectorFieldError form={form} />

      {isVolumeSource && (
        <>
          <VolumeBrowserDialog
            open={browserOpen}
            onOpenChange={setBrowserOpen}
            projectId={projectId}
            volumeId={datasourceId}
            volumeName={datasourceName}
            initialPath={browserPath}
          />
          <VolumeBrowserDialog
            open={addFoldersOpen}
            onOpenChange={(o) => { if (!o) setAddFoldersOpen(false); }}
            projectId={projectId}
            volumeId={datasourceId}
            volumeName={datasourceName}
            title="Add Datasource scope"
            onAdd={handleAddFolders}
          />
        </>
      )}

      {isConnectorSource && (
        <ConnectorBrowserDialog
          open={addFoldersOpen}
          onClose={() => setAddFoldersOpen(false)}
          projectId={projectId}
          connectorId={datasourceId}
          provider={connectorProvider}
          connectorScope={connectorScope}
          configuredDatabase={configuredDatabase}
          title="Add Datasource scope"
          onAdd={handleAddResources}
        />
      )}

      {isConnectorSource && (
        <ConnectorBrowserDialog
          open={viewResourceOpen}
          onClose={() => setViewResourceOpen(false)}
          projectId={projectId}
          connectorId={datasourceId}
          provider={connectorProvider}
          connectorScope={connectorScope}
          configuredDatabase={configuredDatabase}
          title="View contents"
          readOnly
          initialResource={viewResource}
          initialResourceLabel={viewResource ? labelResourceEntry(viewResource) : undefined}
        />
      )}
    </div>
  );
}

// -- Main section --

function DataSourceSection({ form, isEdit, inputType, onInputTypeChange, initialData, uploadProgress, uploadErrors, existingFiles, removedExistingIds, onToggleRemoveExisting }: DataSourceSectionProps): ReactElement {
  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Data source configuration
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          {isEdit
            ? inputType === "upload"
              ? "Review uploaded file selection to be included in the dataset."
              : "Review selected data source to be included in the dataset."
            : "Select an existing data source or upload files from your local computer."}
        </Typography>
      </div>

      {isEdit && initialData && inputType !== "upload" ? (
        <>
          <DataSourceReadonlyCard initialData={initialData} />
          <DataSourceScopeSection initialData={initialData} form={form} />
        </>
      ) : isEdit && inputType === "upload" ? (
        <>
          <DatasetKindSelector form={form} isEdit />
          <UploadDropzone
            form={form}
            uploadProgress={uploadProgress}
            uploadErrors={uploadErrors}
            existingFiles={existingFiles}
            removedExistingIds={removedExistingIds}
            onToggleRemoveExisting={onToggleRemoveExisting}
          />
        </>
      ) : (
        <>
          <RadioGroup
            value={inputType}
            onValueChange={(val) => onInputTypeChange(String(val) as DatasetInputType)}
            ariaLabel="Input type"
          >
            <div className="dset-form__input-type-radios">
              {INPUT_TYPE_OPTIONS.map((opt) => (
                <SelectorWrapper
                  key={opt.value}
                  selectorType="radioButton"
                  selectorProps={{ value: opt.value }}
                  label={opt.title}
                  description={opt.description}
                  isDisabled={opt.isDisabled}
                />
              ))}
            </div>
          </RadioGroup>

          <DatasetKindSelector form={form} isEdit={false} />

          {inputType === "data-source" && (
            <>
              <DataSourcePicker form={form} />
              <CreateScopeEntriesTable form={form} />
            </>
          )}
          {inputType === "upload" && (
            <UploadDropzone form={form} uploadProgress={uploadProgress} uploadErrors={uploadErrors} />
          )}
        </>
      )}
    </section>
  );
}

export { DataSourceSection };
export type { DataSourceSectionProps };

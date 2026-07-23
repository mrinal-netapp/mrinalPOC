import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";

import type { DatasetKind } from "@/api/dataset.types";
import { useListDataSourcesQuery } from "@/api/data-source-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import {
  createDatasetFormDataSourcePickerColumns,
  type DataSourceTableRow,
} from "@/components/dataset/columns/dataset-form-data-source-picker.columns";
import { VolumeBrowserDialog } from "@/components/data-source/volume-browser/VolumeBrowserDialog";
import { isDataSourceCompatibleWithDatasetKind } from "./dataset-form.consts";
import { dataSourceIdFieldValidators } from "./dataset-form.validation";

function DataSourceIdFieldError({ form }: { form: AnyReactFormApi }): ReactElement | null {
  const message = useStore(form.store, (s) => {
    const m = s.fieldMeta["data_source_id"];
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

const PICKER_TABLE_OPTIONS: BaseTableOptions = {
  enableRowSelection: true,
  enableColumnSorting: true,
  enableTableTopBar: true,
  enableRowFilter: true,
  enableColumnResizing: true,
  enablePagination: true,
  topBarOptions: {
    rowCountLabel: "Data sources",
    showSearch: true,
  },
};

function DataSourcePicker({ form }: { form: AnyReactFormApi }): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const kind: DatasetKind | "" = useStore(form.store, (s) => s.values.kind ?? "");
  const { data, isLoading, isError } = useListDataSourcesQuery(
    { projectId },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId },
  );

  const [browseTarget, setBrowseTarget] = useState<{
    dsrcId: string;
    name: string;
    sourceType: string;
    totalFiles: number | null;
    lastCompletedAt: string | null;
  } | null>(null);

  const tableData: DataSourceTableRow[] = useMemo(
    () => (data?.data ?? [])
      .filter((ds) => !ds.deprecated)
      .filter((ds) => isDataSourceCompatibleWithDatasetKind(ds.category, kind))
      .map((item) => ({ ...item, id: item.dsrc_id })),
    [data, kind],
  );

  // Only clear an incompatible selection after the list has actually loaded.
  // Skipping this while `data` is undefined prevents clearing a valid edit-mode
  // selection before the query returns.
  useEffect(() => {
    if (!data) {
      return;
    }
    const selectedId: string = form.getFieldValue("data_source_id") ?? "";
    if (!selectedId) {
      return;
    }
    const selectedRow = tableData.find((r) => r.id === selectedId);
    if (!selectedRow) {
      form.setFieldValue("data_source_id", "");
      form.setFieldValue("data_source_category", null);
      form.setFieldValue("resource_selector", []);
      form.setFieldValue("schema_query", "");
    }
  }, [form, data, tableData]);

  const handleViewData = useCallback((row: DataSourceTableRow) => {
    setBrowseTarget({
      dsrcId: row.dsrc_id,
      name: row.name,
      sourceType: row.source_type ?? "",
      totalFiles: row.scan?.total_files ?? null,
      lastCompletedAt: row.scan?.last_completed_at ?? null,
    });
  }, []);

  const columns = useMemo(
    () => createDatasetFormDataSourcePickerColumns({
      onViewData: handleViewData,
    }),
    [handleViewData],
  );

  const handleRowSelectionChange = useCallback((selection: Record<string, boolean>) => {
    const selectedId = Object.keys(selection).find((k) => selection[k]) ?? "";
    form.setFieldValue("data_source_id", selectedId);
    // Capture the selected source's category so the scope section can gate options.
    const selectedRow = tableData.find((r) => r.id === selectedId);
    form.setFieldValue("data_source_category", selectedRow?.category ?? null);
  }, [form, tableData]);

  return (
    <div className="dset-form__picker">
      <form.Field name="data_source_id" validators={dataSourceIdFieldValidators}>
        {() => null}
      </form.Field>
      <BaseTable<DataSourceTableRow>
        key={kind || "unstructured"}
        options={PICKER_TABLE_OPTIONS}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
        onRowSelectionChange={handleRowSelectionChange}
      />
      <DataSourceIdFieldError form={form} />

      {browseTarget !== null && (
        <VolumeBrowserDialog
          open
          onOpenChange={(o) => { if (!o) setBrowseTarget(null); }}
          volumeId={browseTarget.dsrcId}
          volumeName={browseTarget.name}
          projectId={projectId}
          initialPath=""
        />
      )}
    </div>
  );
}

export { DataSourcePicker };

import type { DatasetDetail } from "@/api/dataset.types";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull, formatBytes } from "@/components/data-source/utils/data-source.utils";
import type { KeyValueRow } from "@/ui-lib/base-components/card/card.block";
import { LAST_MODIFIED_OPTIONS } from "../create-edit/form/dataset-form.consts";

function getLastModifiedLabel(filter: string | undefined): string {
  return LAST_MODIFIED_OPTIONS.find((o) => o.value === filter)?.label ?? "—";
}

function getFolderScopeLabel(spec: DatasetDetail["spec"]): string {
  return spec?.folder_scope === "custom" ? "Custom selection" : "All folders";
}

export function buildDatasetDetailRows(data: DatasetDetail): KeyValueRow[] {
  const spec = data.spec;
  // File-scope filters only apply to unstructured datasets pulled from a data
  // source (volume / object store). Manual uploads have no source to filter,
  // and structured datasets (metrics / database / SQL) express scope via
  // resource selectors or a SQL query — so hide these rows for them.
  const showFileFilters = data.kind === "unstructured" && data.input_type === "data-source";

  const rows: KeyValueRow[] = [
    { label: "Name", value: data.name },
    { label: "Description", value: data.description || "—" },
    {
      label: "Labels",
      value: data.labels.length > 0
        ? <ChipList values={data.labels} getLabel={(v) => String(v)} isRemovable={false} isDisabled={false} />
        : "—",
    },
    {
      label: "Assigned data source",
      value: data.data_source?.name || "—",
    },
    { label: "File scope", value: data.files_count != null ? String(data.files_count) : "—" },
  ];

  if (showFileFilters) {
    rows.push(
      { label: "Folder scope", value: getFolderScopeLabel(spec) },
      {
        label: "Folders",
        value: spec?.paths?.length ? spec.paths.join(", ") : "—",
      },
      {
        label: "File types",
        value: spec?.file_types?.length ? spec.file_types.join(", ") : "—",
      },
      { label: "Last modified", value: getLastModifiedLabel(spec?.last_modified_filter) },
      { label: "Size limit", value: spec?.max_file_size_bytes != null ? formatBytes(spec.max_file_size_bytes) : "—" },
      {
        label: "Exclude patterns",
        value: spec?.exclude_patterns?.length ? spec.exclude_patterns.join(", ") : "—",
      },
    );
  }

  rows.push(
    { label: "Last time update", value: formatDateTimeFull(data.updated_at) },
    { label: "Created", value: formatDateTimeFull(data.created_at) },
  );

  return rows;
}

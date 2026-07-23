import type { DataSourceDetail } from "@/api/data-source.types";
import { formatDataSourceCategoryLabel } from "@/api/data-source-category.utils";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { SOURCE_TYPE_LABELS } from "../create-edit/form/data-source-form.consts";
import type { KeyValueRow } from "@/ui-lib/base-components/card/card.block";

export function buildDataSourceDetailRows(ds: DataSourceDetail): KeyValueRow[] {
  return [
    { label: "Name", value: ds.name },
    { label: "Description", value: ds.description || "-" },
    {
      label: "Labels",
      value: ds.labels.length > 0
        ? <ChipList values={ds.labels} getLabel={(v) => String(v)} isRemovable={false} isDisabled={false} />
        : "-",
    },
    {
      label: "Type",
      value: formatDataSourceCategoryLabel(ds.category)
        ?? (ds.source_type ? SOURCE_TYPE_LABELS[ds.source_type] ?? ds.source_type : "-"),
    },
    { label: "Server name (IP address)", value: ds.connection.server || "-" },
    { label: "Path", value: ds.connection.export_path || "-" },
    { label: "Username", value: ds.connection.username || "-" },
    { label: "Password", value: ds.connection.username ? "********" : "-" },
    { label: "Last time update", value: formatDateTimeFull(ds.updated_at) },
    { label: "Created", value: formatDateTimeFull(ds.created_at) },
  ];
}

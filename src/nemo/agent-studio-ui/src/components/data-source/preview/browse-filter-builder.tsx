import { useState, useCallback, useRef, type ReactElement } from "react";
import { IconPlus, IconX, IconFilter, IconFilterOff } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { FilterCriteria } from "@/api/analytics-api";
import { classifyDuckDBType } from "@/components/dataset/preview/duckdb-types";
import { buildBrowseFilterCriteria, browseFilterValuePlaceholder } from "./browse-filter.utils";

interface FilterRow {
  id: number;
  column: string;
  value: string;
}

export interface BrowseFilterBuilderProps {
  columns: string[];
  columnTypes: string[];
  onApply: (filters: FilterCriteria[]) => void;
  onClear: () => void;
}

export function BrowseFilterBuilder({
  columns,
  columnTypes,
  onApply,
  onClear,
}: BrowseFilterBuilderProps): ReactElement {
  const [rows, setRows] = useState<FilterRow[]>([]);
  const nextIdRef = useRef(0);

  const getTypeCategory = useCallback(
    (colName: string) => {
      const idx = columns.indexOf(colName);
      if (idx < 0 || idx >= columnTypes.length) return "other";
      return classifyDuckDBType(columnTypes[idx]);
    },
    [columns, columnTypes],
  );

  const addRow = () => {
    const nextId = ++nextIdRef.current;
    setRows((prev) => [
      ...prev,
      { id: nextId, column: columns[0] ?? "", value: "" },
    ]);
  };

  const removeRow = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));

  const updateRow = (id: number, field: keyof FilterRow, value: string) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  const handleApply = () => {
    const valid = rows
      .map((r) => buildBrowseFilterCriteria(r.column, r.value, columns, columnTypes))
      .filter((f): f is FilterCriteria => f !== null);
    onApply(valid);
  };

  const handleClear = () => {
    setRows([]);
    onClear();
  };

  return (
    <div className="preview-filter-builder">
      {rows.map((row, idx) => {
        const category = getTypeCategory(row.column);
        const valuePlaceholder = browseFilterValuePlaceholder(category);

        return (
          <div key={row.id} className="preview-filter-builder__row-group">
            {idx > 0 && (
              <Typography Component="span" fontSize="fs12" boldness="semibold" color="var(--text-secondary)" className="preview-filter-builder__and">
                AND
              </Typography>
            )}
            <div className="preview-filter-builder__row">
              <select
                className="preview-filter-builder__select"
                value={row.column}
                onChange={(e) => updateRow(row.id, "column", e.target.value)}
              >
                {columns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>

              <input
                className="preview-filter-builder__input"
                placeholder={valuePlaceholder}
                value={row.value}
                onChange={(e) => updateRow(row.id, "value", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleApply()}
              />

              <button
                type="button"
                className="preview-filter-builder__remove"
                onClick={() => removeRow(row.id)}
                aria-label="Remove filter"
              >
                <IconX size={14} />
              </button>
            </div>
          </div>
        );
      })}

      <div className="preview-filter-builder__actions">
        <Button
          variant="flat"
          size="small"
          label="Add filter"
          icon={<IconPlus size={14} />}
          onClick={addRow}
        />
        {rows.length > 0 && (
          <>
            <Button
              variant="solid"
              size="small"
              label="Apply"
              icon={<IconFilter size={14} />}
              onClick={handleApply}
            />
            <Button
              variant="outline"
              size="small"
              label="Clear all"
              icon={<IconFilterOff size={14} />}
              onClick={handleClear}
            />
          </>
        )}
      </div>
    </div>
  );
}

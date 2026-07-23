import { useState, useCallback, useRef, type ReactElement } from "react";
import { IconPlus, IconX, IconFilter, IconFilterOff } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { FilterCriteria } from "@/api/analytics-api";
import { classifyDuckDBType, type ColumnTypeCategory } from "./duckdb-types";

// -- Operators per column type --

const OPERATORS_BY_CATEGORY: Record<ColumnTypeCategory, FilterCriteria["op"][]> = {
  integer:  ["=", "!=", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL", "IN"],
  float:    ["=", "!=", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL", "IN"],
  string:   ["=", "!=", "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL", "IN"],
  temporal: ["=", "!=", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL"],
  boolean:  ["=", "!=", "IS NULL", "IS NOT NULL"],
  other:    ["=", "!=", "IS NULL", "IS NOT NULL"],
};

// -- Types --

interface FilterRow {
  id: number;
  column: string;
  op: FilterCriteria["op"];
  value: string;
}

export interface FilterBuilderProps {
  columns: string[];
  columnTypes: string[];
  onApply: (filters: FilterCriteria[]) => void;
  onClear: () => void;
}

// -- Component --

export function FilterBuilder({ columns, columnTypes, onApply, onClear }: FilterBuilderProps): ReactElement {
  const [rows, setRows] = useState<FilterRow[]>([]);
  const nextIdRef = useRef(0);

  const getTypeCategory = useCallback(
    (colName: string): ColumnTypeCategory => {
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
      { id: nextId, column: columns[0] ?? "", op: "=", value: "" },
    ]);
  };

  const removeRow = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));

  const updateRow = (id: number, field: keyof FilterRow, value: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const updated = { ...r, [field]: value };
        if (field === "column") {
          const ops = OPERATORS_BY_CATEGORY[getTypeCategory(value)];
          if (!ops.includes(updated.op)) updated.op = ops[0];
        }
        return updated;
      }),
    );
  };

  const handleApply = () => {
    const valid = rows
      .filter((r) => r.column)
      .map((r): FilterCriteria => {
        const nullOp = r.op === "IS NULL" || r.op === "IS NOT NULL";
        return { column: r.column, op: r.op, value: nullOp ? undefined : r.value };
      });
    onApply(valid);
  };

  const handleClear = () => {
    setRows([]);
    onClear();
  };

  const noValue = (op: string) => op === "IS NULL" || op === "IS NOT NULL";

  return (
    <div className="preview-filter-builder">
      {rows.map((row, idx) => {
        const ops = OPERATORS_BY_CATEGORY[getTypeCategory(row.column)];
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

              <select
                className="preview-filter-builder__select preview-filter-builder__select--op"
                value={row.op}
                onChange={(e) => updateRow(row.id, "op", e.target.value)}
              >
                {ops.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>

              {!noValue(row.op) && (
                <input
                  className="preview-filter-builder__input"
                  placeholder="Value"
                  value={row.value}
                  onChange={(e) => updateRow(row.id, "value", e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                />
              )}

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

import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { IconChevronLeft, IconChevronRight, IconChevronUp, IconChevronDown, IconSelector } from "@tabler/icons-react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { ColumnVisibilityPopover } from "./ColumnVisibilityPopover";

// -- Types --

export type PreviewRow = Record<string, string | number | null> & { _row_id: string };

export interface PreviewTableProps {
  columns: string[];
  rows: PreviewRow[];
  totalCount: number;
  pageIndex: number;
  pageSize: number;
  loading: boolean;
  sorting: SortingState;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onSortChange: (sorting: SortingState) => void;
  /** Optional renderer for a per-column filter icon in the header */
  columnFilterRenderer?: (columnId: string) => ReactNode;
}

const PAGE_SIZES = [10, 25, 50, 100, 200];

// -- Component --

export function PreviewTable({
  columns,
  rows,
  totalCount,
  pageIndex,
  pageSize,
  loading,
  sorting,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  columnFilterRenderer,
}: PreviewTableProps): ReactElement {
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});

  const tableCols = useMemo<ColumnDef<PreviewRow>[]>(
    () =>
      columns.map((col) => ({
        id: col,
        accessorKey: col,
        header: col,
        enableSorting: true,
        cell: ({ getValue }) => {
          const v = getValue();
          if (v === null || v === undefined)
            return <span className="preview-table__null">NULL</span>;
          const s = String(v);
          return (
            <span title={s.length > 60 ? s : undefined}>
              {s.length > 60 ? `${s.slice(0, 60)}…` : s}
            </span>
          );
        },
      })),
    [columns],
  );

  const table = useReactTable<PreviewRow>({
    data: rows,
    columns: tableCols,
    pageCount: Math.ceil(totalCount / pageSize) || 1,
    state: {
      sorting,
      columnVisibility,
      pagination: { pageIndex, pageSize },
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      onSortChange(next);
    },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    enableSorting: true,
  });

  const pageCount = Math.ceil(totalCount / pageSize) || 1;
  const firstRow = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const lastRow = Math.min((pageIndex + 1) * pageSize, totalCount);
  const stateColSpan = table.getVisibleLeafColumns().length || 1;

  return (
    <div className="preview-table">
      {/* Column visibility toolbar */}
      <div className="preview-table__toolbar">
        <Typography Component="span" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
          {totalCount.toLocaleString()} rows
          {totalCount > 5000 && " (capped at 5 000 — use filters to narrow)"}
        </Typography>

        <div className="preview-table__col-toggle-wrapper">
          <ColumnVisibilityPopover
            columns={table
              .getAllLeafColumns()
              .filter((col) => !col.id.startsWith("_") && !col.id.startsWith("$"))
              .map((col) => ({ id: col.id, label: col.id, visible: col.getIsVisible() }))}
            onApply={(visibility) => setColumnVisibility(visibility)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="preview-table__scroll">
        <table className="preview-table__table">
          <thead className="preview-table__thead">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="preview-table__th"
                      onClick={header.column.getToggleSortingHandler()}
                      style={{ cursor: "pointer" }}
                    >
                      <div className="preview-table__th-inner">
                        <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        <div className="preview-table__th-icons" onClick={(e) => e.stopPropagation()}>
                          {sorted === "asc" ? (
                            <IconChevronUp size={13} />
                          ) : sorted === "desc" ? (
                            <IconChevronDown size={13} />
                          ) : (
                            <IconSelector size={13} className="preview-table__sort-idle" />
                          )}
                          {columnFilterRenderer && columnFilterRenderer(header.column.id)}
                        </div>
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={stateColSpan} className="preview-table__state-cell">
                  <Spinner size="fitContent" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={stateColSpan} className="preview-table__state-cell">
                  <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                    No data
                  </Typography>
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="preview-table__tr">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="preview-table__td">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="preview-table__pagination">
        <div className="preview-table__page-size">
          <Typography Component="span" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
            Rows per page:
          </Typography>
          <select
            className="preview-table__page-size-select"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <Typography Component="span" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
          {firstRow}–{lastRow} of {totalCount.toLocaleString()}
        </Typography>

        <div className="preview-table__page-controls">
          <Button
            variant="icon"
            size="small"
            icon={<IconChevronLeft size={16} />}
            isDisabled={pageIndex === 0}
            onClick={() => onPageChange(pageIndex - 1)}
            aria-label="Previous page"
          />
          <Typography Component="span" fontSize="fs13" boldness="regular">
            {pageIndex + 1} / {pageCount}
          </Typography>
          <Button
            variant="icon"
            size="small"
            icon={<IconChevronRight size={16} />}
            isDisabled={pageIndex >= pageCount - 1}
            onClick={() => onPageChange(pageIndex + 1)}
            aria-label="Next page"
          />
        </div>
      </div>
    </div>
  );
}

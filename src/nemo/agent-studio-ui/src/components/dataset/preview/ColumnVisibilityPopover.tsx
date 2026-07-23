import { useState, useEffect, useRef, type ReactElement } from "react";
import { IconColumns3 } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";

// -- Types --

export interface ColumnVisibilityOption {
  id: string;
  label: string;
  visible: boolean;
}

export interface ColumnVisibilityPopoverProps {
  columns: ColumnVisibilityOption[];
  /** Commits the chosen visibility map (columnId → visible) to the table. */
  onApply: (visibility: Record<string, boolean>) => void;
}

function toVisibilityDraft(
  columns: ColumnVisibilityOption[],
  getVisible: (column: ColumnVisibilityOption) => boolean = (column) => column.visible,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  columns.forEach((column) => {
    next[column.id] = getVisible(column);
  });
  return next;
}

// -- Component --

/**
 * Column chooser popover: a "Select all" toggle, a checkbox per column, and
 * Apply / Restore default actions. Selections are held in a local draft and
 * only committed on Apply, so toggling checkboxes doesn't churn the table.
 */
export function ColumnVisibilityPopover({
  columns,
  onApply,
}: ColumnVisibilityPopoverProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const visibleCount = columns.filter((c) => c.visible).length;
  const allChecked = columns.length > 0 && columns.every((c) => draft[c.id]);

  const toggle = (id: string) => setDraft((prev) => ({ ...prev, [id]: !prev[id] }));

  const toggleAll = () => {
    const value = !allChecked;
    const next: Record<string, boolean> = {};
    columns.forEach((c) => { next[c.id] = value; });
    setDraft(next);
  };

  const handleApply = () => {
    const hasAnyVisible = Object.values(draft).some(Boolean);
    if (hasAnyVisible || columns.length === 0) {
      onApply(draft);
      setOpen(false);
      return;
    }

    // Guard against an empty table layout: keep the first column visible.
    const fallback = { ...draft, [columns[0].id]: true };
    onApply(fallback);
    setOpen(false);
  };

  const handleRestoreDefault = () => {
    setDraft(toVisibilityDraft(columns, () => true));
  };

  return (
    <div className="col-vis" ref={panelRef}>
      <button
        type="button"
        className="col-vis__trigger"
        onClick={() => {
          if (!open) setDraft(toVisibilityDraft(columns));
          setOpen((v) => !v);
        }}
        aria-label="Choose columns"
        title={`Columns (${visibleCount}/${columns.length})`}
      >
        <IconColumns3 size={16} />
      </button>

      {open && (
        <div className="col-vis__panel" onClick={(e) => e.stopPropagation()}>
          <label className="col-vis__item col-vis__item--all">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            <Typography Component="span" fontSize="fs13" boldness="semibold">
              Select all
            </Typography>
          </label>

          <div className="col-vis__list">
            {columns.map((c) => (
              <label key={c.id} className="col-vis__item">
                <input
                  type="checkbox"
                  checked={draft[c.id] ?? false}
                  onChange={() => toggle(c.id)}
                />
                <span className="col-vis__item-label">{c.label}</span>
              </label>
            ))}
          </div>

          <div className="col-vis__actions">
            <Button variant="flat" size="small" label="Apply" onClick={handleApply} />
            <Button variant="flat" size="small" label="Restore default" onClick={handleRestoreDefault} />
          </div>
        </div>
      )}
    </div>
  );
}

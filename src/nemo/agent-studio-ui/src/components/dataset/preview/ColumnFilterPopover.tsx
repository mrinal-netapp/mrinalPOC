import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type ReactElement,
  type ChangeEvent,
} from "react";
import { IconFilter, IconX } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { columnHistogram } from "@/api/analytics-api";
import type { FilterCriteria, HistogramBucket } from "@/api/analytics-api";

// -- Types --

export interface ColumnFilterPopoverProps {
  namespace: string;
  tableName: string;
  column: string;
  columnType: string;
  activeFilter?: FilterCriteria;
  onApply: (filter: FilterCriteria) => void;
  onClear: () => void;
}

// -- Component --

export function ColumnFilterPopover({
  namespace,
  tableName,
  column,
  activeFilter,
  onApply,
  onClear,
}: ColumnFilterPopoverProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [buckets, setBuckets] = useState<HistogramBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchValues = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const resp = await columnHistogram(namespace, tableName, column, [], abortRef.current.signal);
      setBuckets(resp.buckets ?? []);
      if (activeFilter?.op === "IN" && activeFilter.value) {
        setSelected(new Set(activeFilter.value.split(",").map((v) => v.trim())));
      } else {
        setSelected(new Set());
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load values");
    } finally {
      setLoading(false);
    }
  }, [namespace, tableName, column, activeFilter]);

  useEffect(() => {
    if (open) {
      fetchValues();
      setSearch("");
    }
    return () => { abortRef.current?.abort(); };
  }, [open, fetchValues]);

  // Close on outside click
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

  const filtered = useMemo(() => {
    if (!search) return buckets;
    const q = search.toLowerCase();
    return buckets.filter((b) => b.label.toLowerCase().includes(q));
  }, [buckets, search]);

  const toggle = (label: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });

  const handleApply = () => {
    if (selected.size === 0) {
      onClear();
    } else {
      onApply({ column, op: "IN", value: Array.from(selected).join(",") });
    }
    setOpen(false);
  };

  const handleRemove = () => {
    onClear();
    setSelected(new Set());
    setOpen(false);
  };

  const hasActive = !!activeFilter;

  return (
    <div className="col-filter" ref={panelRef}>
      <button
        type="button"
        className={`col-filter__trigger${hasActive ? " col-filter__trigger--active" : ""}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={`Filter by ${column}`}
      >
        <IconFilter size={12} />
      </button>

      {open && (
        <div className="col-filter__panel" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="col-filter__header">
            <Typography Component="span" fontSize="fs13" boldness="semibold">
              Filter: {column}
            </Typography>
            <button type="button" className="col-filter__close" onClick={() => setOpen(false)}>
              <IconX size={14} />
            </button>
          </div>

          {loading ? (
            <div className="col-filter__loading">
              <Spinner size="fitContent" />
            </div>
          ) : error ? (
            <Typography Component="p" fontSize="fs12" boldness="regular" color="var(--notification-error)" className="col-filter__error">
              {error}
            </Typography>
          ) : (
            <>
              <input
                className="col-filter__search"
                placeholder="Search values…"
                value={search}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              />

              <div className="col-filter__bulk">
                <button type="button" className="col-filter__bulk-btn" onClick={() => setSelected(new Set(filtered.map((b) => b.label)))}>
                  Select all
                </button>
                <button type="button" className="col-filter__bulk-btn" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </div>

              <div className="col-filter__list">
                {filtered.length === 0 ? (
                  <Typography Component="p" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                    No values found
                  </Typography>
                ) : (
                  filtered.map((bucket) => (
                    <label key={bucket.label} className="col-filter__item">
                      <input
                        type="checkbox"
                        checked={selected.has(bucket.label)}
                        onChange={() => toggle(bucket.label)}
                        className="col-filter__checkbox"
                      />
                      <span className="col-filter__item-label">{bucket.label || "(empty)"}</span>
                      <span className="col-filter__item-count">{bucket.count.toLocaleString()}</span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}

          <div className="col-filter__actions">
            {hasActive && (
              <Button variant="flat" size="small" label="Remove filter" onClick={handleRemove} />
            )}
            <Button variant="solid" size="small" label="Apply" onClick={handleApply} isDisabled={loading} />
          </div>
        </div>
      )}
    </div>
  );
}

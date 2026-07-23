import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactElement,
} from "react";
import { SQLMonacoEditor } from "@/components/sql-monaco-editor/sql-monaco-editor";
import { IconArrowsLeftRight, IconInfoCircle } from "@tabler/icons-react";
import type { SortingState } from "@tanstack/react-table";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import { previewDataset, queryDataset } from "@/api/analytics-api";
import type { FilterCriteria, OrderBy, PreviewResponse } from "@/api/analytics-api";
import { FilterBuilder } from "@/components/dataset/preview/FilterBuilder";
import { ColumnFilterPopover } from "@/components/dataset/preview/ColumnFilterPopover";
import { PreviewTable } from "@/components/dataset/preview/PreviewTable";
import type { PreviewRow } from "@/components/dataset/preview/PreviewTable";

// -- Types --

export interface DatasetDetailDataPreviewProps {
  dsetId: string;
  namespace?: string | null;
  catalogTableName?: string | null;
  /**
   * Whether acquisition/import has finished and the Iceberg table actually
   * exists. Catalog coordinates are populated from the dataset name *before*
   * the table is created, so coords alone aren't enough to query — attempting
   * too early fails with a "table does not exist" error. The parent polls the
   * dataset (POLLING_INTERVAL), so once acquisition completes this flips to
   * `true` and the preview loads automatically. Defaults to `true`.
   */
  isReady?: boolean;
  /**
   * Version of the dataset's latest committed snapshot. Bumped by the backend
   * every time files are (re)imported — e.g. after a manual-upload edit that
   * adds/removes files. `isReady` alone can't be used to trigger a reload
   * because it's already `true` for datasets that were previously ready (an
   * older snapshot already exists) even while a newer import is still in
   * flight. Watching this value lets the preview refetch once the *new*
   * snapshot is actually in place, instead of showing stale rows forever.
   */
  snapshotVersion?: number | null;
  /**
   * Iceberg snapshot id for the dataset's current table state. Unlike
   * `snapshotVersion` (a 1-based index that resets to 1 when a re-import drops
   * and recreates the table), this id changes on every successful import and is
   * used to refetch preview after edit+save re-imports.
   */
  snapshotId?: string | null;
  /** Bumped when the dataset record changes (e.g. import completes). */
  datasetUpdatedAt?: string | null;
}

/** Recognise the catalog "table does not exist" error so we can show a friendly hint. */
function isTableMissingError(message: string): boolean {
  if (/401|unauthorized/i.test(message)) return false;
  // Missing Iceberg metadata/data files (HTTP 404) means the catalog entry is
  // broken or a re-import is still settling — not "never imported".
  if (/HTTP 404|HTTP GET error|\(HTTP 404\)/i.test(message)) return false;
  return /does not exist|Table with name/i.test(message)
    || (/DESCRIBE failed/i.test(message) && !/unauthorized|401/i.test(message));
}

// -- Helpers --

const PREVIEW_SUB_TABS = [
  { id: "visual", label: "Visual" },
  { id: "sql", label: "Query" },
];

function buildRows(resp: PreviewResponse): PreviewRow[] {
  if (!resp.rows?.length || !resp.columns?.length) return [];
  return resp.rows.map((rowArr, i) => {
    const row: PreviewRow = { _row_id: String(i) };
    resp.columns.forEach((col, j) => {
      row[col] = rowArr[j] as string | number | null;
    });
    return row;
  });
}

/** SQL LIKE pattern (% and _) → anchored, case-insensitive RegExp. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sql = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${sql}$`, "i");
}

function rowMatchesFilter(row: PreviewRow, f: FilterCriteria): boolean {
  const cell = row[f.column];
  const isEmpty = cell === null || cell === undefined || cell === "";
  if (f.op === "IS NULL") return isEmpty;
  if (f.op === "IS NOT NULL") return !isEmpty;
  if (cell === null || cell === undefined) return false;

  const cellStr = String(cell);
  const fv = f.value ?? "";
  const cellNum = Number(cellStr);
  const fvNum = Number(fv);
  const numeric = fv !== "" && Number.isFinite(cellNum) && Number.isFinite(fvNum);

  switch (f.op) {
    case "=": return numeric ? cellNum === fvNum : cellStr === fv;
    case "!=": return numeric ? cellNum !== fvNum : cellStr !== fv;
    case ">": return numeric ? cellNum > fvNum : cellStr > fv;
    case "<": return numeric ? cellNum < fvNum : cellStr < fv;
    case ">=": return numeric ? cellNum >= fvNum : cellStr >= fv;
    case "<=": return numeric ? cellNum <= fvNum : cellStr <= fv;
    case "LIKE": return likeToRegExp(fv).test(cellStr);
    case "NOT LIKE": return !likeToRegExp(fv).test(cellStr);
    case "IN": return fv.split(",").map((s) => s.trim()).includes(cellStr);
    default: return true;
  }
}

/**
 * Applies FilterBuilder criteria to already-fetched rows (client-side, AND-ed).
 * Used by the Query tab: results come from an arbitrary SQL statement, so they
 * can't be re-filtered server-side without rewriting the user's query.
 */
function applyClientFilters(rows: PreviewRow[], filters: FilterCriteria[]): PreviewRow[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((f) => rowMatchesFilter(row, f)));
}

// -- Component --

export function DatasetDetailDataPreview({
  namespace,
  catalogTableName,
  isReady = true,
  snapshotVersion,
  snapshotId,
  datasetUpdatedAt,
}: DatasetDetailDataPreviewProps): ReactElement {
  const [activeSubTab, setActiveSubTab] = useState("visual");
  // Need both catalog coordinates AND a finished import (the table only exists
  // once acquisition/import completes). The parent polls the dataset, so when
  // acquisition finishes `isReady` flips to true and the load effect below
  // re-fires automatically — matching the legacy GUI's status-gated preview.
  const hasCatalogCoords = Boolean(namespace && catalogTableName);
  const isImporting = hasCatalogCoords && !isReady;
  const canPreview = hasCatalogCoords && isReady;

  // ---------- Visual tab state ----------
  const [visualResp, setVisualResp] = useState<PreviewResponse | null>(null);
  const [visualLoading, setVisualLoading] = useState(false);
  const [visualError, setVisualError] = useState<string | null>(null);
  // Whether the current error is worth retrying (transient network/5xx) vs a
  // terminal "table not imported yet" state the parent already polls for.
  const [visualErrorRetryable, setVisualErrorRetryable] = useState(false);
  const [visualPage, setVisualPage] = useState(0);
  const [visualPageSize, setVisualPageSize] = useState(50);
  const [visualSorting, setVisualSorting] = useState<SortingState>([]);
  const [visualFilters, setVisualFilters] = useState<FilterCriteria[]>([]);
  const latestVisualRequestIdRef = useRef(0);

  const loadVisual = useCallback(async (opts: {
    page?: number;
    pageSize?: number;
    filters?: FilterCriteria[];
    sorting?: SortingState;
  } = {}) => {
    if (!namespace || !catalogTableName) return;
    const requestId = ++latestVisualRequestIdRef.current;
    setVisualLoading(true);
    setVisualError(null);

    const page = opts.page ?? visualPage;
    const limit = opts.pageSize ?? visualPageSize;
    const filters = opts.filters ?? visualFilters;
    const sort = opts.sorting ?? visualSorting;
    const orderBy: OrderBy | undefined =
      sort.length > 0
        ? { column: sort[0].id, direction: sort[0].desc ? "desc" : "asc" }
        : undefined;

    try {
      const resp = await previewDataset(namespace, catalogTableName, {
        limit,
        offset: page * limit,
        filters,
        orderBy,
      });
      if (requestId !== latestVisualRequestIdRef.current) return;
      setVisualResp(resp);
    } catch (err: unknown) {
      if (requestId !== latestVisualRequestIdRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to load preview.";
      const tableMissing = isTableMissingError(message);
      setVisualErrorRetryable(!tableMissing);
      setVisualError(
        tableMissing
          ? "This dataset hasn't been imported yet, so there's no data to preview. Once its files are imported, the preview will appear here."
          : message,
      );
    } finally {
      if (requestId === latestVisualRequestIdRef.current) {
        setVisualLoading(false);
      }
    }
  }, [namespace, catalogTableName, visualPage, visualPageSize, visualFilters, visualSorting]);

  // Load on first switch to visual tab
  const handleTabChange = useCallback((tabId: string) => {
    setActiveSubTab(tabId);
  }, []);

  // Trigger initial load when tab is "visual" and we have coordinates but no
  // data yet, and reload whenever the underlying snapshot changes (e.g. a
  // file was deleted/added and re-imported) so the preview doesn't keep
  // showing rows from a stale/deleted snapshot.
  const hasLoadedVisualRef = useRef(false);
  const lastLoadedSnapshotKeyRef = useRef<string | undefined>(undefined);
  const snapshotKey =
    snapshotId != null && snapshotId !== ""
      ? snapshotId
      : snapshotVersion != null
        ? String(snapshotVersion)
        : undefined;
  const importStateKey = `${snapshotKey ?? ""}:${datasetUpdatedAt ?? ""}`;
  const prevIsReadyRef = useRef(isReady);
  useEffect(() => {
    if (!canPreview) {
      // Allow a fresh load when import finishes and preview becomes ready again.
      hasLoadedVisualRef.current = false;
      setVisualError(null);
      setVisualLoading(false);
      return;
    }
    if (activeSubTab !== "visual") return;
    const becameReady = isReady && !prevIsReadyRef.current;
    prevIsReadyRef.current = isReady;
    if (becameReady) {
      hasLoadedVisualRef.current = false;
    }
    if (hasLoadedVisualRef.current && lastLoadedSnapshotKeyRef.current === importStateKey) return;
    hasLoadedVisualRef.current = true;
    lastLoadedSnapshotKeyRef.current = importStateKey;
    setVisualPage(0);
    loadVisual({ page: 0 });
  }, [canPreview, isReady, activeSubTab, importStateKey, loadVisual]);

  // If preview failed while the table was briefly gone but the dataset is ready
  // again, retry automatically (covers slow polls missing the in_progress window).
  useEffect(() => {
    if (!isReady || !visualError || visualErrorRetryable) return;
    const timer = window.setTimeout(() => {
      hasLoadedVisualRef.current = false;
      loadVisual({ page: 0 });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [isReady, visualError, visualErrorRetryable, importStateKey, loadVisual]);

  const handleVisualPageChange = (page: number) => {
    setVisualPage(page);
    loadVisual({ page });
  };

  const handleVisualPageSizeChange = (size: number) => {
    setVisualPageSize(size);
    setVisualPage(0);
    loadVisual({ page: 0, pageSize: size });
  };

  const handleVisualSortChange = (sort: SortingState) => {
    setVisualSorting(sort);
    setVisualPage(0);
    loadVisual({ page: 0, sorting: sort });
  };

  const handleApplyFilters = (filters: FilterCriteria[]) => {
    setVisualFilters(filters);
    setVisualPage(0);
    loadVisual({ page: 0, filters });
  };

  const handleClearFilters = () => {
    setVisualFilters([]);
    setVisualPage(0);
    loadVisual({ page: 0, filters: [] });
  };

  const handleColumnFilter = (filter: FilterCriteria) => {
    const next = [
      ...visualFilters.filter((f) => f.column !== filter.column),
      filter,
    ];
    setVisualFilters(next);
    setVisualPage(0);
    loadVisual({ page: 0, filters: next });
  };

  const handleClearColumnFilter = (colName: string) => {
    const next = visualFilters.filter((f) => f.column !== colName);
    setVisualFilters(next);
    setVisualPage(0);
    loadVisual({ page: 0, filters: next });
  };

  // Remove a single advanced-filter badge by position, so multiple conditions
  // on the same column (e.g. a range) can be removed independently.
  const handleRemoveVisualFilter = (index: number) => {
    const next = visualFilters.filter((_, i) => i !== index);
    setVisualFilters(next);
    setVisualPage(0);
    loadVisual({ page: 0, filters: next });
  };

  const visualRows = visualResp ? buildRows(visualResp) : [];

  // ---------- Query tab state ----------
  const [sqlQuery, setSqlQuery] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryHasError, setQueryHasError] = useState(false);
  const [queryTimeMs, setQueryTimeMs] = useState<number | null>(null);
  const [queryRowCount, setQueryRowCount] = useState<number | null>(null);
  const [queryResp, setQueryResp] = useState<PreviewResponse | null>(null);
  // Advanced filters applied to the returned query rows (client-side).
  const [queryFilters, setQueryFilters] = useState<FilterCriteria[]>([]);
  // Query results are fully in memory, so paginate them client-side.
  const [queryPage, setQueryPage] = useState(0);
  const [queryPageSize, setQueryPageSize] = useState(50);

  const handleRunQuery = useCallback(async () => {
    if (!sqlQuery.trim()) return;
    setQueryLoading(true);
    setQueryHasError(false);
    setQueryTimeMs(null);
    setQueryRowCount(null);
    setQueryResp(null);
    setQueryFilters([]);
    setQueryPage(0);
    const start = Date.now();
    try {
      const resp = await queryDataset(sqlQuery.trim());
      setQueryResp(resp);
      setQueryTimeMs(Date.now() - start);
      setQueryRowCount(resp.rowCount ?? buildRows(resp).length);
    } catch {
      setQueryHasError(true);
      setQueryTimeMs(Date.now() - start);
      setQueryRowCount(0);
    } finally {
      setQueryLoading(false);
    }
  }, [sqlQuery]);

  const handleClearQuery = useCallback(() => {
    setSqlQuery("");
    setQueryHasError(false);
    setQueryTimeMs(null);
    setQueryRowCount(null);
    setQueryResp(null);
    setQueryFilters([]);
    setQueryPage(0);
  }, []);

  const handleApplyQueryFilters = useCallback((filters: FilterCriteria[]) => {
    setQueryFilters(filters);
    setQueryPage(0);
  }, []);

  const handleClearQueryFilters = useCallback(() => {
    setQueryFilters([]);
    setQueryPage(0);
  }, []);

  const handleRemoveQueryFilter = useCallback((index: number) => {
    setQueryFilters((prev) => prev.filter((_, i) => i !== index));
    setQueryPage(0);
  }, []);

  const queryRows = queryResp ? buildRows(queryResp) : [];
  const filteredQueryRows = applyClientFilters(queryRows, queryFilters);
  const pagedQueryRows = filteredQueryRows.slice(
    queryPage * queryPageSize,
    queryPage * queryPageSize + queryPageSize,
  );

  // ---------- Active filter badges ----------
  const renderFilterBadges = (filters: FilterCriteria[], onRemove: (index: number) => void) =>
    filters.length > 0 ? (
      <div className="dset-preview__filter-badges">
        {filters.map((f, i) => (
          <button
            key={`${f.column}-${f.op}-${f.value ?? ""}-${i}`}
            type="button"
            className="dset-preview__filter-badge"
            onClick={() => onRemove(i)}
            title="Click to remove"
          >
            {f.column} {f.op} {f.value ? (f.value.length > 24 ? `${f.value.slice(0, 24)}…` : f.value) : ""} ×
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="dset-preview">
      <div className="dset-preview__subtabs-row">
        <TabGroup
          tabs={PREVIEW_SUB_TABS}
          activeTabId={activeSubTab}
          onTabChange={handleTabChange}
          variant="card"
          fitting="fit-content"
          className="dset-preview__subtabs"
        >
          {/* ---- Visual tab ---- */}
          <TabContent tabId="visual" className="dset-preview__subtab-content">
            {!canPreview ? (
              isImporting ? (
                <div className="dset-preview__waiting" data-testid="dset-preview-importing">
                  <Spinner size="fitContent" />
                  <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                    Importing dataset files. Preview will appear here when import completes.
                  </Typography>
                </div>
              ) : (
                <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                  Preview is not available — dataset has no catalog table registered yet.
                </Typography>
              )
            ) : visualError ? (
              <div className="dset-preview__error">
                <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--notification-error)">
                  {visualError}
                </Typography>
                {visualErrorRetryable && (
                  <Button
                    variant="flat"
                    size="small"
                    label="Retry"
                    onClick={() => loadVisual()}
                    isDisabled={visualLoading}
                  />
                )}
              </div>
            ) : (
              <div className="dset-preview__visual">
                {/* Advanced filter sits below the Visual | Query tabs, directly
                    above the table; applying it re-queries server-side. */}
                <div className="dset-preview__top-filter">
                  <FilterBuilder
                    columns={visualResp?.columns ?? []}
                    columnTypes={visualResp?.columnTypes ?? []}
                    onApply={handleApplyFilters}
                    onClear={handleClearFilters}
                  />
                  {renderFilterBadges(visualFilters, handleRemoveVisualFilter)}
                </div>

                {/* Offset-capped warning */}
                {visualResp?.offsetCapped && (
                  <div className="dset-preview__capped-warning">
                    <IconInfoCircle size={14} />
                    <Typography Component="span" fontSize="fs13" boldness="regular" color="var(--text-secondary)">
                      Dataset exceeds 5 000 rows. Use filters to narrow results.
                    </Typography>
                  </div>
                )}

                <PreviewTable
                  columns={visualResp?.columns ?? []}
                  rows={visualRows}
                  totalCount={visualResp?.totalCount ?? 0}
                  pageIndex={visualPage}
                  pageSize={visualPageSize}
                  loading={visualLoading}
                  sorting={visualSorting}
                  onPageChange={handleVisualPageChange}
                  onPageSizeChange={handleVisualPageSizeChange}
                  onSortChange={handleVisualSortChange}
                  columnFilterRenderer={
                    namespace && catalogTableName
                      ? (colId) => (
                        <ColumnFilterPopover
                          namespace={namespace}
                          tableName={catalogTableName}
                          column={colId}
                          columnType={
                            visualResp?.columnTypes?.[
                              visualResp?.columns?.indexOf(colId) ?? -1
                            ] ?? "VARCHAR"
                          }
                          activeFilter={visualFilters.find((f) => f.column === colId)}
                          onApply={handleColumnFilter}
                          onClear={() => handleClearColumnFilter(colId)}
                        />
                      )
                      : undefined
                  }
                />
              </div>
            )}
          </TabContent>

          {/* ---- Query tab ---- */}
          <TabContent tabId="sql" className="dset-preview__subtab-content">
            <div className="dset-preview__sql">
              <div className="dset-preview__sql-card">
                <div className="dset-preview__sql-title">
                  <IconArrowsLeftRight size={16} />
                  <Typography Component="span" fontSize="fs14" boldness="semibold">
                    SQL queries
                  </Typography>
                </div>

                <div className="dset-preview__sql-actions">
                  <Button
                    variant="solid"
                    size="medium"
                    label="Run"
                    onClick={handleRunQuery}
                    isDisabled={!sqlQuery.trim() || queryLoading}
                    loading={queryLoading}
                  />
                  <Button
                    variant="outline"
                    size="medium"
                    label="Clear"
                    onClick={handleClearQuery}
                  />
                </div>

                {namespace && catalogTableName && (
                  <div className="dset-preview__sql-hint">
                    <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                      Table: <code>{`iceberg."${namespace}"."${catalogTableName}"`}</code>
                    </Typography>
                  </div>
                )}

                <div className="dset-preview__sql-editor-wrapper">
                  <div className="dset-preview__sql-label-row">
                    <Typography Component="span" fontSize="fs14" boldness="regular">
                      Query
                    </Typography>
                    <IconInfoCircle size={14} color="var(--text-secondary)" />
                  </div>
                  <SQLMonacoEditor
                    value={sqlQuery}
                    onChange={(val) => setSqlQuery(val)}
                    onExecute={handleRunQuery}
                    height="140px"
                    tables={
                      catalogTableName
                        ? [{ name: `iceberg."${namespace ?? ""}"."${catalogTableName}"`, columns: [] }]
                        : undefined
                    }
                  />
                  <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                    ⌘ / Ctrl + Enter to run
                  </Typography>
                </div>

                {queryTimeMs !== null && (
                  <div className="dset-preview__sql-info">
                    <IconInfoCircle
                      size={14}
                      color={queryHasError ? "var(--notification-error)" : "var(--text-secondary)"}
                    />
                    <Typography
                      Component="span"
                      fontSize="fs14"
                      boldness="regular"
                      color={queryHasError ? "var(--notification-error)" : "var(--text-secondary)"}
                    >
                      {queryHasError
                        ? "Query failed."
                        : `Query time: ${queryTimeMs}ms. Rows returned: ${queryRowCount ?? 0}.`}
                    </Typography>
                  </div>
                )}
              </div>

              {/* Only render the Results section once a query has actually run
                  (or is running) — no empty table before the first Run. */}
              {(queryLoading || queryResp) && (
                <div className="dset-preview__sql-results">
                  <Typography Component="span" fontSize="fs14" boldness="semibold">
                    Results
                  </Typography>

                  {/* Advanced filters sit directly above the results table so the
                      flow reads: write SQL → Run → filter the returned rows.
                      Filtering is client-side over the fetched query rows. */}
                  {queryResp && queryRows.length > 0 && (
                    <div className="dset-preview__top-filter">
                      <FilterBuilder
                        columns={queryResp.columns ?? []}
                        columnTypes={queryResp.columnTypes ?? []}
                        onApply={handleApplyQueryFilters}
                        onClear={handleClearQueryFilters}
                      />
                      {renderFilterBadges(queryFilters, handleRemoveQueryFilter)}
                    </div>
                  )}

                  <PreviewTable
                    columns={queryResp?.columns ?? []}
                    rows={pagedQueryRows}
                    totalCount={filteredQueryRows.length}
                    pageIndex={queryPage}
                    pageSize={queryPageSize}
                    loading={queryLoading}
                    sorting={[]}
                    onPageChange={setQueryPage}
                    onPageSizeChange={(size) => {
                      setQueryPageSize(size);
                      setQueryPage(0);
                    }}
                    onSortChange={() => {}}
                  />
                </div>
              )}
            </div>
          </TabContent>
        </TabGroup>
      </div>
    </div>
  );
}

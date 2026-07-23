import type { FilterCriteria } from "@/api/analytics-api";
import { classifyDuckDBType, type ColumnTypeCategory } from "@/components/dataset/preview/duckdb-types";

/** Escapes SQL LIKE metacharacters in a user-typed literal before wrapping with wildcards. */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function toContainsLikePattern(value: string): string {
  return `%${escapeLikeLiteral(value)}%`;
}

function browseFilterMode(category: ColumnTypeCategory): "contains" | "exact" {
  return category === "integer" || category === "float" ? "exact" : "contains";
}

export function browseFilterValuePlaceholder(category: ColumnTypeCategory): string {
  return browseFilterMode(category) === "exact" ? "Exact value" : "Contains…";
}

/**
 * Maps a column + user value to FilterCriteria using implicit browse operators:
 * text/temporal → contains (LIKE), numeric → exact match (=).
 */
export function buildBrowseFilterCriteria(
  column: string,
  value: string,
  columns: readonly string[],
  columnTypes: readonly string[],
): FilterCriteria | null {
  const trimmed = value.trim();
  if (!column || !trimmed) return null;

  const idx = columns.indexOf(column);
  const dbType = idx >= 0 && idx < columnTypes.length ? columnTypes[idx] : "";
  const category = classifyDuckDBType(dbType);
  const mode = browseFilterMode(category);

  if (mode === "exact") {
    return { column, op: "=", value: trimmed };
  }
  return { column, op: "LIKE", value: toContainsLikePattern(trimmed) };
}

/** Strips outer LIKE wildcards and unescapes a user-typed literal for display. */
function likePatternToDisplayValue(pattern: string): string {
  if (!pattern.startsWith("%") || !pattern.endsWith("%") || pattern.length < 2) return pattern;
  return pattern.slice(1, -1).replace(/\\(%|_|\\)/g, "$1");
}

/** Human-readable label for an applied browse filter badge. */
export function formatBrowseFilterLabel(
  filter: FilterCriteria,
  columns: readonly string[],
  columnTypes: readonly string[],
): string {
  const idx = columns.indexOf(filter.column);
  const dbType = idx >= 0 && idx < columnTypes.length ? columnTypes[idx] : "";
  const mode = browseFilterMode(classifyDuckDBType(dbType));
  const displayValue = filter.op === "LIKE" && filter.value
    ? likePatternToDisplayValue(filter.value)
    : (filter.value ?? "");

  return mode === "exact"
    ? `${filter.column} is ${displayValue}`
    : `${filter.column} contains ${displayValue}`;
}

/** Escapes a literal substring for use inside a RegExp. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * SQL LIKE pattern (% and _) → anchored, case-insensitive RegExp.
 * Honors backslash-escaped wildcards (\%, \_, \\).
 */
function likeToRegExp(pattern: string): RegExp {
  let regexBody = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "%" || next === "_" || next === "\\") {
        regexBody += escapeRegExpLiteral(next);
        i++;
        continue;
      }
    }
    if (ch === "%") {
      regexBody += ".*";
      continue;
    }
    if (ch === "_") {
      regexBody += ".";
      continue;
    }
    regexBody += escapeRegExpLiteral(ch);
  }
  return new RegExp(`^${regexBody}$`, "i");
}

type BrowseRowMatcher<T> = (row: T) => boolean;

function matchesExact(cell: string | number | null | undefined, filterValue: string): boolean {
  if (cell === null || cell === undefined) return false;

  const cellStr = String(cell);
  const filterNum = Number(filterValue);
  if (filterValue !== "" && Number.isFinite(filterNum)) {
    const cellNum = Number(cellStr);
    if (Number.isFinite(cellNum)) return cellNum === filterNum;
  }
  return cellStr === filterValue;
}

/** Compiles a browse filter once; only `=` and `LIKE` are supported. */
function compileBrowseFilter<T>(
  filter: FilterCriteria,
  getCellValue: (row: T, column: string) => string | number | null | undefined,
): BrowseRowMatcher<T> {
  const { column, op, value } = filter;

  if (op === "LIKE" && value != null) {
    const pattern = likeToRegExp(value);
    return (row) => {
      const cell = getCellValue(row, column);
      if (cell === null || cell === undefined) return false;
      return pattern.test(String(cell));
    };
  }

  if (op === "=" && value != null) {
    return (row) => matchesExact(getCellValue(row, column), value);
  }

  return () => false;
}

/**
 * Applies browse filter criteria to already-fetched rows (client-side, AND-ed).
 * Supports only exact match (=) and contains (LIKE).
 */
export function applyBrowseFilters<T>(
  rows: T[],
  filters: FilterCriteria[],
  getCellValue: (row: T, column: string) => string | number | null | undefined,
): T[] {
  if (filters.length === 0) return rows;

  const matchers = filters.map((filter) => compileBrowseFilter(filter, getCellValue));
  return rows.filter((row) => matchers.every((match) => match(row)));
}

export const VOLUME_BROWSE_FILTER_COLUMNS = ["Name", "Type", "Size", "Last modified"] as const;
export const VOLUME_BROWSE_FILTER_COLUMN_TYPES = ["VARCHAR", "VARCHAR", "BIGINT", "TIMESTAMP"] as const;

export const CONNECTOR_BROWSE_FILTER_COLUMNS = ["Name", "Type", "Details"] as const;
export const CONNECTOR_BROWSE_FILTER_COLUMN_TYPES = ["VARCHAR", "VARCHAR", "VARCHAR"] as const;

import type { ResourceSelectorEntry } from "@/api/dataset.types";
import { resolveDataAccessModel } from "@/consts/explorer-catalog";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";

export interface DatabaseTableResource {
  database?: string;
  schema: string;
  table: string;
}

/** Returns table/view coordinates when the selector entry is a database resource. */
export function parseDatabaseTableResource(
  entry: ResourceSelectorEntry,
): DatabaseTableResource | null {
  const e = entry as Record<string, unknown>;
  const schema = e.schema;
  const table = e.table;
  if (typeof schema !== "string" || !schema || typeof table !== "string" || !table) {
    return null;
  }
  const database = typeof e.database === "string" && e.database ? e.database : undefined;
  return { database, schema, table };
}

/** First database table/view entry in the list, if any. */
export function findFirstDatabaseTableResource(
  entries: ResourceSelectorEntry[],
): ResourceSelectorEntry | null {
  for (const entry of entries) {
    if (parseDatabaseTableResource(entry)) {
      return entry;
    }
  }
  return null;
}

/** Quote character for SQL identifiers, by connector provider. */
export function sqlQuoteCharForProvider(provider: string | null | undefined): string {
  const p = (provider ?? "").toLowerCase();
  return p === "mysql" || p === "mariadb" ? "`" : '"';
}

function quoteSqlIdentifier(name: string, quoteChar: string): string {
  const escaped = name.split(quoteChar).join(quoteChar + quoteChar);
  return `${quoteChar}${escaped}${quoteChar}`;
}

/**
 * Builds a schema-scope SQL query for a database table/view.
 * PostgreSQL-style double quotes for most providers; backticks for MySQL/MariaDB.
 */
export function buildSqlFromDatabaseTableResource(
  resource: DatabaseTableResource,
  provider?: string | null,
): string {
  const quote = sqlQuoteCharForProvider(provider);
  const schema = quoteSqlIdentifier(resource.schema, quote);
  const table = quoteSqlIdentifier(resource.table, quote);
  const fromClause = `SELECT * FROM ${schema}.${table}`;
  if (resource.database != null) {
    return `-- Database: ${resource.database}\n${fromClause}`;
  }
  return fromClause;
}

/** Dedupe key for a resource-selector entry. */
export function resourceEntryKey(entry: ResourceSelectorEntry): string {
  return JSON.stringify(entry);
}

/** True when the entry is a metrics `resourceSelector` leaf (`{ category: "…" }`). */
export function isMetricCategorySelectorEntry(entry: ResourceSelectorEntry): boolean {
  return typeof (entry as Record<string, unknown>).category === "string";
}

function entriesAreAllMetricCategories(entries: ResourceSelectorEntry[]): boolean {
  return entries.length > 0 && entries.every(isMetricCategorySelectorEntry);
}

/** Metric categories cannot share a dataset scope with volumes, buckets, tables, etc. */
function wouldMixMetricAndNonMetric(
  current: ResourceSelectorEntry[],
  added: ResourceSelectorEntry[],
): boolean {
  const hasMetric = (entries: ResourceSelectorEntry[]) =>
    entries.some(isMetricCategorySelectorEntry);
  const hasNonMetric = (entries: ResourceSelectorEntry[]) =>
    entries.some((e) => !isMetricCategorySelectorEntry(e));
  if (hasMetric(added) && hasNonMetric(added)) {
    return true;
  }
  if (hasMetric(current) && hasNonMetric(added)) {
    return true;
  }
  if (hasNonMetric(current) && hasMetric(added)) {
    return true;
  }
  return false;
}

/** Merges newly picked explorer resources into the current selector (deduped). */
export function mergeResourceSelectorEntries(
  current: ResourceSelectorEntry[],
  added: ResourceSelectorEntry[],
): ResourceSelectorEntry[] {
  const seen = new Set(current.map(resourceEntryKey));
  const merged = [...current];
  for (const entry of added) {
    const key = resourceEntryKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * Merges explorer picks into the resource selector. Mirrors legacy DataSetWizard:
 * - Database table/view: single scope (new pick replaces)
 * - Multi-select providers (e.g. ONTAP): dedupe-merge
 * - Other single-select connectors: latest pick replaces
 */
export function mergeResourceSelectorEntriesForCategory(
  current: ResourceSelectorEntry[],
  added: ResourceSelectorEntry[],
  provider?: string | null,
  connectorScope?: "account" | "resource" | null,
): ResourceSelectorEntry[] {
  if (added.length === 0) {
    return current;
  }
  if (wouldMixMetricAndNonMetric(current, added)) {
    const addedMixesShapes =
      added.some(isMetricCategorySelectorEntry) &&
      added.some((entry) => !isMetricCategorySelectorEntry(entry));
    if (addedMixesShapes) {
      return current;
    }
    return mergeResourceSelectorEntriesForCategory([], added, provider, connectorScope);
  }
  const tableEntry = findFirstDatabaseTableResource(added);
  if (tableEntry) {
    return [tableEntry];
  }
  if (entriesAreAllMetricCategories(added)) {
    return mergeResourceSelectorEntries(current, added);
  }
  const { selectionMode } = resolveDataAccessModel(provider, connectorScope ?? undefined);
  if (selectionMode === "multi") {
    return mergeResourceSelectorEntries(current, added);
  }
  return [added[0]!];
}

/** Picks one folder path from a browser selection; latest entry wins when multiple are chosen. */
export function pickSingleFolderPath(selectedPaths: string[]): string | null {
  const trimmed = selectedPaths.map((p) => String(p).trim()).filter((p) => p.length > 0);
  return trimmed.at(-1) ?? null;
}

/**
 * When the user adds a database table/view scope, pre-populate schema_query
 * with SELECT * (same as the legacy DataSetWizard).
 */
export function populateSchemaQueryFromDatabaseTables(
  form: AnyReactFormApi,
  added: ResourceSelectorEntry[],
  provider?: string | null,
): void {
  const tableEntry = findFirstDatabaseTableResource(added);
  if (!tableEntry) {
    return;
  }

  const parsed = parseDatabaseTableResource(tableEntry);
  if (!parsed) {
    return;
  }

  form.setFieldValue("schema_query", buildSqlFromDatabaseTableResource(parsed, provider));
}

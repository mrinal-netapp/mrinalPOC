/**
 * explorer-catalog.ts
 *
 * Static connector `dataAccessModel` metadata, mirrored from config-service's
 * `provider-catalog.json`. It drives the connector explorer: which action lists
 * the root level, whether selection is single or multi, which node types are
 * selectable, and whether a region must be chosen first.
 *
 * Bundled (rather than fetched) because it is small, static product metadata and
 * the config-service `/api/v1/explorer/providers` route is not exposed through
 * the agent-studio-ui gateway prefix today. Keep in sync with
 * `config-service/provider-catalog.json` if providers change.
 */

export type ExplorerSelectionMode = 'single' | 'multi';

/** Explorer action that lists selectable metric-category leaves (ONTAP / GCNV / ANF). */
export const METRIC_CATEGORY_LIST_ACTION = 'listMetricCategories';

export interface ExplorerDataAccessModel {
  /** Action used to list the top level (e.g. listBuckets, listDatabases). */
  rootAction: string;
  selectionMode: ExplorerSelectionMode;
  /** Node `type`s eligible for selection. */
  selectableTypes: string[];
  /** Present for providers offering an in-explorer SQL editor (databases). */
  queryEditor?: { language: string };
  /** When true, a region must be chosen before the root list is meaningful. */
  hasRegionSelector?: boolean;
}

/** Keyed by connector provider id (connector_config.provider). */
export const EXPLORER_DATA_ACCESS_MODELS: Record<string, ExplorerDataAccessModel> = {
  s3: {
    rootAction: 'listBuckets',
    selectionMode: 'single',
    selectableTypes: ['folder'],
  },
  gcs: {
    rootAction: 'listBuckets',
    selectionMode: 'single',
    selectableTypes: ['folder', 'file'],
  },
  postgresql: {
    rootAction: 'listDatabases',
    selectionMode: 'single',
    selectableTypes: ['table', 'view'],
    queryEditor: { language: 'sql' },
  },
  mysql: {
    rootAction: 'listDatabases',
    selectionMode: 'single',
    selectableTypes: ['table', 'view'],
    queryEditor: { language: 'sql' },
  },
  gcp: {
    rootAction: 'listServices',
    selectionMode: 'single',
    selectableTypes: ['volume', 'database', 'instance', 'folder', 'resource', 'file', 'metric_category'],
    hasRegionSelector: true,
  },
  azure_cloud: {
    rootAction: 'listServices',
    selectionMode: 'single',
    selectableTypes: ['metric_category'],
    hasRegionSelector: true,
  },
  ontap: {
    rootAction: 'listServices',
    selectionMode: 'multi',
    selectableTypes: ['volume', 'metric_category'],
  },
  redash: {
    rootAction: 'listRootFolders',
    selectionMode: 'single',
    selectableTypes: ['query', 'dashboard', 'table'],
  },
};

/**
 * Resolves the data access model for a connector by provider id. Falls back to a
 * conservative single-select path model so unknown/new providers still browse.
 */
export function resolveDataAccessModel(
  provider: string | null | undefined,
  scope?: 'account' | 'resource' | null,
): ExplorerDataAccessModel {
  const known = provider ? EXPLORER_DATA_ACCESS_MODELS[provider.toLowerCase()] : undefined;
  if (known) return known;
  return {
    rootAction: scope === 'account' ? 'listServices' : 'listPath',
    selectionMode: 'single',
    selectableTypes: ['folder', 'file'],
  };
}

/**
 * Selection mode for the current explorer level. Metric-category lists allow
 * multi-select on GCP and Azure (ANF) even though those providers are otherwise
 * single-select; ONTAP is multi everywhere.
 */
export function resolveEffectiveSelectionMode(
  model: ExplorerDataAccessModel,
  currentListAction: string,
): ExplorerSelectionMode {
  if (model.selectionMode === 'multi') {
    return 'multi';
  }
  if (currentListAction === METRIC_CATEGORY_LIST_ACTION) {
    return 'multi';
  }
  return 'single';
}

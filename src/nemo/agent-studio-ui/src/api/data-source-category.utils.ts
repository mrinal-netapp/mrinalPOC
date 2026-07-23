import type { DataSourceCategory } from './data-source.types';

/**
 * Maps backend `connector_config.connector_type` → frontend `DataSourceCategory`.
 * `cloud` and `storage` both resolve to Storage System (account-scoped discovery),
 * distinct from resource-scoped object stores.
 */
export function connectorTypeToDataSourceCategory(
  connectorType: string | null | undefined,
): DataSourceCategory | null {
  switch (String(connectorType ?? '').toLowerCase()) {
    case 'objectstore':
      return 'Object Store';
    case 'cloud':
    case 'storage':
      return 'Storage System';
    case 'database':
      return 'Database';
    case 'api':
      return 'API';
    default:
      return null;
  }
}

/** User-facing labels for {@link DataSourceCategory} (detail, list, summary cards). */
export const DATA_SOURCE_CATEGORY_DISPLAY_LABELS: Record<DataSourceCategory, string> = {
  Volume: 'Volume',
  'Object Store': 'Object store',
  Database: 'Database',
  'Storage System': 'Storage system',
  API: 'API',
};

export function formatDataSourceCategoryLabel(
  category: DataSourceCategory | null | undefined,
): string | null {
  if (!category) return null;
  return DATA_SOURCE_CATEGORY_DISPLAY_LABELS[category] ?? category;
}

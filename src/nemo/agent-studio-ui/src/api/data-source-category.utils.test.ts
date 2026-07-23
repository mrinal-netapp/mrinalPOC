import { describe, it, expect } from 'vitest';

import {
  connectorTypeToDataSourceCategory,
  formatDataSourceCategoryLabel,
} from './data-source-category.utils';

describe('connectorTypeToDataSourceCategory', () => {
  it('maps objectstore to Object Store', () => {
    expect(connectorTypeToDataSourceCategory('objectstore')).toBe('Object Store');
  });

  it('maps cloud and storage to Storage System', () => {
    expect(connectorTypeToDataSourceCategory('cloud')).toBe('Storage System');
    expect(connectorTypeToDataSourceCategory('storage')).toBe('Storage System');
  });

  it('maps database and api to their categories', () => {
    expect(connectorTypeToDataSourceCategory('database')).toBe('Database');
    expect(connectorTypeToDataSourceCategory('api')).toBe('API');
  });

  it('returns null for unknown or missing connector types', () => {
    expect(connectorTypeToDataSourceCategory('nope')).toBeNull();
    expect(connectorTypeToDataSourceCategory(null)).toBeNull();
    expect(connectorTypeToDataSourceCategory(undefined)).toBeNull();
  });
});

describe('formatDataSourceCategoryLabel', () => {
  it('returns user-facing labels for each category', () => {
    expect(formatDataSourceCategoryLabel('Storage System')).toBe('Storage system');
    expect(formatDataSourceCategoryLabel('Object Store')).toBe('Object store');
    expect(formatDataSourceCategoryLabel('Database')).toBe('Database');
    expect(formatDataSourceCategoryLabel('API')).toBe('API');
    expect(formatDataSourceCategoryLabel('Volume')).toBe('Volume');
  });

  it('returns null for missing category', () => {
    expect(formatDataSourceCategoryLabel(null)).toBeNull();
    expect(formatDataSourceCategoryLabel(undefined)).toBeNull();
  });
});

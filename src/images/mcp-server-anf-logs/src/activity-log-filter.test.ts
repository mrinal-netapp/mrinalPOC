import { describe, expect, it } from 'vitest';
import {
  ActivityLogFilterError,
  buildActivityLogFilter,
  buildEntryPredicate,
  eventTypeToken,
  levelRank,
  normalizeCategory,
  normalizeLevel,
  resolveScope,
  resourceTypeSegment,
} from './activity-log-filter.js';
import type { ProjectedActivityLogEntry } from './logs-handler.js';

const WINDOW = { startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-02T00:00:00Z' };

describe('buildActivityLogFilter', () => {
  it('requires startTime and endTime', () => {
    expect(() => buildActivityLogFilter({ endTime: WINDOW.endTime })).toThrow(ActivityLogFilterError);
    expect(() => buildActivityLogFilter({ startTime: WINDOW.startTime })).toThrow(
      ActivityLogFilterError
    );
  });

  it('defaults to the NetApp resource provider scope', () => {
    const filter = buildActivityLogFilter({ ...WINDOW });
    expect(filter).toContain("eventTimestamp ge '2026-01-01T00:00:00Z'");
    expect(filter).toContain("eventTimestamp le '2026-01-02T00:00:00Z'");
    expect(filter).toContain("resourceProvider eq 'Microsoft.NetApp'");
  });

  it('uses a resource-group scope when provided', () => {
    const filter = buildActivityLogFilter({ ...WINDOW, resourceGroup: 'anf-rg' });
    expect(filter).toContain("resourceGroupName eq 'anf-rg'");
    expect(filter).not.toContain('resourceProvider eq');
  });

  it('prefers a resource-uri scope over resource group', () => {
    const uri =
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/a/capacityPools/p/volumes/v';
    const filter = buildActivityLogFilter({ ...WINDOW, resourceGroup: 'rg', resourceUri: uri });
    expect(filter).toContain(`resourceUri eq '${uri}'`);
    expect(filter).not.toContain('resourceGroupName eq');
  });

  it('escapes single quotes in scope values', () => {
    const uri = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/o'brien";
    const filter = buildActivityLogFilter({ ...WINDOW, resourceUri: uri });
    expect(filter).toContain(
      "resourceUri eq '/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/o''brien'"
    );
  });

  it('rejects an invalid timestamp', () => {
    expect(() => buildActivityLogFilter({ startTime: 'not-a-date', endTime: WINDOW.endTime })).toThrow(
      /valid RFC3339/
    );
  });

  it('rejects a resourceUri that is not an ARM id', () => {
    expect(() => buildActivityLogFilter({ ...WINDOW, resourceUri: 'just-a-name' })).toThrow(
      /full ARM resource id/
    );
  });

  it('rejects a resource group with invalid characters', () => {
    expect(() => buildActivityLogFilter({ ...WINDOW, resourceGroup: 'bad/rg' })).toThrow(
      /invalid characters/
    );
  });
});

describe('resolveScope', () => {
  it('resolves provider / resourceGroup / resourceUri', () => {
    expect(resolveScope({})).toBe('provider');
    expect(resolveScope({ resourceGroup: 'rg' })).toBe('resourceGroup');
    expect(resolveScope({ resourceUri: '/subscriptions/x', resourceGroup: 'rg' })).toBe('resourceUri');
  });
});

describe('enum validation helpers', () => {
  it('normalizeLevel accepts known levels case-insensitively and rejects others', () => {
    expect(normalizeLevel('error')).toBe('Error');
    expect(normalizeLevel('CRITICAL')).toBe('Critical');
    expect(() => normalizeLevel('bogus')).toThrow(ActivityLogFilterError);
  });

  it('levelRank orders levels and returns -1 for unknown/missing', () => {
    expect(levelRank('Critical')).toBeGreaterThan(levelRank('Error'));
    expect(levelRank('Error')).toBeGreaterThan(levelRank('Warning'));
    expect(levelRank('Warning')).toBeGreaterThan(levelRank('Informational'));
    expect(levelRank(undefined)).toBe(-1);
    expect(levelRank('nope')).toBe(-1);
  });

  it('normalizeCategory validates against the allow-list', () => {
    expect(normalizeCategory('administrative')).toBe('Administrative');
    expect(() => normalizeCategory('bogus')).toThrow(ActivityLogFilterError);
  });

  it('resourceTypeSegment maps known types and rejects others', () => {
    expect(resourceTypeSegment('volume')).toBe('volumes');
    expect(resourceTypeSegment('capacityPool')).toBe('capacityPools');
    expect(() => resourceTypeSegment('bogus')).toThrow(/Invalid resourceType/);
  });

  it('eventTypeToken maps create/update to write and validates', () => {
    expect(eventTypeToken('create')).toBe('write');
    expect(eventTypeToken('update')).toBe('write');
    expect(eventTypeToken('delete')).toBe('delete');
    expect(() => eventTypeToken('bogus')).toThrow(/Invalid eventType/);
  });
});

const VOL_ID =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/a/capacityPools/p/volumes/v1';

function entry(partial: Partial<ProjectedActivityLogEntry>): ProjectedActivityLogEntry {
  return { resourceId: VOL_ID, ...partial };
}

describe('buildEntryPredicate', () => {
  it('provider scope does not require a NetApp resource-id check', () => {
    const predicate = buildEntryPredicate({});
    expect(predicate(entry({ resourceId: '/subscriptions/s/whatever' }))).toBe(true);
  });

  it('non-provider scope keeps only Microsoft.NetApp resources', () => {
    const predicate = buildEntryPredicate({ resourceGroup: 'rg' });
    expect(predicate(entry({ resourceId: VOL_ID }))).toBe(true);
    expect(
      predicate(entry({ resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/x' }))
    ).toBe(false);
  });

  it('filters by resource type via the resource id segment', () => {
    const predicate = buildEntryPredicate({ resourceType: 'volume' });
    expect(predicate(entry({ resourceId: VOL_ID }))).toBe(true);
    const poolId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/a/capacityPools/p';
    expect(predicate(entry({ resourceId: poolId }))).toBe(false);
  });

  it('filters by minimum level (inclusive)', () => {
    const predicate = buildEntryPredicate({ level: 'Warning' });
    expect(predicate(entry({ level: 'Critical' }))).toBe(true);
    expect(predicate(entry({ level: 'Warning' }))).toBe(true);
    expect(predicate(entry({ level: 'Informational' }))).toBe(false);
  });

  it('filters by category', () => {
    const predicate = buildEntryPredicate({ category: 'Administrative' });
    expect(predicate(entry({ category: 'Administrative' }))).toBe(true);
    expect(predicate(entry({ category: 'ResourceHealth' }))).toBe(false);
  });

  it('failuresOnly keeps failed status or level>=Error', () => {
    const predicate = buildEntryPredicate({ failuresOnly: true });
    expect(predicate(entry({ status: 'Failed', level: 'Informational' }))).toBe(true);
    expect(predicate(entry({ status: 'Succeeded', level: 'Error' }))).toBe(true);
    expect(predicate(entry({ status: 'Succeeded', level: 'Informational' }))).toBe(false);
  });

  it('failuresOnly honors a minLevel override', () => {
    const predicate = buildEntryPredicate({ failuresOnly: true, minLevel: 'Warning' });
    expect(predicate(entry({ status: 'Succeeded', level: 'Warning' }))).toBe(true);
    expect(predicate(entry({ status: 'Succeeded', level: 'Informational' }))).toBe(false);
  });

  it('eventType matches the operation verb suffix', () => {
    const predicate = buildEntryPredicate({ eventType: 'delete' });
    expect(
      predicate(entry({ operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/delete' }))
    ).toBe(true);
    expect(
      predicate(entry({ operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/write' }))
    ).toBe(false);
  });

  it('operationName supports wildcard matching', () => {
    const predicate = buildEntryPredicate({ operationName: '*/volumes/*' });
    expect(
      predicate(entry({ operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/write' }))
    ).toBe(true);
    expect(predicate(entry({ operationName: 'Microsoft.NetApp/netAppAccounts/write' }))).toBe(false);
  });

  it('rejects an operationName with illegal characters', () => {
    expect(() => buildEntryPredicate({ operationName: 'bad name!' })).toThrow(ActivityLogFilterError);
  });

  it('combines multiple predicates with AND', () => {
    const predicate = buildEntryPredicate({ resourceType: 'volume', level: 'Error' });
    expect(predicate(entry({ resourceId: VOL_ID, level: 'Error' }))).toBe(true);
    expect(predicate(entry({ resourceId: VOL_ID, level: 'Informational' }))).toBe(false);
  });
});

/**
 * Azure Monitor Activity Log query builder for Azure NetApp Files (ANF).
 *
 * ANF has no dedicated log API. Logs, errors, and events are surfaced through
 * the Azure Monitor Activity Log (control-plane operations, Resource Health,
 * Service Health, and alerts), scoped to the NetApp resource provider
 * (`Microsoft.NetApp`). These helpers turn a small set of high-level,
 * agent-friendly arguments into:
 *
 *  1. a valid Activity Log `$filter` expression (server-side), and
 *  2. a client-side predicate that applies the filters the Activity Log
 *     `$filter` cannot express.
 *
 * The Activity Log `$filter` is intentionally very restricted: it allows only
 * `eventTimestamp ge/le` plus exactly ONE of `resourceUri eq`,
 * `resourceGroupName eq`, `resourceProvider eq`, or `correlationId eq`. So
 * scope + time are applied server-side and everything else (level, category,
 * resourceType, operationName, failures-only) is applied client-side.
 *
 * Reference: https://learn.microsoft.com/azure/azure-netapp-files/monitor-azure-netapp-files
 */

import type { ProjectedActivityLogEntry } from './logs-handler.js';

/** Azure resource provider that scopes every ANF query. */
export const NETAPP_RESOURCE_PROVIDER = 'Microsoft.NetApp';

/** Lower-cased ARM id segment used to keep client-side results ANF-only. */
export const NETAPP_RESOURCE_ID_SEGMENT = '/providers/microsoft.netapp/';

/**
 * Activity Log event levels, ordered from least to most severe. Rank is used
 * for "minimum level, inclusive" filtering (e.g. minLevel=Warning includes
 * Warning, Error, and Critical).
 */
export const EVENT_LEVELS = ['Verbose', 'Informational', 'Warning', 'Error', 'Critical'] as const;

export type EventLevel = (typeof EVENT_LEVELS)[number];

const LEVEL_RANK: Record<string, number> = {
  verbose: 0,
  informational: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/** Activity Log event categories that can be requested. */
export const EVENT_CATEGORIES = [
  'Administrative',
  'ServiceHealth',
  'ResourceHealth',
  'Alert',
  'Autoscale',
  'Security',
  'Recommendation',
  'Policy',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * Maps an ANF resource kind to the ARM resource-id path segment used for
 * client-side scoping (e.g. volume -> /volumes/).
 */
export const RESOURCE_TYPE_TO_SEGMENT: Record<string, string> = {
  netAppAccount: 'netAppAccounts',
  capacityPool: 'capacityPools',
  volume: 'volumes',
  snapshot: 'snapshots',
  backup: 'backups',
  backupVault: 'backupVaults',
  backupPolicy: 'backupPolicies',
  volumeQuotaRule: 'volumeQuotaRules',
  snapshotPolicy: 'snapshotPolicies',
};

export type AnfResourceType = keyof typeof RESOURCE_TYPE_TO_SEGMENT;

/**
 * Maps a high-level event type to the Azure operation verb that terminates an
 * `operationName` (e.g. `Microsoft.NetApp/.../volumes/write`). Azure has no
 * distinct create verb — both create and update map to `write`.
 */
export const EVENT_TYPE_TO_OPERATION_TOKEN: Record<string, string> = {
  create: 'write',
  update: 'write',
  write: 'write',
  delete: 'delete',
  action: 'action',
  read: 'read',
};

export type AnfEventType = keyof typeof EVENT_TYPE_TO_OPERATION_TOKEN;

/** Scope clause chosen for the server-side `$filter`. */
export type ActivityLogScope = 'resourceUri' | 'resourceGroup' | 'provider';

export interface ActivityLogQueryOptions {
  /** Full ARM id of an ANF resource (netAppAccount/pool/volume/...). */
  resourceUri?: string;
  /** Resource group name to scope the query to. */
  resourceGroup?: string;
  /** Restrict to a single ANF resource kind (client-side, via resource id). */
  resourceType?: string;
  /** Inclusive lower time bound (RFC3339). Required for the Activity Log. */
  startTime?: string;
  /** Inclusive upper time bound (RFC3339). */
  endTime?: string;
  /** Minimum level, inclusive (logs tool). */
  level?: string;
  /** Restrict to a single event category (client-side). */
  category?: string;
  /** When true, keep only failures (errors tool). */
  failuresOnly?: boolean;
  /** Minimum level for the errors tool (defaults to Error; failures always kept). */
  minLevel?: string;
  /** High-level event category mapped to an operation verb (events tool). */
  eventType?: string;
  /** operationName substring / glob (`*`) match (events tool). */
  operationName?: string;
}

/** Thrown when an argument cannot be turned into a safe query. */
export class ActivityLogFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityLogFilterError';
  }
}

/** Escape a value for use inside a single-quoted OData string literal. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Normalize and validate an event level argument. */
export function normalizeLevel(level: string): EventLevel {
  const key = level.trim().toLowerCase();
  const match = EVENT_LEVELS.find((l) => l.toLowerCase() === key);
  if (!match) {
    throw new ActivityLogFilterError(
      `Invalid level "${level}". Expected one of: ${EVENT_LEVELS.join(', ')}.`
    );
  }
  return match;
}

/** Return the severity rank of a level (higher = more severe), or -1 if unknown. */
export function levelRank(level?: string): number {
  if (!level) return -1;
  const rank = LEVEL_RANK[level.trim().toLowerCase()];
  return rank === undefined ? -1 : rank;
}

/** Normalize and validate an event category argument. */
export function normalizeCategory(category: string): EventCategory {
  const key = category.trim().toLowerCase();
  const match = EVENT_CATEGORIES.find((c) => c.toLowerCase() === key);
  if (!match) {
    throw new ActivityLogFilterError(
      `Invalid category "${category}". Expected one of: ${EVENT_CATEGORIES.join(', ')}.`
    );
  }
  return match;
}

/** Validate a resource type and return its ARM path segment. */
export function resourceTypeSegment(resourceType: string): string {
  const segment = RESOURCE_TYPE_TO_SEGMENT[resourceType];
  if (!segment) {
    throw new ActivityLogFilterError(
      `Invalid resourceType "${resourceType}". Expected one of: ${Object.keys(
        RESOURCE_TYPE_TO_SEGMENT
      ).join(', ')}.`
    );
  }
  return segment;
}

/** Validate the event type and return its Azure operation verb token. */
export function eventTypeToken(eventType: string): string {
  const token = EVENT_TYPE_TO_OPERATION_TOKEN[eventType.trim().toLowerCase()];
  if (!token) {
    throw new ActivityLogFilterError(
      `Invalid eventType "${eventType}". Expected one of: ${Object.keys(
        EVENT_TYPE_TO_OPERATION_TOKEN
      ).join(', ')}.`
    );
  }
  return token;
}

/** Validate an RFC3339 / ISO-8601 timestamp and return it unchanged. */
function validateTimestamp(label: string, value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ActivityLogFilterError(`${label} must be a valid RFC3339 timestamp (got "${value}").`);
  }
  return value;
}

/** Validate a resource group name (ARM naming charset). */
function validateResourceGroup(rg: string): string {
  const trimmed = rg.trim();
  if (!/^[A-Za-z0-9._()\- ]+$/.test(trimmed)) {
    throw new ActivityLogFilterError('resourceGroup contains invalid characters.');
  }
  return trimmed;
}

/** Validate a resource URI (ARM id). */
function validateResourceUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('/subscriptions/')) {
    throw new ActivityLogFilterError(
      'resourceUri must be a full ARM resource id starting with "/subscriptions/".'
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ActivityLogFilterError('resourceUri must not contain control characters.');
  }
  return trimmed;
}

/** Compile an operationName glob (`*`) into a case-insensitive RegExp. */
function operationNameToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!/^[A-Za-z0-9_./*-]+$/.test(trimmed)) {
    throw new ActivityLogFilterError(
      'operationName may only contain letters, digits, ".", "/", "_", "-" and "*".'
    );
  }
  const body = trimmed
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(body, 'i');
}

/** Resolve which server-side scope clause applies, given the query options. */
export function resolveScope(options: ActivityLogQueryOptions): ActivityLogScope {
  if (options.resourceUri && options.resourceUri.trim()) return 'resourceUri';
  if (options.resourceGroup && options.resourceGroup.trim()) return 'resourceGroup';
  return 'provider';
}

/**
 * Build the Activity Log `$filter` expression (server-side). Always includes a
 * time range and exactly one scope clause. The returned string is the filter
 * expression only (the SDK adds the `$filter=` prefix).
 */
export function buildActivityLogFilter(options: ActivityLogQueryOptions = {}): string {
  if (!options.startTime) {
    throw new ActivityLogFilterError('startTime is required to query the Activity Log.');
  }
  if (!options.endTime) {
    throw new ActivityLogFilterError('endTime is required to query the Activity Log.');
  }

  const start = validateTimestamp('startTime', options.startTime);
  const end = validateTimestamp('endTime', options.endTime);

  const clauses: string[] = [
    `eventTimestamp ge ${quote(start)}`,
    `eventTimestamp le ${quote(end)}`,
  ];

  switch (resolveScope(options)) {
    case 'resourceUri':
      clauses.push(`resourceUri eq ${quote(validateResourceUri(options.resourceUri as string))}`);
      break;
    case 'resourceGroup':
      clauses.push(
        `resourceGroupName eq ${quote(validateResourceGroup(options.resourceGroup as string))}`
      );
      break;
    default:
      clauses.push(`resourceProvider eq ${quote(NETAPP_RESOURCE_PROVIDER)}`);
      break;
  }

  return clauses.join(' and ');
}

/**
 * Build the client-side predicate that applies every filter the Activity Log
 * `$filter` cannot express (NetApp scope when not provider-scoped, resourceType,
 * level/minLevel, category, failures-only, eventType, operationName). Validates
 * all enum arguments eagerly, throwing {@link ActivityLogFilterError}.
 */
export function buildEntryPredicate(
  options: ActivityLogQueryOptions = {}
): (entry: ProjectedActivityLogEntry) => boolean {
  const predicates: Array<(entry: ProjectedActivityLogEntry) => boolean> = [];

  // Keep results ANF-only when the server-side scope is not the NetApp provider
  // (i.e. a resource-group or resource-uri scope could include other providers).
  if (resolveScope(options) !== 'provider') {
    predicates.push((e) =>
      (e.resourceId ?? '').toLowerCase().includes(NETAPP_RESOURCE_ID_SEGMENT)
    );
  }

  if (options.resourceType) {
    const segment = resourceTypeSegment(options.resourceType).toLowerCase();
    const needle = `/${segment}/`;
    predicates.push((e) => (e.resourceId ?? '').toLowerCase().includes(needle));
  }

  if (options.category) {
    const category = normalizeCategory(options.category).toLowerCase();
    predicates.push((e) => (e.category ?? '').toLowerCase() === category);
  }

  if (options.failuresOnly) {
    const floor = options.minLevel ? levelRank(normalizeLevel(options.minLevel)) : levelRank('Error');
    predicates.push(
      (e) => (e.status ?? '').toLowerCase() === 'failed' || levelRank(e.level) >= floor
    );
  } else if (options.level) {
    const floor = levelRank(normalizeLevel(options.level));
    predicates.push((e) => levelRank(e.level) >= floor);
  }

  if (options.eventType) {
    const token = `/${eventTypeToken(options.eventType)}`;
    predicates.push((e) => (e.operationName ?? '').toLowerCase().endsWith(token));
  }

  if (options.operationName) {
    const re = operationNameToRegExp(options.operationName);
    predicates.push((e) => re.test(e.operationName ?? ''));
  }

  return (entry) => predicates.every((p) => p(entry));
}

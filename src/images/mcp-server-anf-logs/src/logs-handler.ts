import { ToolHandler } from './types.js';
import { MonitorClientFactory } from './monitor-client-factory.js';
import {
  buildActivityLogFilter,
  buildEntryPredicate,
  levelRank,
  ActivityLogQueryOptions,
} from './activity-log-filter.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'logs-handler' });

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_SUMMARY_MAX = 500;
const MAX_SUMMARY_MAX = 1000;

/** A compact, agent-friendly projection of an Activity Log `EventData`. */
export interface ProjectedActivityLogEntry {
  timestamp?: string;
  level?: string;
  operationName?: string;
  status?: string;
  subStatus?: string;
  resourceId?: string;
  resourceType?: string;
  resourceGroup?: string;
  caller?: string;
  category?: string;
  correlationId?: string;
  eventName?: string;
  description?: string;
  summary?: string;
}

/** A page of Activity Log entries as returned by `byPage()`. */
type ActivityLogPage = any[] & { continuationToken?: string };

/** Read an Azure `LocalizableString` (or plain string) into a plain string. */
function lstr(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value || undefined;
  return value.value || value.localizedValue || undefined;
}

/** Normalize an Activity Log timestamp (Date | string) to RFC3339. */
function toIsoString(ts: any): string | undefined {
  if (!ts) return undefined;
  if (typeof ts === 'string') return ts;
  if (ts instanceof Date) return ts.toISOString();
  try {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Project an Activity Log `EventData` into the compact shape returned to
 * callers. Azure exposes several fields as `LocalizableString` ({ value }).
 */
export function projectEntry(event: any): ProjectedActivityLogEntry {
  const e = event ?? {};

  const operationName = lstr(e.operationName);
  const status = lstr(e.status);
  const resourceId: string | undefined = e.resourceId || undefined;

  const result: ProjectedActivityLogEntry = {
    timestamp: toIsoString(e.eventTimestamp),
    level: e.level || undefined,
    operationName,
    status,
    subStatus: lstr(e.subStatus),
    resourceId,
    resourceType: lstr(e.resourceType),
    resourceGroup: e.resourceGroupName || undefined,
    caller: e.caller || undefined,
    category: lstr(e.category),
    correlationId: e.correlationId || undefined,
    eventName: lstr(e.eventName),
    description: e.description || undefined,
  };

  const shortOp = operationName ? operationName.split('/').slice(-2).join('/') : undefined;
  const shortResource = resourceId ? resourceId.split('/').pop() : undefined;
  const outcome = isFailure(result) ? `FAILED: ${status || 'error'}` : status || 'ok';
  result.summary = [shortOp, shortResource, `(${outcome})`].filter(Boolean).join(' ');

  return result;
}

/** True when an entry represents a failure (status Failed or level >= Error). */
export function isFailure(entry: ProjectedActivityLogEntry): boolean {
  if ((entry.status ?? '').toLowerCase() === 'failed') return true;
  return levelRank(entry.level) >= levelRank('Error');
}

/** Clamp a requested page size into the allowed range. */
function resolvePageSize(
  requested: unknown,
  fallback = DEFAULT_PAGE_SIZE,
  max = MAX_PAGE_SIZE
): number {
  const n =
    typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : fallback;
  return Math.min(Math.max(n, 1), max);
}

/**
 * Resolve the effective time window. The Activity Log filter requires both
 * bounds, so a missing side is defaulted (last 24h / now). Explicit caller
 * values are passed through unchanged and validated by the filter builder; the
 * Activity Log only retains ~90 days, so older windows simply return nothing.
 */
function resolveTimeWindow(
  startTime?: string,
  endTime?: string
): { startTime: string; endTime: string } {
  if (startTime && endTime) {
    return { startTime, endTime };
  }
  const now = Date.now();
  if (startTime) {
    return { startTime, endTime: new Date(now).toISOString() };
  }
  if (endTime) {
    const endMs = Date.parse(endTime);
    const base = Number.isNaN(endMs) ? now : endMs;
    return { startTime: new Date(base - DEFAULT_WINDOW_MS).toISOString(), endTime };
  }
  return {
    startTime: new Date(now - DEFAULT_WINDOW_MS).toISOString(),
    endTime: new Date(now).toISOString(),
  };
}

/** Resolve the subscription id from args or the server's default env var. */
function resolveSubscriptionId(args: { [key: string]: any }): string | undefined {
  const fromArgs = typeof args.subscriptionId === 'string' ? args.subscriptionId.trim() : '';
  if (fromArgs) return fromArgs;
  const fromEnv = (process.env.AZURE_SUBSCRIPTION_ID || '').trim();
  return fromEnv || undefined;
}

function errorResult(message: string, structuredExtra: Record<string, any>) {
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { error: message.replace(/^Error[^:]*:\s*/, ''), ...structuredExtra },
    isError: true,
  };
}

/** Order projected entries by timestamp (default desc). */
function sortEntries(entries: ProjectedActivityLogEntry[], orderBy?: string): ProjectedActivityLogEntry[] {
  const asc = orderBy === 'timestamp asc';
  return entries.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return asc ? ta - tb : tb - ta;
  });
}

/**
 * Shared list implementation for the logs/errors/events tools. Builds the
 * server-side `$filter` and the client-side predicate, fetches a single page
 * of Activity Log entries, projects + filters them, and returns the next page
 * token for continuation.
 */
async function listEntries(
  args: { [key: string]: any },
  overrides: Partial<ActivityLogQueryOptions>
) {
  const subscriptionId = resolveSubscriptionId(args);
  if (!subscriptionId) {
    return errorResult('Error: subscriptionId is required (or set AZURE_SUBSCRIPTION_ID)', {
      entries: [],
      count: 0,
    });
  }

  const { startTime, endTime } = resolveTimeWindow(args.startTime, args.endTime);

  const queryOptions: ActivityLogQueryOptions = {
    resourceUri: args.resourceUri,
    resourceGroup: args.resourceGroup,
    resourceType: args.resourceType,
    startTime,
    endTime,
    level: args.level,
    category: args.category,
    eventType: args.eventType,
    operationName: args.operationName,
    minLevel: args.minLevel,
    ...overrides,
  };

  let filter: string;
  let predicate: (entry: ProjectedActivityLogEntry) => boolean;
  try {
    filter = buildActivityLogFilter(queryOptions);
    predicate = buildEntryPredicate(queryOptions);
  } catch (err: any) {
    return errorResult(`Error: ${err.message}`, { entries: [], count: 0 });
  }

  const pageSize = resolvePageSize(args.pageSize);

  try {
    const client = MonitorClientFactory.createClient(subscriptionId);
    const pageable = client.activityLogs.list(filter);
    const iterator = pageable.byPage({
      maxPageSize: pageSize,
      ...(args.pageToken ? { continuationToken: args.pageToken } : {}),
    });

    const { value } = await iterator.next();
    const page = (value ?? []) as ActivityLogPage;
    const nextPageToken: string | undefined = page.continuationToken || undefined;

    const projected = sortEntries(
      page.map(projectEntry).filter(predicate),
      args.orderBy
    );

    log.info({ count: projected.length, hasNext: Boolean(nextPageToken) }, 'Listed ANF log entries');

    const structuredContent = {
      entries: projected,
      count: projected.length,
      filter,
      nextPageToken,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error: any) {
    log.error({ err: error }, 'Error listing ANF log entries');
    return errorResult(`Error listing ANF log entries: ${error?.message || 'Unknown error'}`, {
      entries: [],
      count: 0,
      filter,
    });
  }
}

// List ANF Logs Handler
export const listAnfLogsHandler: ToolHandler = async (args) => listEntries(args, {});

// List ANF Errors Handler
export const listAnfErrorsHandler: ToolHandler = async (args) =>
  listEntries(args, { failuresOnly: true, minLevel: args.minLevel });

// List ANF Events Handler
export const listAnfEventsHandler: ToolHandler = async (args) =>
  listEntries(args, {
    eventType: args.eventType,
    operationName: args.operationName,
    // Keep events distinct from logs: when the caller gives neither eventType
    // nor operationName, default to control-plane admin-activity events.
    category: args.eventType || args.operationName ? undefined : 'Administrative',
  });

// ANF Log Summary Handler
export const anfLogSummaryHandler: ToolHandler = async (args) => {
  const subscriptionId = resolveSubscriptionId(args);
  if (!subscriptionId) {
    return errorResult('Error: subscriptionId is required (or set AZURE_SUBSCRIPTION_ID)', {
      totalEntries: 0,
    });
  }

  const { startTime, endTime } = resolveTimeWindow(args.startTime, args.endTime);

  const queryOptions: ActivityLogQueryOptions = {
    resourceUri: args.resourceUri,
    resourceGroup: args.resourceGroup,
    resourceType: args.resourceType,
    startTime,
    endTime,
    level: args.level,
    category: args.category,
  };

  let filter: string;
  let predicate: (entry: ProjectedActivityLogEntry) => boolean;
  try {
    filter = buildActivityLogFilter(queryOptions);
    predicate = buildEntryPredicate(queryOptions);
  } catch (err: any) {
    return errorResult(`Error: ${err.message}`, { totalEntries: 0 });
  }

  const maxEntries = resolvePageSize(args.maxEntries, DEFAULT_SUMMARY_MAX, MAX_SUMMARY_MAX);

  try {
    const client = MonitorClientFactory.createClient(subscriptionId);
    const iterator = client.activityLogs.list(filter).byPage({ maxPageSize: MAX_PAGE_SIZE });

    const byLevel: Record<string, number> = {};
    const byOperation: Record<string, number> = {};
    const byResource: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let totalEntries = 0;
    let failureCount = 0;
    let truncated = false;

    while (totalEntries < maxEntries) {
      const { value, done } = await iterator.next();
      if (done) break;
      const page = (value ?? []) as ActivityLogPage;

      for (const raw of page) {
        const p = projectEntry(raw);
        if (!predicate(p)) continue;

        totalEntries++;
        const lvl = p.level || 'Unknown';
        byLevel[lvl] = (byLevel[lvl] || 0) + 1;
        if (p.operationName) byOperation[p.operationName] = (byOperation[p.operationName] || 0) + 1;
        if (p.resourceId) byResource[p.resourceId] = (byResource[p.resourceId] || 0) + 1;
        if (p.category) byCategory[p.category] = (byCategory[p.category] || 0) + 1;
        if (isFailure(p)) failureCount++;

        if (totalEntries >= maxEntries) {
          truncated = Boolean(page.continuationToken);
          break;
        }
      }

      if (totalEntries >= maxEntries) {
        truncated = truncated || Boolean(page.continuationToken);
        break;
      }
      if (!page.continuationToken) break;
    }

    const structuredContent = {
      totalEntries,
      failureCount,
      timeRange: { startTime, endTime },
      byLevel,
      byOperation,
      byResource,
      byCategory,
      truncated,
      filter,
    };

    log.info({ totalEntries, failureCount, truncated }, 'Summarized ANF log entries');

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error: any) {
    log.error({ err: error }, 'Error summarizing ANF log entries');
    return errorResult(`Error summarizing ANF log entries: ${error?.message || 'Unknown error'}`, {
      totalEntries: 0,
      filter,
    });
  }
};

/**
 * Handlers for the GCNV logs / errors / events tools.
 *
 * NOTE ON DATA SOURCE: "logs", "errors", and "events" are NOT separate Google
 * Cloud APIs. They are all Cloud Logging log entries for the NetApp service
 * (protoPayload.serviceName="netapp.googleapis.com"), fetched through the same
 * `@google-cloud/logging` SDK and the same `getEntries()` call (entries.list).
 * The tools differ only by the filter they build:
 *   - logs   -> base filter (+ optional severity / resource / free text)
 *   - errors -> base filter + (severity>=ERROR OR protoPayload.status.code!=0)
 *   - events -> base filter + protoPayload.methodName=~"<Create|Update|Delete|...>"
 *   - summary-> base filter, then client-side aggregation across pages
 *
 * This deliberately does NOT use Google's separate Cloud Error Reporting product
 * (the @google-cloud/error-reporting SDK), which groups application stack-trace
 * errors. GCNV failures surface as audit-log entries with status codes, so a
 * Cloud Logging severity/status filter is sufficient and needs no second SDK.
 */
import { ToolHandler } from './types.js';
import { LoggingClientFactory } from './logging-client-factory.js';
import {
  buildGcnvLogFilter,
  BuildLogFilterOptions,
  EVENT_TYPE_TO_METHOD_TOKEN,
} from './logging-filter.js';
import { logger } from './logger.js';

// Default "events" filter applied when gcnv_events_list is called without an
// eventType or methodName, so it stays distinct from gcnv_logs_list: match the
// admin-activity lifecycle methods (Create/Update/Delete/...).
const DEFAULT_EVENT_METHODS_CLAUSE = `protoPayload.methodName=~"(${[
  ...new Set(Object.values(EVENT_TYPE_TO_METHOD_TOKEN)),
].join('|')})"`;

const log = logger.child({ module: 'logs-handler' });

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_SUMMARY_MAX = 500;
const MAX_SUMMARY_MAX = 1000;

/** A compact, agent-friendly projection of a Cloud Logging entry. */
export interface ProjectedLogEntry {
  timestamp?: string;
  severity?: string;
  methodName?: string;
  resourceName?: string;
  principal?: string;
  statusCode?: number;
  statusMessage?: string;
  operationId?: string;
  logName?: string;
  summary?: string;
}

/** Normalize a Logging timestamp (ITimestamp | Date | string) to RFC3339. */
function toIsoString(ts: any): string | undefined {
  if (!ts) return undefined;
  if (typeof ts === 'string') return ts;
  if (ts instanceof Date) return ts.toISOString();
  // protobuf ITimestamp { seconds, nanos }
  if (typeof ts === 'object' && ts.seconds != null) {
    const seconds = Number(ts.seconds);
    const millis = seconds * 1000 + Math.floor(Number(ts.nanos ?? 0) / 1e6);
    return new Date(millis).toISOString();
  }
  try {
    return new Date(ts).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Project a `@google-cloud/logging` Entry into the compact shape returned to
 * callers. `entry.metadata` carries the LogEntry envelope; `entry.data` carries
 * the payload (the audit `protoPayload` for GCNV audit logs).
 */
export function projectEntry(entry: any): ProjectedLogEntry {
  const meta = entry?.metadata ?? entry ?? {};
  const payload = entry?.data ?? meta.protoPayload ?? meta.jsonPayload ?? {};

  const methodName: string | undefined = payload?.methodName;
  const resourceName: string | undefined = payload?.resourceName;
  const principal: string | undefined = payload?.authenticationInfo?.principalEmail;
  const status = payload?.status ?? {};
  const statusCode: number | undefined = typeof status.code === 'number' ? status.code : undefined;
  const statusMessage: string | undefined = status.message || undefined;
  const operationId: string | undefined = meta?.operation?.id || undefined;
  const severity: string | undefined =
    typeof meta.severity === 'number' ? String(meta.severity) : meta.severity || undefined;

  const result: ProjectedLogEntry = {
    timestamp: toIsoString(meta.timestamp),
    severity,
    methodName,
    resourceName,
    principal,
    statusCode,
    statusMessage,
    operationId,
    logName: meta.logName || undefined,
  };

  const shortMethod = methodName ? methodName.split('.').pop() : undefined;
  const outcome = statusCode && statusCode !== 0 ? `FAILED: ${statusMessage || 'error'}` : 'ok';
  result.summary = [shortMethod, resourceName, `(${outcome})`].filter(Boolean).join(' ');

  return result;
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
 * Resolve the effective time window. A missing bound is filled so callers never
 * generate an unbounded query: endTime defaults to now, and startTime defaults
 * to 24h before endTime (matching the tool-schema docs).
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

function errorResult(message: string, structuredExtra: Record<string, any>) {
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { error: message.replace(/^Error[^:]*:\s*/, ''), ...structuredExtra },
    isError: true,
  };
}

/**
 * Shared list implementation for the logs/errors/events tools. Builds the
 * filter, runs a single page of `getEntries`, projects entries, and returns the
 * next page token.
 */
async function listEntries(
  args: { [key: string]: any },
  filterOverrides: Partial<BuildLogFilterOptions>
) {
  const { projectId } = args;
  if (!projectId) {
    return errorResult('Error: projectId is required', { entries: [], count: 0 });
  }

  const { startTime, endTime } = resolveTimeWindow(args.startTime, args.endTime);

  let filter: string;
  try {
    filter = buildGcnvLogFilter({
      location: args.location,
      resourceType: args.resourceType,
      resourceName: args.resourceName,
      startTime,
      endTime,
      minSeverity: args.severity,
      methodName: args.methodName,
      eventType: args.eventType,
      freeTextFilter: args.freeTextFilter,
      ...filterOverrides,
    });
  } catch (err: any) {
    return errorResult(`Error: ${err.message}`, { entries: [], count: 0 });
  }

  const pageSize = resolvePageSize(args.pageSize);
  const orderBy = args.orderBy === 'timestamp asc' ? 'timestamp asc' : 'timestamp desc';

  try {
    const logging = LoggingClientFactory.createClient(projectId);
    const [entries, , apiResponse] = await logging.getEntries({
      resourceNames: [`projects/${projectId}`],
      filter,
      orderBy,
      pageSize,
      autoPaginate: false,
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    });

    const projected = (entries ?? []).map(projectEntry);
    const nextPageToken: string | undefined = (apiResponse as any)?.nextPageToken || undefined;

    log.info(
      { count: projected.length, hasNext: Boolean(nextPageToken) },
      'Listed GCNV log entries'
    );

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
    log.error({ err: error }, 'Error listing GCNV log entries');
    return errorResult(`Error listing GCNV log entries: ${error.message || 'Unknown error'}`, {
      entries: [],
      count: 0,
      filter,
    });
  }
}

// List GCNV Logs Handler
export const listGcnvLogsHandler: ToolHandler = async (args) => listEntries(args, {});

// List GCNV Errors Handler
export const listGcnvErrorsHandler: ToolHandler = async (args) =>
  listEntries(args, {
    failuresOnly: true,
    minSeverity: args.minSeverity,
  });

// List GCNV Events Handler
export const listGcnvEventsHandler: ToolHandler = async (args) =>
  listEntries(args, {
    eventType: args.eventType,
    methodName: args.methodName,
    // Keep events distinct from logs: when the caller gives neither eventType
    // nor methodName, default to the admin-activity lifecycle methods.
    freeTextFilter:
      args.eventType || args.methodName ? undefined : DEFAULT_EVENT_METHODS_CLAUSE,
  });

// GCNV Log Summary Handler
export const gcnvLogSummaryHandler: ToolHandler = async (args) => {
  const { projectId } = args;
  if (!projectId) {
    return errorResult('Error: projectId is required', { totalEntries: 0 });
  }

  const { startTime, endTime } = resolveTimeWindow(args.startTime, args.endTime);

  let filter: string;
  try {
    filter = buildGcnvLogFilter({
      location: args.location,
      resourceType: args.resourceType,
      resourceName: args.resourceName,
      startTime,
      endTime,
      minSeverity: args.severity,
    });
  } catch (err: any) {
    return errorResult(`Error: ${err.message}`, { totalEntries: 0 });
  }

  const maxEntries = resolvePageSize(args.maxEntries, DEFAULT_SUMMARY_MAX, MAX_SUMMARY_MAX);

  try {
    const logging = LoggingClientFactory.createClient(projectId);

    const bySeverity: Record<string, number> = {};
    const byMethod: Record<string, number> = {};
    const byResource: Record<string, number> = {};
    let totalEntries = 0;
    let failureCount = 0;
    let pageToken: string | undefined;
    let truncated = false;

    while (totalEntries < maxEntries) {
      const remaining = maxEntries - totalEntries;
      const [entries, , apiResponse] = await logging.getEntries({
        resourceNames: [`projects/${projectId}`],
        filter,
        orderBy: 'timestamp desc',
        pageSize: Math.min(remaining, MAX_PAGE_SIZE),
        autoPaginate: false,
        ...(pageToken ? { pageToken } : {}),
      });

      for (const entry of entries ?? []) {
        const p = projectEntry(entry);
        totalEntries++;
        const sev = p.severity || 'UNKNOWN';
        bySeverity[sev] = (bySeverity[sev] || 0) + 1;
        if (p.methodName) byMethod[p.methodName] = (byMethod[p.methodName] || 0) + 1;
        if (p.resourceName) byResource[p.resourceName] = (byResource[p.resourceName] || 0) + 1;
        if (p.statusCode && p.statusCode !== 0) failureCount++;
      }

      pageToken = (apiResponse as any)?.nextPageToken || undefined;
      if (!pageToken) break;
      if (totalEntries >= maxEntries) {
        truncated = true;
        break;
      }
    }

    const structuredContent = {
      totalEntries,
      failureCount,
      timeRange: { startTime, endTime },
      bySeverity,
      byMethod,
      byResource,
      truncated,
      filter,
    };

    log.info({ totalEntries, failureCount, truncated }, 'Summarized GCNV log entries');

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error: any) {
    log.error({ err: error }, 'Error summarizing GCNV log entries');
    return errorResult(`Error summarizing GCNV log entries: ${error.message || 'Unknown error'}`, {
      totalEntries: 0,
      filter,
    });
  }
};

import { z } from 'zod';
import { ToolConfig } from './types.js';
import {
  EVENT_LEVELS,
  EVENT_CATEGORIES,
  RESOURCE_TYPE_TO_SEGMENT,
  EVENT_TYPE_TO_OPERATION_TOKEN,
} from './activity-log-filter.js';

/**
 * Tool schemas for reading Azure NetApp Files (ANF) logs, errors, and events
 * from the Azure Monitor Activity Log.
 *
 * ANF exposes no dedicated log API; these tools query the Activity Log scoped
 * to the NetApp resource provider (`Microsoft.NetApp`) and build the `$filter`
 * internally, so callers never write the OData filter DSL. Filters the Activity
 * Log `$filter` cannot express (level, category, resourceType, operationName)
 * are applied client-side after fetching.
 */

const resourceTypeEnum = Object.keys(RESOURCE_TYPE_TO_SEGMENT) as [string, ...string[]];
const levelEnum = [...EVENT_LEVELS] as [string, ...string[]];
const categoryEnum = [...EVENT_CATEGORIES] as [string, ...string[]];
const eventTypeEnum = Object.keys(EVENT_TYPE_TO_OPERATION_TOKEN) as [string, ...string[]];
// Errors-tool floor: only Error and above. Allowing Informational/Warning here
// would make anf_errors_list return non-error entries and defeat its purpose.
const errorLevelEnum = EVENT_LEVELS.slice(EVENT_LEVELS.indexOf('Error')) as unknown as [
  string,
  ...string[],
];

/** Shared output shape for a single projected Activity Log entry. */
const logEntryShape = z.object({
  timestamp: z.string().optional().describe('Event timestamp (RFC3339)'),
  level: z.string().optional().describe('Event level (Critical/Error/Warning/Informational/Verbose)'),
  operationName: z.string().optional().describe('ARM operation name (e.g. .../volumes/write)'),
  status: z.string().optional().describe('Operation status (Started/Succeeded/Failed/...)'),
  subStatus: z.string().optional().describe('Sub-status (often the HTTP status, e.g. OK/Conflict)'),
  resourceId: z.string().optional().describe('Full ARM id of the impacted resource'),
  resourceType: z.string().optional().describe('ARM resource type'),
  resourceGroup: z.string().optional().describe('Resource group of the impacted resource'),
  caller: z.string().optional().describe('Caller identity (UPN, SP object id, or service)'),
  category: z.string().optional().describe('Event category (Administrative/ResourceHealth/...)'),
  correlationId: z.string().optional().describe('Correlation id shared across an operation'),
  eventName: z.string().optional().describe('Event name'),
  description: z.string().optional().describe('Event description, if any'),
  summary: z.string().optional().describe('Human-readable one-line summary'),
});

/** Common list-output schema (entries + pagination). */
const listOutputSchema = {
  entries: z.array(logEntryShape).describe('Projected Activity Log entries'),
  count: z.number().describe('Number of entries returned in this page (after filtering)'),
  filter: z.string().optional().describe('The Activity Log $filter that was used'),
  nextPageToken: z.string().optional().describe('Continuation token to retrieve the next page'),
};

/** Common input fields shared across the list-style tools. */
const commonInput = {
  subscriptionId: z
    .string()
    .optional()
    .describe('Azure subscription id to read the Activity Log from (default: AZURE_SUBSCRIPTION_ID)'),
  resourceGroup: z
    .string()
    .optional()
    .describe('Restrict to a resource group (results are still kept ANF-only)'),
  resourceUri: z
    .string()
    .optional()
    .describe('Restrict to a single ANF resource by its full ARM id (/subscriptions/.../volumes/...)'),
  resourceType: z
    .enum(resourceTypeEnum)
    .optional()
    .describe(`Restrict to an ANF resource kind: ${resourceTypeEnum.join(', ')}`),
  startTime: z
    .string()
    .optional()
    .describe(
      'Inclusive lower time bound, RFC3339 (default: 24h before endTime/now). ' +
        'The Activity Log retains ~90 days; older windows return nothing.'
    ),
  endTime: z.string().optional().describe('Inclusive upper time bound, RFC3339 (default: now)'),
  pageSize: z.number().optional().describe('Max entries to request per page (default 50, max 200)'),
  pageToken: z.string().optional().describe('Continuation token from a previous list request'),
  orderBy: z
    .enum(['timestamp desc', 'timestamp asc'])
    .optional()
    .describe('Sort order applied to the returned page (default "timestamp desc")'),
};

// List ANF Logs Tool
export const listAnfLogsTool: ToolConfig = {
  name: 'anf_logs_list',
  title: 'List ANF Logs',
  description:
    'List Azure Monitor Activity Log entries for Azure NetApp Files (ANF), scoped to the ' +
    'Microsoft.NetApp resource provider. Supports filtering by resource, time range, minimum ' +
    'level, and event category.',
  inputSchema: {
    ...commonInput,
    level: z
      .enum(levelEnum)
      .optional()
      .describe(`Minimum level, inclusive: ${levelEnum.join(', ')}`),
    category: z
      .enum(categoryEnum)
      .optional()
      .describe(`Restrict to an event category: ${categoryEnum.join(', ')}`),
  },
  outputSchema: listOutputSchema,
};

// List ANF Errors Tool
export const listAnfErrorsTool: ToolConfig = {
  name: 'anf_errors_list',
  title: 'List ANF Errors',
  description:
    'List ANF error/failure Activity Log entries (level>=Error or status=Failed). Use this to ' +
    'triage failures, issues, and alerts for NetApp resources.',
  inputSchema: {
    ...commonInput,
    minLevel: z
      .enum(errorLevelEnum)
      .optional()
      .describe(
        `Raise the minimum level above the Error floor (one of: ${errorLevelEnum.join(
          ', '
        )}); failed operations are always included`
      ),
  },
  outputSchema: listOutputSchema,
};

// List ANF Events Tool
export const listAnfEventsTool: ToolConfig = {
  name: 'anf_events_list',
  title: 'List ANF Events',
  description:
    'List ANF lifecycle/admin-activity events from the Activity Log. Use this for historical ' +
    'events and change tracking (create/update map to the Azure "write" verb).',
  inputSchema: {
    ...commonInput,
    eventType: z
      .enum(eventTypeEnum)
      .optional()
      .describe(`High-level event category: ${eventTypeEnum.join(', ')}`),
    operationName: z
      .string()
      .optional()
      .describe(
        'Restrict to operation names matching this pattern; supports "*" wildcards ' +
          '(e.g. */volumes/delete)'
      ),
  },
  outputSchema: listOutputSchema,
};

// ANF Log Summary Tool
export const anfLogSummaryTool: ToolConfig = {
  name: 'anf_log_summary',
  title: 'Summarize ANF Logs',
  description:
    'Fetch a window of ANF Activity Log entries and return aggregated counts (by level, ' +
    'operation, resource, and category) plus a failure count. Use this to spot historical ' +
    'patterns and recurring issues without paging through raw entries.',
  inputSchema: {
    ...commonInput,
    level: z
      .enum(levelEnum)
      .optional()
      .describe(`Minimum level, inclusive: ${levelEnum.join(', ')}`),
    category: z
      .enum(categoryEnum)
      .optional()
      .describe(`Restrict to an event category: ${categoryEnum.join(', ')}`),
    maxEntries: z
      .number()
      .optional()
      .describe('Max entries to scan for the summary (default 500, max 1000)'),
  },
  outputSchema: {
    totalEntries: z.number().describe('Number of entries scanned'),
    failureCount: z.number().describe('Entries that are failures (status=Failed or level>=Error)'),
    timeRange: z
      .object({ startTime: z.string().optional(), endTime: z.string().optional() })
      .describe('Effective time range scanned'),
    byLevel: z.record(z.number()).describe('Entry counts keyed by level'),
    byOperation: z.record(z.number()).describe('Entry counts keyed by operation name'),
    byResource: z.record(z.number()).describe('Entry counts keyed by resource id'),
    byCategory: z.record(z.number()).describe('Entry counts keyed by event category'),
    truncated: z.boolean().describe('True if more entries existed than were scanned'),
    filter: z.string().optional().describe('The Activity Log $filter that was used'),
  },
};

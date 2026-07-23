import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn();

vi.mock('./monitor-client-factory.js', () => ({
  MonitorClientFactory: { createClient: createClientMock },
}));

/** Build a fake @azure/arm-monitor EventData (LocalizableString fields). */
function ev(opts: {
  timestamp?: any;
  level?: string;
  operationName?: string;
  status?: string;
  subStatus?: string;
  resourceId?: string;
  resourceGroup?: string;
  resourceType?: string;
  caller?: string;
  category?: string;
  correlationId?: string;
  eventName?: string;
  description?: string;
}) {
  return {
    eventTimestamp: opts.timestamp,
    level: opts.level,
    operationName: opts.operationName ? { value: opts.operationName, localizedValue: opts.operationName } : undefined,
    status: opts.status ? { value: opts.status } : undefined,
    subStatus: opts.subStatus ? { value: opts.subStatus } : undefined,
    resourceId: opts.resourceId,
    resourceGroupName: opts.resourceGroup,
    resourceType: opts.resourceType ? { value: opts.resourceType } : undefined,
    caller: opts.caller,
    category: opts.category ? { value: opts.category } : undefined,
    correlationId: opts.correlationId,
    eventName: opts.eventName ? { value: opts.eventName } : undefined,
    description: opts.description,
  };
}

const VOL_ID =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/a/capacityPools/p/volumes/v1';

let byPageCalls: any[] = [];
let listCalls: string[] = [];

/** Build a mock pageable matching `client.activityLogs.list(...).byPage(...)`. */
function pageableFrom(pages: Array<{ items: any[]; continuationToken?: string }>) {
  return {
    byPage: (settings: any) => {
      byPageCalls.push(settings);
      let i = 0;
      return {
        next: async () => {
          if (i >= pages.length) return { value: undefined, done: true };
          const { items, continuationToken } = pages[i++];
          const arr: any = items.slice();
          if (continuationToken !== undefined) arr.continuationToken = continuationToken;
          return { value: arr, done: false };
        },
      };
    },
  };
}

function mockClient(pages: Array<{ items: any[]; continuationToken?: string }>) {
  createClientMock.mockReturnValue({
    activityLogs: {
      list: (filter: string) => {
        listCalls.push(filter);
        return pageableFrom(pages);
      },
    },
  });
}

describe('logs-handler', () => {
  const savedSub = process.env.AZURE_SUBSCRIPTION_ID;

  beforeEach(() => {
    createClientMock.mockReset();
    byPageCalls = [];
    listCalls = [];
    delete process.env.AZURE_SUBSCRIPTION_ID;
  });

  afterEach(() => {
    if (savedSub === undefined) delete process.env.AZURE_SUBSCRIPTION_ID;
    else process.env.AZURE_SUBSCRIPTION_ID = savedSub;
  });

  it('projectEntry maps EventData into the compact shape', async () => {
    const { projectEntry } = await import('./logs-handler.js');
    const result = projectEntry(
      ev({
        timestamp: '2026-01-01T00:00:00Z',
        level: 'Error',
        operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/delete',
        status: 'Failed',
        subStatus: 'Conflict',
        resourceId: VOL_ID,
        resourceGroup: 'rg',
        resourceType: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes',
        caller: 'user@example.com',
        category: 'Administrative',
        correlationId: 'corr-1',
        eventName: 'EndRequest',
        description: 'delete failed',
      })
    );
    expect(result).toMatchObject({
      timestamp: '2026-01-01T00:00:00Z',
      level: 'Error',
      operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/delete',
      status: 'Failed',
      subStatus: 'Conflict',
      resourceId: VOL_ID,
      resourceGroup: 'rg',
      caller: 'user@example.com',
      category: 'Administrative',
      correlationId: 'corr-1',
    });
    expect(result.summary).toContain('volumes/delete');
    expect(result.summary).toContain('FAILED');
  });

  it('projectEntry normalizes Date timestamps and tolerates an empty entry', async () => {
    const { projectEntry } = await import('./logs-handler.js');
    const d = new Date('2026-02-02T02:02:02Z');
    expect(projectEntry(ev({ timestamp: d })).timestamp).toBe(d.toISOString());
    const empty = projectEntry(undefined);
    expect(empty.timestamp).toBeUndefined();
    expect(empty.summary).toBe('(ok)');
  });

  it('listAnfLogsHandler requires a subscription id', async () => {
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    const result = await listAnfLogsHandler({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: expect.stringContaining('subscriptionId'),
    });
  });

  it('listAnfLogsHandler falls back to AZURE_SUBSCRIPTION_ID', async () => {
    process.env.AZURE_SUBSCRIPTION_ID = 'env-sub';
    mockClient([{ items: [] }]);
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    await listAnfLogsHandler({});
    expect(createClientMock).toHaveBeenCalledWith('env-sub');
  });

  it('listAnfLogsHandler builds a filter, lists, and returns projected entries + token', async () => {
    mockClient([
      {
        items: [
          ev({
            timestamp: '2026-01-01T00:00:00Z',
            level: 'Informational',
            operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/write',
            resourceId: VOL_ID,
          }),
        ],
        continuationToken: 'tok-2',
      },
    ]);

    const { listAnfLogsHandler } = await import('./logs-handler.js');
    const result = await listAnfLogsHandler({ subscriptionId: 'sub-1', resourceType: 'volume' });

    expect(createClientMock).toHaveBeenCalledWith('sub-1');
    expect(listCalls[0]).toContain("resourceProvider eq 'Microsoft.NetApp'");
    expect(result.structuredContent).toMatchObject({ count: 1, nextPageToken: 'tok-2' });
  });

  it('listAnfLogsHandler defaults to a last-24h window and clamps page size', async () => {
    mockClient([{ items: [] }]);
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    await listAnfLogsHandler({ subscriptionId: 'sub-1', pageSize: 5000 });

    expect(listCalls[0]).toContain('eventTimestamp ge ');
    expect(listCalls[0]).toContain('eventTimestamp le ');
    expect(byPageCalls[0].maxPageSize).toBe(200);
  });

  it('listAnfLogsHandler honors an explicit window and a page token', async () => {
    mockClient([{ items: [] }]);
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    await listAnfLogsHandler({
      subscriptionId: 'sub-1',
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-01-02T00:00:00Z',
      pageToken: 'resume-1',
    });

    expect(listCalls[0]).toContain("eventTimestamp ge '2026-01-01T00:00:00Z'");
    expect(listCalls[0]).toContain("eventTimestamp le '2026-01-02T00:00:00Z'");
    expect(byPageCalls[0].continuationToken).toBe('resume-1');
  });

  it('listAnfLogsHandler applies client-side resourceType filtering', async () => {
    const poolId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.NetApp/netAppAccounts/a/capacityPools/p';
    mockClient([
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:02Z', resourceId: VOL_ID, level: 'Informational' }),
          ev({ timestamp: '2026-01-01T00:00:01Z', resourceId: poolId, level: 'Informational' }),
        ],
      },
    ]);

    const { listAnfLogsHandler } = await import('./logs-handler.js');
    const result = await listAnfLogsHandler({ subscriptionId: 'sub-1', resourceType: 'volume' });

    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.entries[0].resourceId).toBe(VOL_ID);
  });

  it('listAnfLogsHandler sorts the page descending by default and ascending when asked', async () => {
    const mk = () => [
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:01Z', resourceId: VOL_ID }),
          ev({ timestamp: '2026-01-01T00:00:03Z', resourceId: VOL_ID }),
          ev({ timestamp: '2026-01-01T00:00:02Z', resourceId: VOL_ID }),
        ],
      },
    ];
    mockClient(mk());
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    const desc = await listAnfLogsHandler({ subscriptionId: 'sub-1' });
    expect(desc.structuredContent.entries.map((e: any) => e.timestamp)).toEqual([
      '2026-01-01T00:00:03Z',
      '2026-01-01T00:00:02Z',
      '2026-01-01T00:00:01Z',
    ]);

    mockClient(mk());
    const asc = await listAnfLogsHandler({ subscriptionId: 'sub-1', orderBy: 'timestamp asc' });
    expect(asc.structuredContent.entries.map((e: any) => e.timestamp)).toEqual([
      '2026-01-01T00:00:01Z',
      '2026-01-01T00:00:02Z',
      '2026-01-01T00:00:03Z',
    ]);
  });

  it('listAnfErrorsHandler keeps only failures', async () => {
    mockClient([
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:03Z', resourceId: VOL_ID, status: 'Failed', level: 'Error' }),
          ev({ timestamp: '2026-01-01T00:00:02Z', resourceId: VOL_ID, status: 'Succeeded', level: 'Informational' }),
        ],
      },
    ]);
    const { listAnfErrorsHandler } = await import('./logs-handler.js');
    const result = await listAnfErrorsHandler({ subscriptionId: 'sub-1' });
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.entries[0].status).toBe('Failed');
  });

  it('listAnfEventsHandler filters by event type verb', async () => {
    mockClient([
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:03Z', resourceId: VOL_ID, operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/delete' }),
          ev({ timestamp: '2026-01-01T00:00:02Z', resourceId: VOL_ID, operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/write' }),
        ],
      },
    ]);
    const { listAnfEventsHandler } = await import('./logs-handler.js');
    const result = await listAnfEventsHandler({ subscriptionId: 'sub-1', eventType: 'delete' });
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.entries[0].operationName).toContain('/delete');
  });

  it('listAnfEventsHandler defaults to the Administrative category when unfiltered', async () => {
    mockClient([
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:03Z', resourceId: VOL_ID, category: 'Administrative', operationName: 'Microsoft.NetApp/netAppAccounts/capacityPools/volumes/write' }),
          ev({ timestamp: '2026-01-01T00:00:02Z', resourceId: VOL_ID, category: 'ResourceHealth' }),
        ],
      },
    ]);
    const { listAnfEventsHandler } = await import('./logs-handler.js');
    const result = await listAnfEventsHandler({ subscriptionId: 'sub-1' });
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.entries[0].category).toBe('Administrative');
  });

  it('listAnfLogsHandler returns a filter error for an invalid resourceType', async () => {
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    const result = await listAnfLogsHandler({ subscriptionId: 'sub-1', resourceType: 'bogus' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: expect.stringContaining('resourceType') });
  });

  it('listAnfLogsHandler surfaces list failures as errors', async () => {
    createClientMock.mockReturnValue({
      activityLogs: {
        list: () => ({
          byPage: () => ({ next: async () => Promise.reject(new Error('boom')) }),
        }),
      },
    });
    const { listAnfLogsHandler } = await import('./logs-handler.js');
    const result = await listAnfLogsHandler({ subscriptionId: 'sub-1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'boom', count: 0 });
  });

  it('anfLogSummaryHandler aggregates entries across pages and respects maxEntries', async () => {
    mockClient([
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:01Z', level: 'Informational', operationName: 'x/write', resourceId: VOL_ID, category: 'Administrative' }),
          ev({ timestamp: '2026-01-01T00:00:02Z', level: 'Error', operationName: 'x/delete', resourceId: VOL_ID, status: 'Failed', category: 'Administrative' }),
        ],
        continuationToken: 'p2',
      },
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:03Z', level: 'Informational', operationName: 'x/write', resourceId: VOL_ID, category: 'Administrative' }),
        ],
      },
    ]);

    const { anfLogSummaryHandler } = await import('./logs-handler.js');
    const result = await anfLogSummaryHandler({ subscriptionId: 'sub-1' });

    expect(result.structuredContent).toMatchObject({
      totalEntries: 3,
      failureCount: 1,
      byLevel: { Informational: 2, Error: 1 },
      byOperation: { 'x/write': 2, 'x/delete': 1 },
      byResource: { [VOL_ID]: 3 },
      byCategory: { Administrative: 3 },
      truncated: false,
    });
  });

  it('anfLogSummaryHandler marks truncated when maxEntries is reached with more pages', async () => {
    mockClient([
      {
        items: [
          ev({ timestamp: '2026-01-01T00:00:01Z', level: 'Informational', resourceId: VOL_ID }),
          ev({ timestamp: '2026-01-01T00:00:02Z', level: 'Informational', resourceId: VOL_ID }),
        ],
        continuationToken: 'more',
      },
    ]);
    const { anfLogSummaryHandler } = await import('./logs-handler.js');
    const result = await anfLogSummaryHandler({ subscriptionId: 'sub-1', maxEntries: 1 });
    expect(result.structuredContent).toMatchObject({ truncated: true, totalEntries: 1 });
  });

  it('anfLogSummaryHandler requires a subscription id', async () => {
    const { anfLogSummaryHandler } = await import('./logs-handler.js');
    const result = await anfLogSummaryHandler({});
    expect(result.isError).toBe(true);
  });

  it('anfLogSummaryHandler surfaces list failures as errors', async () => {
    createClientMock.mockReturnValue({
      activityLogs: {
        list: () => ({
          byPage: () => ({ next: async () => Promise.reject(new Error('nope')) }),
        }),
      },
    });
    const { anfLogSummaryHandler } = await import('./logs-handler.js');
    const result = await anfLogSummaryHandler({ subscriptionId: 'sub-1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'nope' });
  });
});

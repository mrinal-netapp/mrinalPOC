import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const monitorClientCtor = vi.fn();
const clientSecretCtor = vi.fn();

vi.mock('@azure/arm-monitor', () => ({
  MonitorClient: class {
    constructor(...args: any[]) {
      monitorClientCtor(...args);
    }
  },
}));

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    constructor(...args: any[]) {
      clientSecretCtor(...args);
    }
  },
}));

const ENV_KEYS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

describe('MonitorClientFactory', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    monitorClientCtor.mockReset();
    clientSecretCtor.mockReset();
    const { MonitorClientFactory } = await import('./monitor-client-factory.js');
    MonitorClientFactory.reset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  it('throws when subscriptionId is empty', async () => {
    const { MonitorClientFactory } = await import('./monitor-client-factory.js');
    expect(() => MonitorClientFactory.createClient('')).toThrow(/subscriptionId is required/);
  });

  it('throws a descriptive error when SP env vars are missing', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const { MonitorClientFactory } = await import('./monitor-client-factory.js');
    expect(() => MonitorClientFactory.createClient('sub-1')).toThrow(
      /Missing Azure service-principal credentials/
    );
  });

  it('builds a ClientSecretCredential from env and constructs a MonitorClient', async () => {
    process.env.AZURE_TENANT_ID = 'tenant';
    process.env.AZURE_CLIENT_ID = 'client';
    process.env.AZURE_CLIENT_SECRET = 'secret';
    const { MonitorClientFactory } = await import('./monitor-client-factory.js');

    MonitorClientFactory.createClient('sub-1');

    expect(clientSecretCtor).toHaveBeenCalledWith('tenant', 'client', 'secret');
    expect(monitorClientCtor).toHaveBeenCalledTimes(1);
    expect(monitorClientCtor.mock.calls[0][1]).toBe('sub-1');
  });

  it('caches one client per subscription', async () => {
    const { MonitorClientFactory } = await import('./monitor-client-factory.js');
    MonitorClientFactory.setCredential({ getToken: vi.fn() } as any);

    const a1 = MonitorClientFactory.createClient('sub-1');
    const a2 = MonitorClientFactory.createClient('sub-1');
    const b1 = MonitorClientFactory.createClient('sub-2');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(monitorClientCtor).toHaveBeenCalledTimes(2);
  });

  it('reuses an injected credential without reading env', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const { MonitorClientFactory } = await import('./monitor-client-factory.js');
    const cred = { getToken: vi.fn() } as any;
    MonitorClientFactory.setCredential(cred);

    MonitorClientFactory.createClient('sub-1');

    expect(clientSecretCtor).not.toHaveBeenCalled();
  });
});

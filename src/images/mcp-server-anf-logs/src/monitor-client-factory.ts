import { ClientSecretCredential, type TokenCredential } from '@azure/identity';
import { MonitorClient } from '@azure/arm-monitor';

/**
 * Factory for creating `@azure/arm-monitor` MonitorClient instances used by the
 * ANF logs / errors / events tools.
 *
 * Mirrors the GCNV LoggingClientFactory: it centralizes client creation and
 * caches one client per subscription. Authentication uses an Azure service
 * principal (`ClientSecretCredential`) materialized from the `azure_cloud`
 * runtime credential as `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
 * `AZURE_CLIENT_SECRET` — the same keys the ANF metrics workstream uses. The
 * principal needs Reader (or Monitoring Reader) on the target scope
 * (`Microsoft.Insights/eventtypes/values/read`).
 */
export class MonitorClientFactory {
  private static clientCache: { [key: string]: MonitorClient } = {};
  private static credential?: TokenCredential;

  /**
   * Create (or return a cached) MonitorClient for the given subscription.
   *
   * @param subscriptionId - Azure subscription whose Activity Log will be read.
   *   Used both to scope queries and as the cache key.
   */
  public static createClient(subscriptionId: string): MonitorClient {
    if (!subscriptionId) {
      throw new Error('subscriptionId is required to create a MonitorClient');
    }
    const cached = this.clientCache[subscriptionId];
    if (cached) {
      return cached;
    }
    const client = new MonitorClient(this.getCredential(), subscriptionId);
    this.clientCache[subscriptionId] = client;
    return client;
  }

  /**
   * Build (or return the cached) Azure credential from the service-principal
   * environment variables. Throws a descriptive error when any are missing.
   */
  public static getCredential(): TokenCredential {
    if (this.credential) {
      return this.credential;
    }
    const tenantId = (process.env.AZURE_TENANT_ID || '').trim();
    const clientId = (process.env.AZURE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.AZURE_CLIENT_SECRET || '').trim();

    const missing = [
      ['AZURE_TENANT_ID', tenantId],
      ['AZURE_CLIENT_ID', clientId],
      ['AZURE_CLIENT_SECRET', clientSecret],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      throw new Error(
        `Missing Azure service-principal credentials: ${missing.join(', ')}. ` +
          'These are materialized from the azure_cloud runtime credential ' +
          '(tenant_id, client_id, client_secret).'
      );
    }

    this.credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    return this.credential;
  }

  /** Inject a credential (used by tests to avoid real auth). */
  public static setCredential(credential: TokenCredential): void {
    this.credential = credential;
  }

  /** Clear the client cache (useful for tests or credential rotation). */
  public static clearCache(): void {
    this.clientCache = {};
  }

  /** Reset the factory to its initial state (cache + credential). */
  public static reset(): void {
    this.clearCache();
    this.credential = undefined;
  }
}

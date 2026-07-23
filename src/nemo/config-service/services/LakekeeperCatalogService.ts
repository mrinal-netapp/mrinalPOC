import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { BaseService } from './BaseService';

/**
 * Iceberg Schema definition
 */
export interface IcebergSchema {
  type: 'struct';
  fields: Array<{
    id: number;
    name: string;
    type: string | { type: string; elementType?: string; keyType?: string; valueType?: string };
    required: boolean;
    doc?: string;
  }>;
}

/**
 * Table metadata from catalog
 */
export interface CatalogTable {
  name: string;
  namespace: string[];
  metadata: {
    'metadata-location': string;
    'previous-metadata-locations'?: string[];
    'current-schema-id': number;
    'schemas'?: Array<{
      'schema-id': number;
      fields: Array<{
        id: number;
        name: string;
        type: string;
        required: boolean;
        doc?: string;
      }>;
    }>;
    'current-snapshot-id'?: number;
    'snapshots'?: Array<{
      'snapshot-id': number;
      'timestamp-ms': number;
      'summary'?: Record<string, string>;
    }>;
    'partition-spec'?: Array<{
      'field-id': number;
      name: string;
      transform: string;
    }>;
    'default-sort-order-id'?: number;
    properties?: Record<string, string>;
  };
}

/**
 * Create table request
 */
export interface CreateTableRequest {
  name: string;
  namespace: string[];
  schema: IcebergSchema;
  warehouseId?: string; // Warehouse ID used as prefix in catalog path: /catalog/v1/{warehouse-id}/namespaces/...
  partitionSpec?: Array<{
    'field-id': number;
    name: string;
    transform: string;
  }>;
  sortOrder?: Array<{
    'field-id': number;
    direction: string;
    'null-order': string;
  }>;
  properties?: Record<string, string>;
  location?: string;
}

/**
 * Update table metadata request
 */
export interface UpdateTableMetadataRequest {
  'metadata-location'?: string;
  'previous-metadata-locations'?: string[];
  'current-schema-id'?: number;
  'schemas'?: Array<{
    'schema-id': number;
    fields: Array<{
      id: number;
      name: string;
      type: string;
      required: boolean;
      doc?: string;
    }>;
  }>;
  'current-snapshot-id'?: number;
  properties?: Record<string, string>;
}

/**
 * Namespace definition
 */
export interface Namespace {
  namespace: string[];
  properties?: Record<string, string>;
}

/**
 * Warehouse definition
 */
export interface Warehouse {
  name: string;
  uri?: string;
  properties?: Record<string, string> & {
    endpoint?: string; // S3 endpoint URL (e.g., https://s3.us-east-1.agentstudio.local)
    region?: string; // S3 region
    awsKmsKeyArn?: string;
    assumeRoleArn?: string;
    projectId?: string;
  };
}

/**
 * Client for interacting with Lakekeeper Iceberg Catalog REST API
 * Documentation: https://docs.lakekeeper.io/docs/0.11.x/api/catalog/
 */
export class LakekeeperCatalogService extends BaseService {
  private client: AxiosInstance;
  private baseUrl: string;
  private warehouseId?: string; // Cache warehouse ID for catalog operations
  private serviceAccountClient: ServiceAccountClient | null = null;
  // Cache of warehouse-name -> warehouse UUID. The UUID doubles as the Iceberg
  // REST "prefix" segment (/catalog/v1/{prefix}/...), so resolving it once per
  // warehouse lets the table read/write paths address the catalog correctly.
  private warehousePrefixCache: Map<string, string> = new Map();

  constructor(baseUrl?: string) {
    super();
    this.baseUrl = baseUrl || process.env.LAKEKEEPER_URL || 'http://lakekeeper:8181';
    
    // Initialize service account client for OIDC authentication
    this.serviceAccountClient = createServiceAccountClientFromEnv();
    
    if (this.serviceAccountClient) {
      // Use authenticated client
      this.client = this.serviceAccountClient.createAuthenticatedClient(this.baseUrl);
    } else {
      // Fallback to unauthenticated client
      logger.warn('[LakekeeperCatalogService] Service account client not available, using unauthenticated client');
      this.client = axios.create({
        baseURL: this.baseUrl,
        timeout: 30000, // 30 seconds
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    logger.info(`[LakekeeperCatalogService] Initialized with base URL: ${this.baseUrl}`);
  }

  /**
   * Health check - test connectivity to lakekeeper
   * Tries common health endpoints
   */
  async healthCheck(): Promise<boolean> {
    const healthEndpoints = ['/health', '/api/health', '/api/v1/health', '/'];
    for (const endpoint of healthEndpoints) {
      try {
        const response = await this.client.get(endpoint, { timeout: 5000 });
        logger.info(`[LakekeeperCatalogService] Health check successful at ${endpoint}:`, response.status);
        return true;
      } catch (error: any) {
        // Continue to next endpoint
        if (error.code !== 'ECONNREFUSED' && error.response?.status !== 404) {
          // If we get a non-404 response, the service is up but endpoint is wrong
          logger.info(`[LakekeeperCatalogService] Service reachable but ${endpoint} returned ${error.response?.status}`);
        }
      }
    }
    logger.error(`[LakekeeperCatalogService] Health check failed - service may not be reachable at ${this.baseUrl}`);
    return false;
  }

  /**
   * Create a warehouse
   * POST /management/v1/warehouse
   * Request body: { warehouse-name, storage-profile, project-id? }
   */
  async createWarehouse(warehouse: Warehouse): Promise<Warehouse> {
    try {
      const url = '/management/v1/warehouse';
      logger.info(`[LakekeeperCatalogService] Creating warehouse: ${warehouse.name}`);
      logger.info(`[LakekeeperCatalogService] Request URL: ${this.baseUrl}${url}`);
      
      // Parse S3 URI (s3://bucket-name) to extract bucket
      let bucket = warehouse.name;
      let region = 'us-east-1'; // Default region
      
      if (warehouse.uri && warehouse.uri.startsWith('s3://')) {
        const uriParts = warehouse.uri.replace('s3://', '').split('/');
        bucket = uriParts[0];
        // Region might be in properties or we use default
        region = warehouse.properties?.region || 'us-east-1';
      }
      
      // Construct request body according to CreateWarehouseRequest schema
      const requestBody: any = {
        'warehouse-name': warehouse.name,
        'storage-profile': {
          type: 's3',
          bucket: bucket,
          region: region,
          'sts-enabled': false, // Default to false, can be overridden via properties
          'path-style-access': true, // Use path-style addressing instead of virtual-hosted-style
          'flavor': 's3-compat', // Use s3-compat flavor to support path-style addressing
          ...(warehouse.properties?.endpoint && { endpoint: warehouse.properties.endpoint }),
          ...(warehouse.properties?.awsKmsKeyArn && { 'aws-kms-key-arn': warehouse.properties.awsKmsKeyArn }),
          ...(warehouse.properties?.assumeRoleArn && { 'assume-role-arn': warehouse.properties.assumeRoleArn }),
        },
      };
      
      logger.info(`[LakekeeperCatalogService] Request body:`, JSON.stringify(requestBody, null, 2));
      
      // Note: project-id is deprecated in lakekeeper API and should not be passed.
      // Projects in config-service are separate from lakekeeper's project management.
      // Warehouses are created without project association in lakekeeper.
      
      logger.info(`[LakekeeperCatalogService] Sending POST request to create warehouse`);
      const response = await this.client.post(url, requestBody);
      logger.info(`[LakekeeperCatalogService] Warehouse creation successful. Response status: ${response.status}`);
      logger.info(`[LakekeeperCatalogService] Response data:`, JSON.stringify(response.data, null, 2));
      
      // Extract and cache warehouse ID from response - check multiple possible field names
      const warehouseId = response.data?.['warehouse-id'] || response.data?.warehouseId || response.data?.id;
      if (warehouseId) {
        // Normalize to string and trim
        const normalizedId = String(warehouseId).trim();
        this.warehouseId = normalizedId;
        logger.info(`[LakekeeperCatalogService] Cached warehouse ID from creation response: ${normalizedId} (from fields: warehouse-id=${response.data?.['warehouse-id']}, warehouseId=${response.data?.warehouseId}, id=${response.data?.id})`);
      } else {
        logger.warn(`[LakekeeperCatalogService] Warehouse ID not found in creation response. Available fields:`, Object.keys(response.data || {}));
        logger.warn(`[LakekeeperCatalogService] Creation response:`, JSON.stringify(response.data, null, 2));
      }
      
      return response.data;
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message;
      const statusCode = error.response?.status;
      const responseData = error.response?.data;
      logger.error(`[LakekeeperCatalogService] Failed to create warehouse:`, {
        url: `${this.baseUrl}/management/v1/warehouse`,
        status: statusCode,
        error: errorMessage,
        response: responseData,
        warehouse,
      });
      throw new Error(
        `Failed to create warehouse: ${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}`
      );
    }
  }

  /**
   * List all warehouses
   * GET /management/v1/warehouse
   */
  async listWarehouses(): Promise<Warehouse[]> {
    try {
      const response = await this.client.get('/management/v1/warehouse');
      // Response format: { warehouses: [...] }
      const warehouses = response.data?.warehouses || response.data || [];
      return warehouses;
    } catch (error: any) {
      throw new Error(
        `Failed to list warehouses: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Get warehouse by name
   * Since the API uses UUID for get, we list warehouses and filter by name
   * GET /management/v1/warehouse (list) then filter by name
   */
  async getWarehouse(name: string): Promise<Warehouse & { warehouseId?: string }> {
    try {
      logger.info(`[LakekeeperCatalogService] Getting warehouse by name: ${name}`);
      // List warehouses and find by name
      const warehouses = await this.listWarehouses();
      const warehouse = warehouses.find((w: any) => w.name === name || w['warehouse-name'] === name);
      
      if (!warehouse) {
        throw new Error(`Warehouse '${name}' not found`);
      }
      
      // Extract warehouse ID if present - check multiple possible field names
      const warehouseAny = warehouse as any;
      const warehouseId = warehouse['warehouse-id'] || warehouseAny.warehouseId || warehouseAny.id;
      
      if (warehouseId) {
        // Normalize to string and trim
        const normalizedId = String(warehouseId).trim();
        this.warehouseId = normalizedId; // Cache it for catalog operations
        logger.info(`[LakekeeperCatalogService] Cached warehouse ID: ${normalizedId} (from fields: warehouse-id=${warehouse['warehouse-id']}, warehouseId=${warehouseAny.warehouseId}, id=${warehouseAny.id})`);
      } else {
        logger.warn(`[LakekeeperCatalogService] Warehouse ID not found in response. Available fields:`, Object.keys(warehouse));
        logger.warn(`[LakekeeperCatalogService] Warehouse response:`, JSON.stringify(warehouse, null, 2));
      }
      
      // Normalize response to our Warehouse interface
      const result: Warehouse & { warehouseId?: string } = {
        name: warehouse.name || warehouse['warehouse-name'],
        uri: warehouse.uri || warehouse['storage-profile']?.bucket ? `s3://${warehouse['storage-profile'].bucket}` : undefined,
        properties: warehouse.properties || {},
      };
      if (warehouseId) {
        (result as any).warehouseId = String(warehouseId).trim();
      }
      return result;
    } catch (error: any) {
      if (error.message.includes('not found')) {
        throw error;
      }
      const errorMessage = error.response?.data?.message || error.message;
      const statusCode = error.response?.status;
      logger.error(`[LakekeeperCatalogService] Failed to get warehouse:`, {
        name,
        status: statusCode,
        error: errorMessage,
      });
      throw new Error(
        `Failed to get warehouse: ${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}`
      );
    }
  }

  /**
   * The default Lakekeeper warehouse name to use when a caller does not supply
   * one. Datasets are always created under the static "nemo" warehouse (see
   * DataSetService), but honour the deployment env overrides if present.
   */
  private static defaultWarehouseName(): string {
    return (
      process.env.LAKEKEEPER_WAREHOUSE ||
      process.env.DUCKDB_DEFAULT_WAREHOUSE ||
      'nemo'
    );
  }

  /**
   * Resolve a warehouse name to its Lakekeeper warehouse UUID, which is also the
   * Iceberg REST catalog "prefix" segment: /catalog/v1/{prefix}/namespaces/...
   *
   * The table read/write endpoints are scoped by this prefix; without it every
   * request resolves to a non-existent unprefixed path and 404s. Results are
   * cached per warehouse name.
   */
  private async resolveWarehousePrefix(warehouseName?: string): Promise<string> {
    const name =
      (warehouseName && warehouseName.trim()) ||
      LakekeeperCatalogService.defaultWarehouseName();

    const cached = this.warehousePrefixCache.get(name);
    if (cached) return cached;

    const warehouse = await this.getWarehouse(name);
    const prefix =
      ((warehouse as any).warehouseId && String((warehouse as any).warehouseId).trim()) ||
      (this.warehouseId ? String(this.warehouseId).trim() : '');
    if (!prefix) {
      throw new Error(`Could not resolve warehouse prefix for warehouse '${name}'`);
    }
    this.warehousePrefixCache.set(name, prefix);
    return prefix;
  }

  /**
   * Helper method to try multiple catalog API path variations
   * Returns the successful response or throws the last error
   */
  private async tryCatalogPaths<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    pathSuffix: string,
    data?: any,
    queryParams?: Record<string, string>,
    headers?: Record<string, string>
  ): Promise<T> {
    // Try multiple path variations for catalog API
    // The prefix parameter is required but can be empty
    // Lakekeeper examples show /catalog/v1/{prefix}/... so we try both base paths
    // Note: Some servers normalize double slashes, so we try normalized versions first
    const paths = [
      `/catalog/v1/${pathSuffix}`,    // Catalog prefix normalized: /catalog/v1/namespaces (most likely to work)
      `/v1/${pathSuffix}`,            // Standard normalized: /v1/namespaces (OpenAPI spec normalized)
      `/catalog/v1//${pathSuffix}`,   // Catalog prefix with empty prefix: /catalog/v1//namespaces (explicit double slash)
      `/v1//${pathSuffix}`,           // Standard with empty prefix: /v1//namespaces (explicit double slash)
    ];

    let lastError: any = null;
    
    for (let i = 0; i < paths.length; i++) {
      try {
        let url = paths[i];
        
        // Add query parameters if provided
        if (queryParams) {
          const queryString = new URLSearchParams(queryParams).toString();
          url += `?${queryString}`;
        }
        
        const fullUrl = `${this.baseUrl}${url}`;
        logger.info(`[LakekeeperCatalogService] Attempt ${i + 1}: ${method.toUpperCase()} ${fullUrl}`);
        if (headers) {
          logger.info(`[LakekeeperCatalogService] Request headers:`, JSON.stringify(headers, null, 2));
        }
        
        // Merge custom headers with default headers
        const requestConfig = headers ? { headers } : {};
        
        let response;
        if (method === 'get') {
          response = await this.client.get(url, requestConfig);
        } else if (method === 'post') {
          response = await this.client.post(url, data, requestConfig);
        } else if (method === 'put') {
          response = await this.client.put(url, data, requestConfig);
        } else if (method === 'delete') {
          response = await this.client.delete(url, requestConfig);
        } else {
          throw new Error(`Unsupported HTTP method: ${method}`);
        }
        
        logger.info(`[LakekeeperCatalogService] Success with path: ${url}`);
        return response.data;
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        const errorData = error.response?.data;
        
        logger.error(`[LakekeeperCatalogService] Attempt ${i + 1} failed. Status: ${status}, Message: ${message}`);
        if (errorData) {
          logger.error(`[LakekeeperCatalogService] Error response data:`, JSON.stringify(errorData, null, 2));
        }
        
        // If it's not a 404, don't try other paths (likely a different error)
        // But for 400 errors, we might want to see the actual error message first
        if (status && status !== 404) {
          // For 400 errors, include more details before throwing
          if (status === 400) {
            logger.error(`[LakekeeperCatalogService] Bad Request (400) - this usually means the request body format is incorrect`);
            logger.error(`[LakekeeperCatalogService] Request body that failed:`, JSON.stringify(data, null, 2));
            if (headers) {
              logger.error(`[LakekeeperCatalogService] Request headers that failed:`, JSON.stringify(headers, null, 2));
              // Log each header value individually to check for undefined/null
              for (const [key, value] of Object.entries(headers)) {
                logger.error(`[LakekeeperCatalogService] Header ${key}: value="${value}", type=${typeof value}, isUndefined=${value === undefined}, isNull=${value === null}, isEmpty=${value === ''}`);
              }
            }
          }
          throw error;
        }
      }
    }
    
    // All attempts failed
    throw new Error(
      `Failed after trying ${paths.length} path variations. Last error: ${lastError?.response?.data?.message || lastError?.message}`
    );
  }

  /**
   * Create a namespace
   * POST /v1/{prefix}/namespaces
   * Prefix is typically empty for default catalog, but can be specified
   * 
   * Request body format per OpenAPI spec:
   * {
   *   "namespace": ["part1", "part2"],  // Namespace is an array of strings
   *   "properties": { ... }              // Optional properties
   * }
   * 
   * Note: Lakekeeper requires a warehouse ID header (x-warehouse-id) when creating namespaces
   */
  async createNamespace(namespace: Namespace, warehouseId?: string): Promise<Namespace> {
    const namespaceStr = namespace.namespace.join('.');
    logger.info(`[LakekeeperCatalogService] Creating namespace: ${namespaceStr}`);
    logger.info(`[LakekeeperCatalogService] Namespace array:`, namespace.namespace);
    
    // Log current state
    logger.info(`[LakekeeperCatalogService] Warehouse ID state - provided: ${warehouseId}, cached: ${this.warehouseId}`);
    
    // Use provided warehouse ID or cached one
    let warehouseIdToUse = warehouseId || this.warehouseId;
    if (!warehouseIdToUse) {
      logger.error(`[LakekeeperCatalogService] Warehouse ID is missing! Provided: ${warehouseId}, Cached: ${this.warehouseId}`);
      throw new Error('Warehouse ID is required to create a namespace. Please ensure a warehouse exists and its ID is available.');
    }
    
    // Validate and normalize warehouse ID (trim whitespace, ensure it's a string)
    warehouseIdToUse = String(warehouseIdToUse).trim();
    if (!warehouseIdToUse) {
      throw new Error('Warehouse ID is empty or invalid. Please ensure a warehouse exists and its ID is available.');
    }
    
    // Basic UUID format validation (8-4-4-4-12 hex digits)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(warehouseIdToUse)) {
      const errorMsg = `Warehouse ID does not match UUID format: "${warehouseIdToUse}" (type: ${typeof warehouseIdToUse}, length: ${warehouseIdToUse.length}). This will cause namespace creation to fail.`;
      logger.error(`[LakekeeperCatalogService] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Format request body according to CreateNamespaceRequest schema
    const requestBody = {
      namespace: namespace.namespace,  // Array of strings (matches Namespace schema)
      ...(namespace.properties && { properties: namespace.properties }),
    };
    
    logger.info(`[LakekeeperCatalogService] Request body:`, JSON.stringify(requestBody, null, 2));
    logger.info(`[LakekeeperCatalogService] Using warehouse ID: ${warehouseIdToUse} (type: ${typeof warehouseIdToUse}, length: ${warehouseIdToUse.length})`);
    
    try {
      // Pass warehouse ID as header - ensure it's a string
      const headers = {
        'x-warehouse-id': String(warehouseIdToUse).trim(),
      };
      logger.info(`[LakekeeperCatalogService] Request headers:`, JSON.stringify(headers, null, 2));
      
      const response = await this.tryCatalogPaths<any>('post', 'namespaces', requestBody, undefined, headers);
      // Response format: { namespace: string[], properties?: Record<string, string> }
      return response;
    } catch (error: any) {
      // Log more details about the error
      const errorDetails = error.response?.data || error.message;
      logger.error(`[LakekeeperCatalogService] Failed to create namespace:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        requestBody: requestBody,
        warehouseId: warehouseIdToUse,
        warehouseIdType: typeof warehouseIdToUse,
        warehouseIdLength: warehouseIdToUse?.length,
      });
      throw error;
    }
  }

  /**
   * List namespaces
   * GET /v1/{prefix}/namespaces
   */
  async listNamespaces(parent?: string[]): Promise<Namespace[]> {
    try {
      const prefix = ''; // Empty prefix for default catalog
      let url = `/v1/${prefix}/namespaces`.replace('//', '/'); // Handle double slash
      if (parent) {
        // Parent namespace parts should be separated by unit separator (0x1F) or dot
        // Using dot for simplicity, but API might expect unit separator
        url += `?parent=${parent.join('.')}`;
      }
      const response = await this.client.get(url);
      // Response format: { namespaces: [...] } or array
      const namespaces = response.data?.namespaces || response.data || [];
      return namespaces;
    } catch (error: any) {
      if (error.response?.status === 404) {
        // Try with explicit double slash
        try {
          let url = '/v1//namespaces';
          if (parent) {
            url += `?parent=${parent.join('.')}`;
          }
          const response = await this.client.get(url);
          const namespaces = response.data?.namespaces || response.data || [];
          return namespaces;
        } catch (retryError: any) {
          throw new Error(
            `Failed to list namespaces: ${retryError.response?.data?.message || retryError.message}`
          );
        }
      }
      throw new Error(
        `Failed to list namespaces: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Get namespace
   * GET /v1/{prefix}/namespaces/{namespace}
   * Namespace parts should be separated by unit separator (0x1F) or dot
   */
  async getNamespace(workspace_id: string, namespaces: string[]): Promise<Namespace> {
    try {
      const namespaceStr = namespaces.join('.');
      let url = `/catalog/v1/${workspace_id}/namespaces/${namespaceStr}`.replace('//', '/');
      const response = await this.client.get(url);
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to get namespace: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Update namespace properties
   * POST /v1/{prefix}/namespaces/{namespace}/properties
   */
  async updateNamespace(namespace: string[], properties: Record<string, string>): Promise<Namespace> {
    try {
      const prefix = '';
      const namespaceStr = namespace.join('.');
      let url = `/v1/${prefix}/namespaces/${namespaceStr}/properties`.replace('//', '/');
      const response = await this.client.post(url, { removals: [], updates: properties });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        try {
          const namespaceStr = namespace.join('\x1F');
          const url = `/v1//namespaces/${namespaceStr}/properties`;
          const response = await this.client.post(url, { removals: [], updates: properties });
          return response.data;
        } catch (retryError: any) {
          throw new Error(
            `Failed to update namespace: ${retryError.response?.data?.message || retryError.message}`
          );
        }
      }
      throw new Error(
        `Failed to update namespace: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Delete namespace
   * DELETE /v1/{prefix}/namespaces/{namespace}
   */
  async deleteNamespace(namespace: string[]): Promise<void> {
    try {
      const prefix = '';
      const namespaceStr = namespace.join('.');
      let url = `/v1/${prefix}/namespaces/${namespaceStr}`.replace('//', '/');
      await this.client.delete(url);
    } catch (error: any) {
      if (error.response?.status === 404) {
        try {
          const namespaceStr = namespace.join('\x1F');
          const url = `/v1//namespaces/${namespaceStr}`;
          await this.client.delete(url);
          return;
        } catch (retryError: any) {
          throw new Error(
            `Failed to delete namespace: ${retryError.response?.data?.message || retryError.message}`
          );
        }
      }
      throw new Error(
        `Failed to delete namespace: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Create a table
   * POST /catalog/v1/{warehouse-id}/namespaces/{namespace}/tables
   * Format matches test_lakekeeper.sh: /catalog/v1/${WORKSPACE_ID}/namespaces/${PROJECT_ID}/tables
   * But we use warehouse-id as prefix and "default" as namespace
   */
  async createTable(request: CreateTableRequest): Promise<CatalogTable> {
    const namespaceStr = request.namespace.join('.');
    logger.info(`[LakekeeperCatalogService] Creating table: ${request.name} in namespace: ${namespaceStr}`);
    
    // Get warehouse ID - required for the API path
    let warehouseId = request.warehouseId || this.warehouseId;
    if (!warehouseId) {
      throw new Error('Warehouse ID is required to create a table. Please provide warehouseId in the request or ensure a warehouse has been accessed first.');
    }
    
    // Validate warehouse ID format
    warehouseId = String(warehouseId).trim();
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(warehouseId)) {
      throw new Error(`Invalid warehouse ID format: "${warehouseId}". Expected UUID format.`);
    }
    
    try {
      // Use the correct API path format: /catalog/v1/{warehouse-id}/namespaces/{namespace}/tables
      // Example: /catalog/v1/546525ec-ef0c-11f0-b17c-97a417f24b34/namespaces/default/tables
      const url = `/catalog/v1/${warehouseId}/namespaces/${namespaceStr}/tables`;
      const fullUrl = `${this.baseUrl}${url}`;
      logger.info(`[LakekeeperCatalogService] Creating table at: POST ${fullUrl}`);
      logger.info(`[LakekeeperCatalogService] Warehouse ID: ${warehouseId}, Namespace: ${namespaceStr}`);
      
      // Convert IcebergSchema to the format expected by the API
      // Format matches test_lakekeeper.sh: name, schema, properties, location
      const requestBody = {
        name: request.name,
        schema: request.schema,
        ...(request.partitionSpec && { 'partition-spec': request.partitionSpec }),
        ...(request.sortOrder && { 'sort-order': request.sortOrder }),
        ...(request.properties && { properties: request.properties }),
        ...(request.location && { location: request.location }),
      };
      
      logger.info(`[LakekeeperCatalogService] Request body:`, JSON.stringify(requestBody, null, 2));
      
      // Table creation can take time, especially for large schemas or when initializing storage
      // Use a longer timeout (120 seconds) for createTable operations
      const response = await this.client.post(url, requestBody, {
        timeout: 120000, // 2 minutes
      });
      logger.info(`[LakekeeperCatalogService] Table creation successful. Response status: ${response.status}`);
      logger.info(`[LakekeeperCatalogService] Response data:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error: any) {
      logger.error(`[LakekeeperCatalogService] Failed to create table. Status: ${error.response?.status}, Message: ${error.response?.data?.message || error.message}`);
      logger.error(`[LakekeeperCatalogService] Error details:`, error.response?.data || error.message);
      logger.error(`[LakekeeperCatalogService] Request details:`, {
        url: `/catalog/v1/${warehouseId}/namespaces/${namespaceStr}/tables`,
        warehouseId,
        namespace: namespaceStr,
        tableName: request.name,
      });
      throw new Error(
        `Failed to create table: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Get table metadata
   * GET /catalog/v1/{warehouse-prefix}/namespaces/{namespace}/tables/{table}
   */
  async getTable(namespace: string[], tableName: string, warehouseName?: string): Promise<CatalogTable> {
    const prefix = await this.resolveWarehousePrefix(warehouseName);
    try {
      const namespaceStr = namespace.join('.');
      const url = `/catalog/v1/${prefix}/namespaces/${namespaceStr}/tables/${tableName}`;
      const response = await this.client.get(url);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        // Lakekeeper accepts both '.' and unit-separator joins; retry with the latter.
        try {
          const namespaceStr = namespace.join('\x1F');
          const url = `/catalog/v1/${prefix}/namespaces/${namespaceStr}/tables/${tableName}`;
          const response = await this.client.get(url);
          return response.data;
        } catch (retryError: any) {
          throw new Error(
            `Table '${namespace.join('.')}.${tableName}' not found`
          );
        }
      }
      throw new Error(
        `Failed to get table: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Update table metadata
   * Note: The REST Catalog API doesn't have a direct metadata update endpoint
   * Metadata updates are typically done through commit operations
   * This might need to be implemented differently based on actual API
   */
  async updateTableMetadata(
    namespace: string[],
    tableName: string,
    metadata: UpdateTableMetadataRequest,
    warehouseName?: string
  ): Promise<CatalogTable> {
    try {
      // For now, get the table and return it
      // Full metadata updates would require commit operations
      logger.warn('[LakekeeperCatalogService] updateTableMetadata: Direct metadata updates may not be supported. Use commit operations for full updates.');
      return await this.getTable(namespace, tableName, warehouseName);
    } catch (error: any) {
      throw new Error(
        `Failed to update table metadata: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Delete table
   * DELETE /catalog/v1/{warehouse-prefix}/namespaces/{namespace}/tables/{table}
   *
   * `purge` maps to the Iceberg REST spec's `purgeRequested` query param. Without it,
   * Lakekeeper only removes the catalog metadata entry and leaves the underlying data
   * files (e.g. parquet) at the table's storage location. Since Iceberg requires a
   * table's location to be empty at creation time, a later re-create at that same
   * location (e.g. a dataset re-import) then fails with "Unexpected files in
   * location, tabular locations have to be empty". Callers that intend to fully drop
   * a table before recreating it at the same location must pass `purge: true`.
   */
  async deleteTable(
    namespace: string[],
    tableName: string,
    warehouseName?: string,
    options?: { purge?: boolean },
  ): Promise<void> {
    const prefix = await this.resolveWarehousePrefix(warehouseName);
    const query = options?.purge ? '?purgeRequested=true' : '';
    try {
      const namespaceStr = namespace.join('.');
      const url = `/catalog/v1/${prefix}/namespaces/${namespaceStr}/tables/${tableName}${query}`;
      await this.client.delete(url);
    } catch (error: any) {
      if (error.response?.status === 404) {
        try {
          const namespaceStr = namespace.join('\x1F');
          const url = `/catalog/v1/${prefix}/namespaces/${namespaceStr}/tables/${tableName}${query}`;
          await this.client.delete(url);
          return;
        } catch (retryError: any) {
          throw new Error(
            `Failed to delete table: ${retryError.response?.data?.message || retryError.message}`
          );
        }
      }
      throw new Error(
        `Failed to delete table: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * List tables in a namespace
   * GET /catalog/v1/{warehouse-prefix}/namespaces/{namespace}/tables
   */
  async listTables(namespace: string[], warehouseName?: string): Promise<string[]> {
    const prefix = await this.resolveWarehousePrefix(warehouseName);
    try {
      const namespaceStr = namespace.join('.');
      const url = `/catalog/v1/${prefix}/namespaces/${namespaceStr}/tables`;
      const response = await this.client.get(url);
      // Response format: { identifiers: [{ name: string, namespace: string[] }] }
      const identifiers = response.data?.identifiers || [];
      // Extract table names from identifiers
      return identifiers.map((id: any) => id.name || id);
    } catch (error: any) {
      if (error.response?.status === 404) {
        try {
          const namespaceStr = namespace.join('\x1F');
          const url = `/catalog/v1/${prefix}/namespaces/${namespaceStr}/tables`;
          const response = await this.client.get(url);
          const identifiers = response.data?.identifiers || [];
          return identifiers.map((id: any) => id.name || id);
        } catch (retryError: any) {
          throw new Error(
            `Failed to list tables: ${retryError.response?.data?.message || retryError.message}`
          );
        }
      }
      throw new Error(
        `Failed to list tables: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Get table schema
   * Helper method to extract schema from table metadata
   */
  async getTableSchema(namespace: string[], tableName: string, warehouseName?: string): Promise<IcebergSchema | null> {
    try {
      const table = await this.getTable(namespace, tableName, warehouseName);
      if (!table.metadata?.schemas || table.metadata.schemas.length === 0) {
        return null;
      }

      const currentSchema = table.metadata.schemas.find(
        (s) => s['schema-id'] === table.metadata['current-schema-id']
      ) || table.metadata.schemas[0];

      return {
        type: 'struct',
        fields: currentSchema.fields.map((field) => ({
          id: field.id,
          name: field.name,
          type: field.type,
          required: field.required,
          doc: field.doc,
        })),
      };
    } catch (error: any) {
      throw new Error(
        `Failed to get table schema: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Get table snapshots
   * Helper method to extract snapshots from table metadata
   */
  async getTableSnapshots(namespace: string[], tableName: string, warehouseName?: string): Promise<Array<{
    'snapshot-id': number;
    'parent-snapshot-id'?: number;
    'timestamp-ms': number;
    'summary'?: Record<string, string>;
    'manifest-list'?: string;
  }>> {
    try {
      const table = await this.getTable(namespace, tableName, warehouseName);
      return (table.metadata?.snapshots as any[]) || [];
    } catch (error: any) {
      throw new Error(
        `Failed to get table snapshots: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Return the `current-snapshot-id` for a table, or null when no snapshot
   * exists yet (e.g. immediately after table creation with no committed data).
   */
  async getCurrentSnapshotId(namespace: string[], tableName: string, warehouseName?: string): Promise<number | null> {
    const table = await this.getTable(namespace, tableName, warehouseName);
    const current = (table.metadata as any)?.['current-snapshot-id'];
    return typeof current === 'number' ? current : null;
  }

  /**
   * POST an Iceberg REST `commitTable` request. Wraps the namespace-encoding
   * fallback used by `getTable`/`deleteTable` so callers don't have to repeat it.
   */
  private async commitTable(
    namespace: string[],
    tableName: string,
    body: Record<string, unknown>,
  ): Promise<CatalogTable> {
    try {
      const url = `/v1//namespaces/${namespace.join('.')}/tables/${tableName}`.replace('//', '/');
      const response = await this.client.post(url, body);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        // Lakekeeper accepts both '.' and unit-separator joins; retry with the latter.
        const url = `/v1//namespaces/${namespace.join('\x1F')}/tables/${tableName}`;
        const response = await this.client.post(url, body);
        return response.data;
      }
      throw new Error(
        `Failed to commit table: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  /**
   * Move the table's `main` branch to point at `snapshotId`. Equivalent to
   * Iceberg's `rollback_to_snapshot` when used to roll back to a parent.
   *
   * If `expectedCurrentSnapshotId` is provided we send an `assert-ref-snapshot-id`
   * requirement so concurrent commits race-fail rather than silently overwriting
   * a newer current.
   */
  async setCurrentSnapshot(
    namespace: string[],
    tableName: string,
    snapshotId: number,
    expectedCurrentSnapshotId?: number | null,
  ): Promise<CatalogTable> {
    const requirements: Record<string, unknown>[] = [];
    if (typeof expectedCurrentSnapshotId === 'number') {
      requirements.push({
        type: 'assert-ref-snapshot-id',
        ref: 'main',
        'snapshot-id': expectedCurrentSnapshotId,
      });
    }
    const body = {
      identifier: { namespace, name: tableName },
      requirements,
      updates: [
        {
          action: 'set-snapshot-ref',
          'ref-name': 'main',
          'snapshot-id': snapshotId,
          type: 'branch',
        },
      ],
    };
    return await this.commitTable(namespace, tableName, body);
  }

  /**
   * Expire a single snapshot. When the target is the current snapshot we
   * first move `main` to its parent (so the table never points at a missing
   * snapshot); the resulting layout matches the user-facing description
   * "expire latest -> previous becomes current".
   *
   * Throws when the target snapshot is the last remaining snapshot in the
   * table (Iceberg requires at least one snapshot once data has been written).
   */
  async expireSnapshot(
    namespace: string[],
    tableName: string,
    snapshotId: number,
  ): Promise<{ table: CatalogTable; newCurrentSnapshotId: number | null }> {
    const snapshots = await this.getTableSnapshots(namespace, tableName);
    if (!snapshots.some((s) => s['snapshot-id'] === snapshotId)) {
      throw new Error(`Snapshot ${snapshotId} not found on ${namespace.join('.')}.${tableName}`);
    }
    if (snapshots.length <= 1) {
      throw new Error(
        `Cannot expire snapshot ${snapshotId}: it is the only snapshot on the table`,
      );
    }

    const currentId = await this.getCurrentSnapshotId(namespace, tableName);
    let newCurrent: number | null = currentId;

    if (currentId === snapshotId) {
      const target = snapshots.find((s) => s['snapshot-id'] === snapshotId);
      const parentId =
        typeof target?.['parent-snapshot-id'] === 'number'
          ? (target!['parent-snapshot-id'] as number)
          : null;
      if (parentId == null) {
        // No parent — pick the most recent OTHER snapshot as the new current.
        const fallback = snapshots
          .filter((s) => s['snapshot-id'] !== snapshotId)
          .sort((a, b) => Number(b['timestamp-ms']) - Number(a['timestamp-ms']))[0];
        newCurrent = fallback ? Number(fallback['snapshot-id']) : null;
      } else {
        newCurrent = parentId;
      }

      if (newCurrent == null) {
        throw new Error(
          `Cannot expire snapshot ${snapshotId}: no parent or sibling snapshot available to roll back to`,
        );
      }
      await this.setCurrentSnapshot(namespace, tableName, newCurrent, currentId);
    }

    // remove-snapshots: drop the snapshot from history. (Lakekeeper / Iceberg
    // REST may or may not garbage-collect referenced data files immediately;
    // the metadata pointer is what we care about for the user-facing behavior.)
    const body = {
      identifier: { namespace, name: tableName },
      requirements: [] as Record<string, unknown>[],
      updates: [
        {
          action: 'remove-snapshots',
          'snapshot-ids': [snapshotId],
        },
      ],
    };
    const table = await this.commitTable(namespace, tableName, body);
    return { table, newCurrentSnapshotId: newCurrent };
  }

  /**
   * Ensure namespace exists, create if it doesn't
   * @param namespace - Namespace array (e.g., ['project', 'dataset'])
   * @param warehouseName - Optional warehouse name to get warehouse ID from
   */
  async ensureNamespace(namespace: string[], warehouseName?: string, warehouseId?: string): Promise<Namespace> {
    const namespaceStr = namespace.join('.');
    logger.info(`[LakekeeperCatalogService] Ensuring namespace exists: ${namespaceStr}`);
    
    // Get warehouse ID if not provided directly
    let warehouseIdToUse: string | undefined = warehouseId;
    if (!warehouseIdToUse && warehouseName) {
      try {
        const warehouse = await this.getWarehouse(warehouseName);
        warehouseIdToUse = (warehouse as any).warehouseId;
        logger.info(`[LakekeeperCatalogService] Retrieved warehouse ID for ${warehouseName}: ${warehouseIdToUse} (cached: ${this.warehouseId})`);
        
        // If getWarehouse didn't return warehouseId but we have a cached one, use it
        if (!warehouseIdToUse && this.warehouseId) {
          logger.info(`[LakekeeperCatalogService] Using cached warehouse ID: ${this.warehouseId}`);
          warehouseIdToUse = this.warehouseId;
        }
        
        // Validate warehouse ID was found
        if (!warehouseIdToUse) {
          logger.error(`[LakekeeperCatalogService] Warehouse ID not found in response. Warehouse object:`, JSON.stringify(warehouse, null, 2));
          throw new Error(`Warehouse ID not found for warehouse '${warehouseName}'. The warehouse may not have been created properly.`);
        }
      } catch (error: any) {
        logger.error(`[LakekeeperCatalogService] Failed to get warehouse ID: ${error.message}`);
        throw new Error(`Failed to get warehouse ID for ${warehouseName}: ${error.message}`);
      }
    }
    
    // Use cached warehouse ID if still not available
    if (!warehouseIdToUse) {
      warehouseIdToUse = this.warehouseId;
    }
    
    // Validate warehouse ID is available before proceeding
    if (!warehouseIdToUse) {
      throw new Error('Warehouse ID is required to check namespace. Please provide warehouseId or warehouseName parameter, or ensure a warehouse has been accessed first.');
    }
    
    try {
      logger.info(`[LakekeeperCatalogService] Checking if namespace exists: ${namespaceStr}`);
      const existing = await this.getNamespace(warehouseIdToUse, namespace);
      logger.info(`[LakekeeperCatalogService] Namespace already exists: ${namespaceStr}`);
      return existing;
    } catch (error: any) {
      if (error.message.includes('not found')) {
        // Create namespace if it doesn't exist
        logger.info(`[LakekeeperCatalogService] Namespace not found, creating: ${namespaceStr}`);
        if (!warehouseIdToUse) {
          throw new Error('Warehouse ID is required to create a namespace. Please provide warehouseId or warehouseName parameter, or ensure a warehouse has been accessed first.');
        }
        logger.info(`[LakekeeperCatalogService] Creating namespace with warehouse ID: ${warehouseIdToUse}`);
        return await this.createNamespace({ namespace }, warehouseIdToUse);
      }
      logger.error(`[LakekeeperCatalogService] Error checking namespace: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ensure warehouse exists, create if it doesn't
   */
  async ensureWarehouse(name: string, uri?: string, properties?: Record<string, any>): Promise<Warehouse> {
    logger.info(`[LakekeeperCatalogService] Ensuring warehouse exists: ${name}`);
    
    try {
      logger.info(`[LakekeeperCatalogService] Checking if warehouse exists: ${name}`);
      const existing = await this.getWarehouse(name);
      logger.info(`[LakekeeperCatalogService] Warehouse already exists: ${name}`);
      return existing;
    } catch (error: any) {
      if (error.message.includes('not found')) {
        // Before creating, check if service is reachable
        logger.info(`[LakekeeperCatalogService] Warehouse not found, checking service health before creating: ${name}`);
        const isHealthy = await this.healthCheck();
        if (!isHealthy) {
          throw new Error(`Lakekeeper service is not reachable at ${this.baseUrl}. Please verify the service is running and the URL is correct.`);
        }
        logger.info(`[LakekeeperCatalogService] Service health check passed, creating warehouse: ${name}`);
        
        // Create warehouse using the correct API endpoint
        const warehouse: Warehouse = { name, uri, properties: properties || {} };
        return await this.createWarehouse(warehouse);
      }
      logger.error(`[LakekeeperCatalogService] Error checking warehouse: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update table schema with LanceDB schema
   * This updates the catalog table with the processed schema from LanceDB
   */
  async updateTableSchema(
    namespace: string[],
    tableName: string,
    schema: IcebergSchema,
    warehouseName?: string
  ): Promise<CatalogTable> {
    logger.info(`[LakekeeperCatalogService] Updating table schema: ${namespace.join('.')}.${tableName}`);

    // Ensure the table exists before attempting metadata update
    await this.getTable(namespace, tableName, warehouseName);

    // Update schema in metadata
    const updatedMetadata: UpdateTableMetadataRequest = {
      'current-schema-id': schema.fields.length > 0 ? schema.fields[0].id || 1 : 1,
      'schemas': [
        {
          'schema-id': schema.fields.length > 0 ? schema.fields[0].id || 1 : 1,
          fields: schema.fields.map(field => ({
            id: field.id,
            name: field.name,
            type: typeof field.type === 'string' ? field.type : JSON.stringify(field.type),
            required: field.required,
            doc: field.doc,
          })),
        },
      ],
    };

    // Use updateTableMetadata to update the schema
    // Note: This may require Iceberg commit operations for full support
    return await this.updateTableMetadata(namespace, tableName, updatedMetadata, warehouseName);
  }
}

import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios'
import { withRetry } from '../utils/withRetry'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

/**
 * Thrown when the browser couldn't get any response back from the S3 endpoint.
 *
 * In practice this almost always means the user's browser hasn't accepted the
 * (self-signed) TLS certificate for `s3.<endpoint>` yet, but it can also indicate
 * CORS preflight rejection, DNS failure, or the gateway being down. Either way,
 * the remediation we surface — opening the S3 origin in a new tab — both lets
 * the user accept the certificate and reveals any underlying error.
 */
export class S3EndpointConnectionError extends Error {
  endpoint: string
  cause?: unknown

  constructor(endpoint: string, cause?: unknown) {
    super(
      `The browser couldn't reach the S3 endpoint at ${endpoint}. ` +
      `This usually means the self-signed TLS certificate for the S3 gateway hasn't ` +
      `been accepted by your browser yet, or the gateway is unreachable.`
    )
    this.name = 'S3EndpointConnectionError'
    this.endpoint = endpoint
    this.cause = cause
  }
}

/**
 * Detect "no response from server" errors that we want to convert into an
 * `S3EndpointConnectionError`. Excludes explicit cancellations / aborts.
 */
const isNoResponseError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  if (axios.isCancel(error)) return false
  const axErr = error as AxiosError
  if (axErr.code === 'ERR_CANCELED' || axErr.code === 'ECONNABORTED') return false
  return !axErr.response
}

// API client for config-service (deployment APIs, routing, health, etc.)
// Note: All APIs now go through config-service
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // Add timeout to prevent hanging requests
})

// KB API client for kb-retrieval-service (knowledge base search/retrieval)
// Mounted at /kb on the API gateway, similar to /config for config-service
const kbApi = axios.create({
  baseURL: '/kb',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
})

// Token getter function - will be set by AuthContext
let tokenGetter: (() => string | null) | null = null
let tokenRefresher: (() => Promise<void>) | null = null

// Set token getter and refresher from AuthContext
export const setAuthTokenGetter = (getter: () => string | null, refresher: () => Promise<void>) => {
  tokenGetter = getter
  tokenRefresher = refresher
}

// Request interceptor to add JWT token
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Skip adding auth headers for public endpoints
    const isPublicEndpoint = config.url?.includes('/setup/') || 
                             config.url?.includes('/health') ||
                             config.url?.includes('/ready')
    
    if (!isPublicEndpoint && tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor to handle 401 and token refresh
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    // Skip token refresh for public endpoints (setup, health, etc.)
    const isPublicEndpoint = originalRequest.url?.includes('/setup/') || 
                             originalRequest.url?.includes('/health') ||
                             originalRequest.url?.includes('/ready')

    // If we get a 401 and haven't already retried, try to refresh the token
    // But skip for public endpoints that don't require auth
    if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher && !isPublicEndpoint) {
      originalRequest._retry = true

      try {
        await tokenRefresher()
        
        // Retry the original request with new token
        if (tokenGetter && originalRequest.headers) {
          const newToken = tokenGetter()
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            return api(originalRequest)
          }
        }
      } catch (refreshError) {
        // Token refresh failed, redirect to login
        console.error('Token refresh failed:', refreshError)
        // Clear any stored auth state
        window.location.href = `${import.meta.env.VITE_BASE_PATH || ''}/login`
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

// Request interceptor to add JWT token for kbApi
kbApi.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor to handle 401 and token refresh for kbApi
kbApi.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher) {
      originalRequest._retry = true

      try {
        await tokenRefresher()
        
        if (tokenGetter && originalRequest.headers) {
          const newToken = tokenGetter()
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            return kbApi(originalRequest)
          }
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError)
        window.location.href = `${import.meta.env.VITE_BASE_PATH || ''}/login`
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

/**
 * User-visible message from API errors. Prefers server JSON (`error`, `message`, `detail`) over
 * axios's generic "Request failed with status code …" text.
 */
export function getApiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: unknown; message?: unknown; detail?: unknown }
      | undefined
    if (data) {
      const e = data.error
      const m = data.message
      const d = data.detail
      if (typeof e === 'string' && e.trim()) return e.trim()
      if (typeof m === 'string' && m.trim()) return m.trim()
      if (typeof d === 'string' && d.trim()) return d.trim()
    }
  }
  if (err instanceof Error && err.message?.trim()) return err.message.trim()
  return fallback
}

// Analytics Engine API client for dataset preview and query endpoints
// Mounted at /analytics on the API gateway (prefix-stripped)
const analyticsApi = axios.create({
  baseURL: '/analytics',
  headers: { 'Content-Type': 'application/json' },
  timeout: 35000,
})

analyticsApi.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

analyticsApi.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher) {
      originalRequest._retry = true

      try {
        await tokenRefresher()

        if (tokenGetter && originalRequest.headers) {
          const newToken = tokenGetter()
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            return analyticsApi(originalRequest)
          }
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError)
        window.location.href = `${import.meta.env.VITE_BASE_PATH || ''}/login`
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

// Agent Service API client for agent invocation endpoints
// Mounted at /agents on the API gateway (prefix-stripped)
const agentServiceApi = axios.create({
  baseURL: '/agents',
  headers: { 'Content-Type': 'application/json' },
  timeout: 60000,
})

agentServiceApi.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

agentServiceApi.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher) {
      originalRequest._retry = true

      try {
        await tokenRefresher()

        if (tokenGetter && originalRequest.headers) {
          const newToken = tokenGetter()
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            return agentServiceApi(originalRequest)
          }
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError)
        window.location.href = `${import.meta.env.VITE_BASE_PATH || ''}/login`
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

export function getAuthToken(): string | null {
  return tokenGetter ? tokenGetter() : null
}

// Workflow API client for workflow-engine (workflow status, logs)
// Mounted at /workflow on the API gateway
const workflowApiClient = axios.create({
  baseURL: '/workflow',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
})

// Request interceptor to add JWT token for workflowApiClient
workflowApiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor to handle 401 and token refresh for workflowApiClient
workflowApiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher) {
      originalRequest._retry = true

      try {
        await tokenRefresher()
        
        if (tokenGetter && originalRequest.headers) {
          const newToken = tokenGetter()
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            return workflowApiClient(originalRequest)
          }
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError)
        window.location.href = `${import.meta.env.VITE_BASE_PATH || ''}/login`
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

export interface Project {
  id: string
  name: string
  created_at: string
  updated_at: string
  metadata?: Record<string, any>
  home_dir: string
  // Present on items returned by GET /api/v1/projects (the caller's role on
  // each project). Optional because single-project fetches do not include it.
  role?: 'admin' | 'member' | 'viewer'
}

export interface CreateProjectRequest {
  name: string
  metadata?: Record<string, any>
}

export interface UpdateProjectRequest {
  name?: string
  metadata?: Record<string, any>
}

export interface VolumeInfo {
  type: string
  endpoint?: string // Optional for dynamic provisioning
  mount_options?: string[]
  // NEW fields
  provisioning_mode?: 'static' | 'dynamic'
  storage_class_name?: string
  storage_size?: string
  parameters?: Record<string, string>
}

export interface AuthInfo {
  type: string
  username?: string
  password_encrypted?: string
  [key: string]: any
}

export interface DeploymentConfig {
  [key: string]: any
}

export interface Bucket {
  project_id: string
  name: string
  region: string
  volume_info: VolumeInfo
  auth_info: AuthInfo
  protocol: string
  deployment_config?: DeploymentConfig
  created_at: string
  updated_at: string
  metadata?: Record<string, any>
}

export interface StorageClass {
  name: string
  provisioner: string
  parameters?: Record<string, string>
  allowVolumeExpansion?: boolean
  volumeBindingMode?: string
  reclaimPolicy?: string
}

export interface CreateBucketRequest {
  name: string
  region: string
  volume_info: VolumeInfo
  auth_info: AuthInfo
  protocol: string
  deployment_config?: DeploymentConfig
  metadata?: Record<string, any>
}

export interface UpdateBucketRequest {
  region?: string
  volume_info?: Partial<VolumeInfo>
  auth_info?: Partial<AuthInfo>
  protocol?: string
  deployment_config?: Partial<DeploymentConfig>
  metadata?: Record<string, any>
}

export interface Deployment {
  id: string
  region: string
  endpoint: string
  status?: 'healthy' | 'unhealthy' | 'unknown'
  capacity?: {
    max_buckets?: number
    max_storage_gb?: number
  }
  capabilities?: string[]
  registered_at?: string
  last_health_check?: string
  created_at?: string
  updated_at?: string
}

export interface BucketRoutingResponse {
  bucket_name: string
  project_id: string
  deployments: RoutingDeploymentInfo[]
  routing_strategy: string
  updated_at: string
}

export interface RoutingDeploymentInfo {
  deployment_id: string
  role: string
  priority: number
  endpoint: string
  health_status: 'healthy' | 'unhealthy' | 'unknown'
  load_balance_weight: number
  last_health_check: string
}

// Project APIs (use config-service)
export const projectApi = {
  list: async (): Promise<Project[]> => {
    const response = await configServiceApi.get<{ projects: Project[] }>('/api/v1/projects')
    return response.data.projects
  },

  get: async (projectId: string): Promise<Project> => {
    const response = await configServiceApi.get<Project>(`/api/v1/projects/${projectId}`)
    return response.data
  },

  create: async (data: CreateProjectRequest): Promise<Project> => {
    const response = await configServiceApi.post<Project>('/api/v1/projects', data)
    return response.data
  },

  update: async (projectId: string, data: UpdateProjectRequest): Promise<Project> => {
    const response = await configServiceApi.put<Project>(`/api/v1/projects/${projectId}`, data)
    return response.data
  },

  delete: async (projectId: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}`)
  },

  /** Aggregated dataset stats for project overview (structured/unstructured, manifests, files). */
  getOverviewDatasetMetrics: async (
    projectId: string
  ): Promise<{
    structured: number
    unstructured: number
    datasetsTotal: number
    manifestVersions: number
    filesInManifests: number
  }> => {
    const response = await configServiceApi.get<{
      structured: number
      unstructured: number
      datasetsTotal: number
      manifestVersions: number
      filesInManifests: number
    }>(`/api/v1/projects/${projectId}/overview-dataset-metrics`)
    return response.data
  },
}

// Bucket APIs (use config-service for CRUD, project-service for routing)
export const bucketApi = {
  list: async (projectId: string): Promise<Bucket[]> => {
    const response = await configServiceApi.get<{ buckets: Bucket[] }>(`/api/v1/projects/${projectId}/buckets`)
    return response.data.buckets
  },

  // List buckets directly from S3 via apigateway
  // Makes a direct S3 ListBuckets API call to the S3 gateway through apigateway
  listFromS3: async (): Promise<string[]> => {
    try {
      // Get the deployment endpoint from window location
      const protocol = window.location.protocol
      const hostname = window.location.hostname
      const port = window.location.port
      
      // Construct S3 endpoint with s3. prefix
      let s3Endpoint = `${protocol}//s3.${hostname}`
      if (port) {
        s3Endpoint += `:${port}`
      }
      
      // Make S3 ListBuckets request
      // S3 API: GET / with no query params returns list of buckets
      const response = await axios.get(`${s3Endpoint}/`, {
        headers: {
          'Authorization': `Bearer ${tokenGetter?.()}`,
        },
        responseType: 'text',
      })
      
      // Parse XML response
      const parser = new DOMParser()
      const xmlDoc = parser.parseFromString(response.data, 'text/xml')
      
      // Extract bucket names from XML
      // S3 XML format: <ListAllMyBucketsResult><Buckets><Bucket><Name>bucket-name</Name></Bucket>...</Buckets></ListAllMyBucketsResult>
      const bucketElements = xmlDoc.getElementsByTagName('Name')
      const bucketNames: string[] = []
      
      for (let i = 0; i < bucketElements.length; i++) {
        const name = bucketElements[i].textContent
        if (name) {
          bucketNames.push(name)
        }
      }
      
      return bucketNames
    } catch (error: any) {
      console.error('Failed to list buckets from S3:', error)
      // Return empty array on failure so the app doesn't break
      return []
    }
  },

  get: async (projectId: string, bucketName: string): Promise<Bucket> => {
    const response = await configServiceApi.get<Bucket>(`/api/v1/projects/${projectId}/buckets/${bucketName}`)
    return response.data
  },

  create: async (projectId: string, data: CreateBucketRequest): Promise<Bucket> => {
    const response = await configServiceApi.post<Bucket>(`/api/v1/projects/${projectId}/buckets`, data)
    return response.data
  },

  update: async (
    projectId: string,
    bucketName: string,
    data: UpdateBucketRequest
  ): Promise<Bucket> => {
    const response = await configServiceApi.put<Bucket>(
      `/api/v1/projects/${projectId}/buckets/${bucketName}`,
      data
    )
    return response.data
  },

  delete: async (projectId: string, bucketName: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/buckets/${bucketName}`)
  },

  // Routing API now uses config-service
  getRouting: async (projectId: string, bucketName: string): Promise<BucketRoutingResponse> => {
    const response = await configServiceApi.get<BucketRoutingResponse>(
      `/api/v1/buckets/${projectId}/${bucketName}/routing`
    )
    return response.data
  },
}

// StorageClass APIs (now uses config-service)
export const storageClassApi = {
  list: async (): Promise<StorageClass[]> => {
    try {
      const response = await configServiceApi.get<{ storage_classes: StorageClass[] }>('/api/v1/storage-classes')
      return response.data.storage_classes
    } catch (error) {
      console.error('Failed to fetch StorageClasses:', error)
      // Return empty array - storage classes should come from ray deployments only
      return []
    }
  },
}

// Bucket Health APIs
export interface BucketHealth {
  project_id: string
  bucket_name: string
  deployment_id: string
  timestamp: string
  healthy: boolean
  status_message?: string
  volume_mount_status?: {
    mounted: boolean
    status: string
  }
}

export const bucketHealthApi = {
  get: async (projectId: string, bucketName: string): Promise<BucketHealth[]> => {
    try {
      const response = await configServiceApi.get<{ bucket_health: BucketHealth[] }>(
        `/api/v1/projects/${projectId}/buckets/${bucketName}/health`
      )
      return response.data.bucket_health
    } catch (error) {
      console.error('Failed to fetch bucket health:', error)
      return []
    }
  },
}

// Deployment APIs (now uses config-service)
export const deploymentApi = {
  list: async (): Promise<Deployment[]> => {
    try {
      const response = await configServiceApi.get<Deployment[] | { deployments: Deployment[] }>('/api/v1/deployments')
      // Handle both response formats: direct array or wrapped in object
      if (Array.isArray(response.data)) {
        return response.data
      }
      // If wrapped in object with deployments property
      if (response.data && typeof response.data === 'object' && 'deployments' in response.data) {
        return (response.data as { deployments: Deployment[] }).deployments || []
      }
      // Fallback to empty array
      return []
    } catch (error) {
      console.error('Failed to fetch deployments:', error)
      return []
    }
  },

  get: async (deploymentId: string): Promise<Deployment> => {
    const response = await configServiceApi.get<Deployment>(`/api/v1/deployments/${deploymentId}`)
    return response.data
  },
}

// S3 APIs (using standard S3 protocol via deployment endpoints)
// Uses deployment endpoints from routing info with "s3." prefix
// The "s3." prefix disambiguates S3 bucket names from ray service names
// Note: S3 clients are created dynamically per request using deployment endpoints

/**
 * Get the primary deployment endpoint from routing info
 * @param routingInfo - Bucket routing information
 * @returns Deployment endpoint URL or null if not available
 */
const getPrimaryDeploymentEndpoint = (routingInfo?: BucketRoutingResponse): string | null => {
  if (!routingInfo || !routingInfo.deployments || routingInfo.deployments.length === 0) {
    return null;
  }
  
  // Find the primary deployment with highest priority
  const primaryDeployments = routingInfo.deployments
    .filter(d => d.role === 'primary' && d.health_status === 'healthy')
    .sort((a, b) => b.priority - a.priority);
  
  if (primaryDeployments.length > 0) {
    return primaryDeployments[0].endpoint;
  }
  
  // Fallback to any primary deployment
  const anyPrimary = routingInfo.deployments
    .filter(d => d.role === 'primary')
    .sort((a, b) => b.priority - a.priority);
  
  if (anyPrimary.length > 0) {
    return anyPrimary[0].endpoint;
  }
  
  // Fallback to first deployment
  return routingInfo.deployments[0].endpoint;
};

/**
 * Console host defaults to app.{apex}; S3 gateway is s3.{apex}. Prepending s3. to
 * app.agentstudio.local would produce s3.app.agentstudio.local (bad DNS).
 */
const hostnameToS3GatewayHostname = (hostname: string): string => {
  if (hostname.startsWith('s3.')) {
    return hostname
  }
  if (hostname.startsWith('app.')) {
    return `s3.${hostname.slice(4)}`
  }
  return `s3.${hostname}`
}

/**
 * Get the default S3 endpoint for browser uploads.
 * Uses same-origin /s3 path (proxied by the API gateway) to avoid requiring
 * separate TLS certificate acceptance for the s3.<endpoint> subdomain.
 */
export const getDefaultS3Endpoint = (): string => {
  return `${window.location.protocol}//${window.location.host}/s3`
}

/**
 * Encode an S3 key path segment-by-segment.
 * Keeps "/" as path separator while safely encoding reserved characters once.
 */
const encodeS3KeyPath = (objectKey: string): string => {
  if (!objectKey) return ''
  return objectKey
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/**
 * Build path-style S3 URL path: /{bucket}/{encoded-key}
 */
const buildS3ObjectPath = (bucketName: string, objectKey?: string): string => {
  const encodedBucket = encodeURIComponent(bucketName)
  if (!objectKey) return `/${encodedBucket}`
  return `/${encodedBucket}/${encodeS3KeyPath(objectKey)}`
}

/**
 * Map deployment base URL to S3 gateway base URL (app.{apex} → s3.{apex}, etc.).
 */
const addS3PrefixToEndpoint = (endpoint: string): string => {
  if (!endpoint || !endpoint.startsWith('http')) {
    return endpoint;
  }
  
  try {
    const url = new URL(endpoint);
    const hostname = hostnameToS3GatewayHostname(url.hostname);
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return endpoint;
  }
};

/**
 * Create an S3 client using the default S3 endpoint (s3. subdomain)
 * Uses current window location with s3. prefix
 * @returns Axios instance configured for S3 requests
 */
export const createDefaultS3Client = () => {
  const s3Endpoint = getDefaultS3Endpoint();
  const client = axios.create({
    baseURL: s3Endpoint,
    responseType: 'text',
  });
  
  // Add authentication interceptor
  client.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (tokenGetter) {
        const token = tokenGetter()
        if (token && config.headers) {
          config.headers.Authorization = `Bearer ${token}`
        }
      }
      return config
    },
    (error) => {
      return Promise.reject(error)
    }
  )

  // Convert "no response from server" failures (typically caused by an
  // untrusted self-signed cert on `s3.<endpoint>`, sometimes by CORS/network)
  // into a typed error so the UI can offer a one-click remediation link.
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (isNoResponseError(error)) {
        return Promise.reject(new S3EndpointConnectionError(s3Endpoint, error))
      }
      return Promise.reject(error)
    }
  )

  return client;
}

/**
 * Create an S3 client for a specific deployment endpoint
 * Adds "s3." prefix to the endpoint to disambiguate S3 requests from ray service requests
* @param deploymentEndpoint - Full URL of the deployment endpoint (e.g., "https://us-east-1.agentstudio.local")
* @returns Axios instance configured for that deployment with "s3." prefix (e.g., "https://s3.us-east-1.agentstudio.local")
 */
const createDeploymentS3Client = (deploymentEndpoint: string) => {
  // Add "s3." prefix to the deployment endpoint for S3 requests
  const s3Endpoint = addS3PrefixToEndpoint(deploymentEndpoint);
  const client = axios.create({
    baseURL: s3Endpoint,
    headers: {
      // Direct access to deployment endpoint with S3 prefix
    },
    responseType: 'text',
  });

  // Add authentication interceptor (same as main API client)
  client.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (tokenGetter) {
        const token = tokenGetter()
        if (token && config.headers) {
          config.headers.Authorization = `Bearer ${token}`
        }
      }
      return config
    },
    (error) => {
      return Promise.reject(error)
    }
  )

  // Add response interceptor for token refresh (same as main API client)
  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

      // If we get a 401 and haven't already retried, try to refresh the token
      if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher) {
        originalRequest._retry = true
        try {
          await tokenRefresher()
          // Retry the request with the new token
          if (originalRequest.headers && tokenGetter) {
            const newToken = tokenGetter()
            if (newToken) {
              originalRequest.headers.Authorization = `Bearer ${newToken}`
            }
          }
          return client(originalRequest)
        } catch (refreshError) {
          // Token refresh failed, reject the request
          return Promise.reject(refreshError)
        }
      }
      return Promise.reject(error)
    }
  )

  // Same cert/network failure conversion as `createDefaultS3Client`. Registered
  // after the token-refresh interceptor so the typed error reaches callers last.
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (isNoResponseError(error)) {
        return Promise.reject(new S3EndpointConnectionError(s3Endpoint, error))
      }
      return Promise.reject(error)
    }
  )

  return client
};


// Parse S3 ListObjects/ListObjectsV2 XML response
// Handles both formats and projectd XML (versityGW uses xmlns="http://s3.amazonaws.com/doc/2006-03-01/")
function parseS3ListResponse(xmlText: string): any[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
  
  // Check for parsing errors
  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) {
    console.error('XML parsing error:', parserError.textContent);
    console.error('XML content:', xmlText.substring(0, 500));
    throw new Error('Failed to parse S3 XML response: ' + parserError.textContent);
  }

  const objects: any[] = [];
  
  // Check KeyCount to determine if bucket is empty (normal case) or if there's a parsing issue
  const keyCountElements = xmlDoc.getElementsByTagName('KeyCount');
  const keyCount = keyCountElements.length > 0 && keyCountElements[0].textContent
    ? parseInt(keyCountElements[0].textContent.trim(), 10)
    : null;
  
  // Get Contents elements using getElementsByTagName (works with projects)
  // This works regardless of whether XML has xmlns project or not
  const contents = xmlDoc.getElementsByTagName('Contents');
  
  // Only warn if KeyCount indicates there should be contents but we didn't find any
  // This helps catch parsing issues while not warning for empty buckets (KeyCount=0)
  if (contents.length === 0 && keyCount !== null && keyCount > 0) {
    // This is unexpected - KeyCount says there are items but we didn't parse any
    console.warn('No Contents elements found in XML response, but KeyCount indicates items exist', {
      keyCount,
      xmlPreview: xmlText.substring(0, 1000)
    });
  }
  // If KeyCount is 0 or null, empty bucket is expected - no warning needed
  
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    
    // Get child elements using getElementsByTagName (works with projects)
    const keyElements = content.getElementsByTagName('Key');
    const sizeElements = content.getElementsByTagName('Size');
    const lastModifiedElements = content.getElementsByTagName('LastModified');
    
    if (keyElements.length > 0 && keyElements[0].textContent) {
      const key = keyElements[0].textContent.trim();
      const size = sizeElements.length > 0 && sizeElements[0].textContent 
        ? parseInt(sizeElements[0].textContent.trim(), 10) 
        : 0;
      const lastModified = lastModifiedElements.length > 0 && lastModifiedElements[0].textContent
        ? lastModifiedElements[0].textContent.trim()
        : undefined;
      
      // Determine if it's a directory (ends with /)
      const isDirectory = key.endsWith('/');
      
      objects.push({
        key: key,
        size: size,
        lastModified: lastModified,
        isDirectory: isDirectory,
      });
    }
  }

  // Also check for CommonPrefixes (for "directories" in ListObjectsV2 with delimiter)
  const commonPrefixes = xmlDoc.getElementsByTagName('CommonPrefixes');
  for (let i = 0; i < commonPrefixes.length; i++) {
    const commonPrefix = commonPrefixes[i];
    const prefixElements = commonPrefix.getElementsByTagName('Prefix');
    if (prefixElements.length > 0 && prefixElements[0].textContent) {
      const prefix = prefixElements[0].textContent.trim();
      objects.push({
        key: prefix,
        size: undefined,
        lastModified: undefined,
        isDirectory: true,
      });
    }
  }

  return objects;
}

/** Use multipart upload at or above this object size (32 MiB). Smaller objects use a single PUT with retries. */
export const S3_MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024
const S3_MULTIPART_PART_SIZE = 8 * 1024 * 1024

function parseS3XmlFirstTag(xml: string, tag: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  return doc.querySelector(tag)?.textContent?.trim() ?? ''
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function s3CreateMultipartUpload(
  bucketName: string,
  objectKey: string,
  contentType: string
): Promise<string> {
  const client = createDefaultS3Client()
  const path = buildS3ObjectPath(bucketName, objectKey)
  const response = await client.post(`${path}?uploads`, null, {
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`CreateMultipartUpload failed with status ${response.status}`)
  }
  const data = typeof response.data === 'string' ? response.data : String(response.data ?? '')
  const uploadId = parseS3XmlFirstTag(data, 'UploadId')
  if (!uploadId) {
    throw new Error('CreateMultipartUpload returned no UploadId')
  }
  return uploadId
}

async function s3UploadPart(
  bucketName: string,
  objectKey: string,
  uploadId: string,
  partNumber: number,
  body: Blob,
  onPartProgress?: (loaded: number, total: number) => void
): Promise<string> {
  const client = createDefaultS3Client()
  const path = buildS3ObjectPath(bucketName, objectKey)
  const q = `partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`
  const response = await client.put(`${path}?${q}`, body, {
    headers: { 'Content-Type': 'application/octet-stream' },
    onUploadProgress: (ev) => {
      if (ev.total && onPartProgress) {
        onPartProgress(ev.loaded, ev.total)
      }
    },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`UploadPart failed with status ${response.status}`)
  }
  const headers = response.headers as Record<string, string | undefined>
  const raw = headers['etag'] ?? headers['ETag']
  if (!raw || typeof raw !== 'string') {
    throw new Error('UploadPart response missing ETag header')
  }
  return raw
}

async function s3CompleteMultipartUpload(
  bucketName: string,
  objectKey: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[]
): Promise<void> {
  const client = createDefaultS3Client()
  const path = buildS3ObjectPath(bucketName, objectKey)
  const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber)
  const xml = `<CompleteMultipartUpload>${sorted
    .map(
      (p) =>
        `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${escapeXmlText(p.ETag)}</ETag></Part>`
    )
    .join('')}</CompleteMultipartUpload>`
  const response = await client.post(`${path}?uploadId=${encodeURIComponent(uploadId)}`, xml, {
    headers: { 'Content-Type': 'application/xml' },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`CompleteMultipartUpload failed with status ${response.status}`)
  }
}

async function s3AbortMultipartUpload(
  bucketName: string,
  objectKey: string,
  uploadId: string
): Promise<void> {
  const client = createDefaultS3Client()
  const path = buildS3ObjectPath(bucketName, objectKey)
  await client.delete(`${path}?uploadId=${encodeURIComponent(uploadId)}`)
}

async function multipartUploadLargeFile(
  bucketName: string,
  objectKey: string,
  file: File | Blob,
  _projectId: string | undefined,
  onProgress?: (uploaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');

  const STALL_TIMEOUT_MS = 60_000;
  const totalSize = file.size
  let uploadId: string | undefined
  let lastPartProgressTime = Date.now();

  try {
    const ct =
      file instanceof File ? file.type || 'application/octet-stream' : 'application/octet-stream'
    uploadId = await withRetry(() => s3CreateMultipartUpload(bucketName, objectKey, ct))
    const parts: { PartNumber: number; ETag: string }[] = []
    let offset = 0
    let partNumber = 1
    while (offset < totalSize) {
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');

      // Stall detection between parts
      if (Date.now() - lastPartProgressTime > STALL_TIMEOUT_MS) {
        throw new Error('Upload stalled — no data transferred for 60 seconds. The storage server may be temporarily unreachable.');
      }

      const end = Math.min(offset + S3_MULTIPART_PART_SIZE, totalSize)
      const blob = file.slice(offset, end)
      const etag = await withRetry(() =>
        s3UploadPart(bucketName, objectKey, uploadId!, partNumber, blob, (loaded, _partTotal) => {
          lastPartProgressTime = Date.now();
          onProgress?.(Math.min(offset + loaded, totalSize), totalSize)
        })
      )
      lastPartProgressTime = Date.now();
      parts.push({ PartNumber: partNumber, ETag: etag })
      offset = end
      partNumber++
      onProgress?.(offset, totalSize)
    }
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
    await withRetry(() => s3CompleteMultipartUpload(bucketName, objectKey, uploadId!, parts))
    onProgress?.(totalSize, totalSize)
  } catch (e) {
    if (uploadId) {
      try {
        await s3AbortMultipartUpload(bucketName, objectKey, uploadId)
      } catch {
        /* best-effort cleanup */
      }
    }
    throw e
  }
}

export const s3Api = {
  listBuckets: async (projectId: string): Promise<string[]> => {
    // Use datasource API to get volume list
    const dataSources = await datasourceApi.list(projectId, { type: 'volume' });
    return dataSources.map(ds => ds.name);
  },

  /**
   * List objects in a bucket using S3 ListObjectsV2 API
   * Uses default S3 endpoint with s3. subdomain prefix
   * @param bucketName - Name of the bucket
   * @param prefix - Optional prefix to filter objects (e.g., "folder/subfolder/")
   * @returns Array of S3 objects
   */
  listObjects: async (
    bucketName: string, 
    prefix?: string,
    delimiter?: string
  ): Promise<any[]> => {
    const params: Record<string, string> = {
      'list-type': '2', // Use ListObjectsV2
    };
    
    if (prefix) {
      params.prefix = prefix;
    }

    if (delimiter) {
      params.delimiter = delimiter;
    }
    
    const client = createDefaultS3Client();
    
    try {
      const response = await client.get(buildS3ObjectPath(bucketName), {
        params: params,
      });
      
      // Parse XML response from versityGW
      if (typeof response.data === 'string') {
        return parseS3ListResponse(response.data);
      }
      
      return [];
    } catch (error: any) {
      // Handle S3 errors (they come as XML)
      if (error.response) {
        if (typeof error.response.data === 'string') {
          try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(error.response.data, 'text/xml');
            const messageElement = xmlDoc.querySelector('Message');
            const codeElement = xmlDoc.querySelector('Code');
            const errorMessage = messageElement?.textContent || 'S3 request failed';
            const errorCode = codeElement?.textContent || '';
            throw new Error(`${errorCode ? `${errorCode}: ` : ''}${errorMessage}`);
          } catch (parseError) {
            throw new Error(error.response.data || `S3 request failed with status ${error.response.status}`);
          }
        } else {
          throw new Error(`S3 request failed with status ${error.response.status}`);
        }
      }
      throw error;
    }
  },

  /**
   * Get an object from S3
   * Uses default S3 endpoint with s3. subdomain prefix
   * @param bucketName - Name of the bucket
   * @param objectKey - Key/path of the object
   * @param projectId - Project ID (for error messages, optional)
   * @returns Blob/ArrayBuffer of the object data
   */
  getObject: async (
    bucketName: string, 
    objectKey: string, 
    _projectId?: string
  ): Promise<Blob> => {
    const client = createDefaultS3Client();
    
    try {
      const response = await client.get(buildS3ObjectPath(bucketName, objectKey), {
        responseType: 'blob', // For binary data
      });
      
      return response.data;
    } catch (error: any) {
      if (error.response) {
        if (typeof error.response.data === 'string') {
          try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(error.response.data, 'text/xml');
            const messageElement = xmlDoc.querySelector('Message');
            const errorMessage = messageElement?.textContent || 'Failed to get object';
            throw new Error(errorMessage);
          } catch {
            throw new Error(error.response.data || `Failed to get object: ${error.response.status}`);
          }
        } else {
          throw new Error(`Failed to get object: ${error.response.status}`);
        }
      }
      throw error;
    }
  },

  /**
   * Get object download URL (for browser download, not redirect)
   * Creates a blob URL that can be used for downloading
   * Uses default S3 endpoint with s3. subdomain prefix
   * @param bucketName - Name of the bucket
   * @param objectKey - Key/path of the object
   * @param projectId - Project ID (for error messages, optional)
   */
  getObjectDownloadUrl: async (
    bucketName: string, 
    objectKey: string, 
    projectId?: string
  ): Promise<string> => {
    const blob = await s3Api.getObject(bucketName, objectKey, projectId);
    return URL.createObjectURL(blob);
  },

  /**
   * Upload an object to S3 (PUT)
   * Uses default S3 endpoint with s3. subdomain prefix
   * @param bucketName - Name of the bucket
   * @param objectKey - Key/path of the object
   * @param file - File or Blob to upload
   * @param projectId - Project ID (for error messages, optional)
   * @param onProgress - Optional progress callback (bytes uploaded, total bytes)
   */
  putObject: async (
    bucketName: string,
    objectKey: string,
    file: File | Blob,
    _projectId?: string,
    onProgress?: (uploaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');

    const s3Endpoint = getDefaultS3Endpoint();
    const normalizedEndpoint = s3Endpoint.replace(/\/+$/, '');
    const fullUrl = `${normalizedEndpoint}${buildS3ObjectPath(bucketName, objectKey)}`;
    const xhr = new XMLHttpRequest();

    return new Promise((resolve, reject) => {
      const STALL_TIMEOUT_MS = 60_000;
      let lastProgressTime = Date.now();
      let stallTimer: ReturnType<typeof setInterval> | undefined;
      let settled = false;

      const cleanup = () => {
        settled = true;
        if (stallTimer != null) clearInterval(stallTimer);
      };

      // Stall detection: abort if no bytes transferred for 60 seconds
      stallTimer = setInterval(() => {
        if (Date.now() - lastProgressTime > STALL_TIMEOUT_MS) {
          cleanup();
          xhr.abort();
          reject(new Error('Upload stalled — no data transferred for 60 seconds. The storage server may be temporarily unreachable.'));
        }
      }, 10_000);

      // Wire AbortSignal to XHR
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!settled) {
            cleanup();
            xhr.abort();
            reject(new DOMException('Upload aborted', 'AbortError'));
          }
        });
      }

      xhr.upload.addEventListener('progress', (e) => {
        lastProgressTime = Date.now();
        if (e.lengthComputable && onProgress) {
          onProgress(e.loaded, e.total);
        }
      });

      xhr.addEventListener('load', () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xhr.responseText, 'text/xml');
            const messageElement = xmlDoc.querySelector('Message');
            const codeElement = xmlDoc.querySelector('Code');
            const errorMessage = messageElement?.textContent || 'Upload failed';
            const errorCode = codeElement?.textContent || '';
            reject(new Error(`${errorCode ? `${errorCode}: ` : ''}${errorMessage}`));
          } catch {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => {
        cleanup();
        reject(new Error('Upload failed due to network error'));
      });

      xhr.addEventListener('abort', () => {
        // Only reject if not already settled (stall/signal handlers reject first)
        if (!settled) {
          cleanup();
          reject(new Error('Upload was aborted'));
        }
      });

      xhr.open('PUT', fullUrl);
      if (file instanceof File) {
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      } else {
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      }
      if (tokenGetter) {
        const token = tokenGetter();
        if (token) {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
      }
      xhr.send(file);
    });
  },

  /**
   * Single PUT with retries under {@link S3_MULTIPART_THRESHOLD_BYTES}; multipart upload above it.
   * Supports AbortSignal for user-initiated cancellation.
   */
  putObjectAdaptive: async (
    bucketName: string,
    objectKey: string,
    file: File | Blob,
    projectId?: string,
    onProgress?: (uploaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    if (file.size < S3_MULTIPART_THRESHOLD_BYTES) {
      return withRetry(() => s3Api.putObject(bucketName, objectKey, file, projectId, onProgress, signal))
    }
    return multipartUploadLargeFile(bucketName, objectKey, file, projectId, onProgress, signal)
  },

  /**
   * Create a directory in S3 (by uploading a zero-byte object with trailing slash)
   * Uses default S3 endpoint with s3. subdomain prefix
   * @param bucketName - Name of the bucket
   * @param directoryPath - Path of the directory (should end with /)
   * @param projectId - Project ID (for error messages)
   */
  createDirectory: async (
    bucketName: string,
    directoryPath: string,
    projectId?: string
  ): Promise<void> => {
    // Ensure directory path ends with /
    const normalizedPath = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`;
    
    // Create a zero-byte blob
    const emptyBlob = new Blob([], { type: 'application/x-directory' });
    
    return s3Api.putObject(bucketName, normalizedPath, emptyBlob, projectId);
  },

  /**
   * Delete an object from S3
   * Uses default S3 endpoint with s3. subdomain prefix
   * @param bucketName - Name of the bucket
   * @param objectKey - Key/path of the object to delete
   * @param projectId - Project ID (for error messages, optional)
   */
  deleteObject: async (
    bucketName: string,
    objectKey: string,
    _projectId?: string
  ): Promise<void> => {
    const client = createDefaultS3Client();
    
    try {
      const response = await client.delete(buildS3ObjectPath(bucketName, objectKey));
      
      // S3 DELETE returns 204 No Content on success
      if (response.status !== 204 && response.status !== 200) {
        throw new Error(`Delete failed with status ${response.status}`);
      }
    } catch (error: any) {
      if (error.response) {
        if (typeof error.response.data === 'string') {
          try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(error.response.data, 'text/xml');
            const messageElement = xmlDoc.querySelector('Message');
            const errorMessage = messageElement?.textContent || 'Failed to delete object';
            throw new Error(errorMessage);
          } catch {
            throw new Error(error.response.data || `Failed to delete object: ${error.response.status}`);
          }
        } else {
          throw new Error(`Failed to delete object: ${error.response.status}`);
        }
      }
      throw error;
    }
  },

  /**
   * Copy an object within S3 (same bucket or cross-bucket)
   * Uses S3 PUT with x-amz-copy-source header
   * @param bucketName - Name of the bucket
   * @param sourceKey - Source object key
   * @param destKey - Destination object key
   * @param projectId - Project ID (for error messages)
   * @param routingInfo - Routing info to determine deployment endpoint (required)
   */
  copyObject: async (
    bucketName: string,
    sourceKey: string,
    destKey: string,
    projectId?: string,
    routingInfo?: BucketRoutingResponse
  ): Promise<void> => {
    const deploymentEndpoint = getPrimaryDeploymentEndpoint(routingInfo);
    if (!deploymentEndpoint) {
      const projectContext = projectId ? ` in project ${projectId}` : '';
      throw new Error(`No deployment endpoint available for bucket ${bucketName}${projectContext}. Routing info is required.`);
    }
    
    const client = createDeploymentS3Client(deploymentEndpoint);
    
    try {
      // S3 copy operation uses PUT with x-amz-copy-source header
      const response = await client.put(buildS3ObjectPath(bucketName, destKey), null, {
        headers: {
          'x-amz-copy-source': buildS3ObjectPath(bucketName, sourceKey),
        },
      });
      
      if (response.status !== 200) {
        throw new Error(`Copy failed with status ${response.status}`);
      }
    } catch (error: any) {
      if (error.response) {
        if (typeof error.response.data === 'string') {
          try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(error.response.data, 'text/xml');
            const messageElement = xmlDoc.querySelector('Message');
            const errorMessage = messageElement?.textContent || 'Failed to copy object';
            throw new Error(errorMessage);
          } catch {
            throw new Error(error.response.data || `Failed to copy object: ${error.response.status}`);
          }
        } else {
          throw new Error(`Failed to copy object: ${error.response.status}`);
        }
      }
      throw error;
    }
  },
}

// Pipeline APIs
export interface Pipeline {
  id: string
  projectId: string
  name: string
  description?: string
  type?: 'Data' | 'API'
  graph: {
    nodes: Array<{
      id: string
      type: string // Allow any string type
      config?: Record<string, any>
      metadata?: Record<string, any>
    }>
    edges: Array<{
      from: string
      to: string
      config?: Record<string, any>
    }>
  }
  createdAt: string
  updatedAt: string
  dependentsSummary?: DependentsSummary
}

export interface CreatePipelineRequest {
  name: string
  description?: string
  type?: 'Data' | 'API'
  graph: Pipeline['graph']
}

export interface UpdatePipelineRequest {
  name?: string
  description?: string
  type?: 'Data' | 'API'
  graph?: Pipeline['graph']
}

export const pipelineApi = {
  list: async (projectId: string, params?: {
    limit?: number;
    skip?: number;
    type?: 'Data' | 'API';
  }): Promise<Pipeline[]> => {
    const response = await configServiceApi.get<Pipeline[]>(
      `/api/v1/projects/${projectId}/pipelines`,
      { params }
    )
    return Array.isArray(response.data) ? response.data : []
  },

  get: async (projectId: string, pipelineId: string): Promise<Pipeline> => {
    const response = await configServiceApi.get<Pipeline>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}`
    )
    return response.data
  },

  create: async (
    projectId: string,
    data: CreatePipelineRequest
  ): Promise<Pipeline> => {
    const response = await configServiceApi.post<Pipeline>(
      `/api/v1/projects/${projectId}/pipelines`,
      data
    )
    return response.data
  },

  update: async (
    projectId: string,
    pipelineId: string,
    data: UpdatePipelineRequest
  ): Promise<Pipeline> => {
    const response = await configServiceApi.put<Pipeline>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}`,
      data
    )
    return response.data
  },

  delete: async (projectId: string, pipelineId: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/pipelines/${pipelineId}`)
  },
}

// Pipeline Execution APIs
export interface PipelineExecution {
  id: string
  executionId: string
  pipelineId: string
  projectId: string
  workflowId: string
  runId?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  results?: Record<string, any>
  stepResults?: Array<{
    nodeId: string
    status: string
    results?: Record<string, any>
    error?: string
  }>
  error?: string
  clusterAssignments?: Record<string, string>
  updatedAt: string
}

export interface ExecutePipelineRequest {
  parameters?: Record<string, any>
}

export const pipelineExecutionApi = {
  execute: async (
    projectId: string,
    pipelineId: string,
    data?: ExecutePipelineRequest
  ): Promise<{ executionId: string; status: string }> => {
    const response = await configServiceApi.post<{ executionId: string; status: string }>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}/execute`,
      data || {}
    )
    return response.data
  },

  list: async (
    projectId: string,
    pipelineId: string
  ): Promise<PipelineExecution[]> => {
    const response = await configServiceApi.get<PipelineExecution[]>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions`
    )
    return Array.isArray(response.data) ? response.data : []
  },

  get: async (
    projectId: string,
    pipelineId: string,
    executionId: string
  ): Promise<PipelineExecution> => {
    const response = await configServiceApi.get<PipelineExecution>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions/${executionId}`
    )
    return response.data
  },

  cancel: async (
    projectId: string,
    pipelineId: string,
    executionId: string
  ): Promise<{ status: string }> => {
    const response = await configServiceApi.post<{ status: string }>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions/${executionId}/cancel`
    )
    return response.data
  },

  resume: async (
    projectId: string,
    pipelineId: string,
    executionId: string,
    payload: { approvedIds: string[]; rejectedIds: string[] }
  ): Promise<{ status: string }> => {
    const response = await configServiceApi.post<{ status: string }>(
      `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions/${executionId}/resume`,
      payload
    )
    return response.data
  },
}

// Config Service API base URL (for project/bucket APIs, connectors, datasets)
// When behind apigateway, config-service is available at /config
// All APIs are now under /api/v1
// So /api/v1/projects becomes /config/api/v1/projects
// And /api/v1/connectors becomes /config/api/v1/connectors
const getConfigServiceBaseUrl = (): string => {
  // Explicit config service base path (e.g., /config when behind gateway)
  const configServiceBasePath = import.meta.env.VITE_CONFIG_SERVICE_BASE_PATH;
  if (configServiceBasePath) {
    return configServiceBasePath;
  }
  
  // Explicit config service URL (full URL)
  const configServiceUrl = import.meta.env.VITE_CONFIG_SERVICE_URL;
  if (configServiceUrl) {
    return configServiceUrl;
  }
  
  // When behind gateway (basePath is /console), config-service is at /config
  const basePath = import.meta.env.VITE_BASE_PATH || '/';
  if (basePath !== '/') {
    // Behind gateway - use /config prefix
    return '/config';
  }
  
  // Standalone mode - try to derive from API_BASE_URL
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api/v1';
  if (apiBaseUrl.startsWith('http')) {
    try {
      const url = new URL(apiBaseUrl);
      // Assume config-service runs on same host, possibly different port
      // For development, config-service might be on a different port (e.g., 3000)
      return `${url.protocol}//${url.host}`;
    } catch {
      return '';
    }
  }
  
  // For relative URLs in standalone mode, use empty string (same origin)
  // Config-service project/bucket APIs are at /api/v1/projects
  return '';
};

// API client for config-service (project/bucket APIs, connectors, datasets)
const configServiceApi = axios.create({
  baseURL: getConfigServiceBaseUrl(),
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // Add timeout to prevent hanging requests
});

// Request interceptor to add JWT token to configServiceApi requests
configServiceApi.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Skip adding auth headers for public endpoints
    const isPublicEndpoint = config.url?.includes('/setup/') || 
                             config.url?.includes('/health') ||
                             config.url?.includes('/ready')
    
    if (!isPublicEndpoint && tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor to handle 401 and token refresh for configServiceApi
configServiceApi.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    // Skip token refresh for public endpoints (setup, health, etc.)
    const isPublicEndpoint = originalRequest.url?.includes('/setup/') || 
                             originalRequest.url?.includes('/health') ||
                             originalRequest.url?.includes('/ready')

    // If we get a 401 and haven't already retried, try to refresh the token
    // But skip for public endpoints that don't require auth
    if (error.response?.status === 401 && !originalRequest._retry && tokenRefresher && !isPublicEndpoint) {
      originalRequest._retry = true

      try {
        await tokenRefresher()
        
        // Retry the original request with new token
        if (tokenGetter && originalRequest.headers) {
          const newToken = tokenGetter()
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`
            return configServiceApi(originalRequest)
          }
        }
      } catch (refreshError) {
        // Token refresh failed, redirect to login
        console.error('Token refresh failed:', refreshError)
        // Clear any stored auth state
        window.location.href = `${import.meta.env.VITE_BASE_PATH || ''}/login`
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)


// Connector types (only supported types). The legacy `metrics` connector type
// has been merged into the primary connectors (ONTAP, GCP); metric acquisition
// is now driven by metric_category resourceSelector entries on those primary
// connectors instead of a dedicated connector type.
export type ConnectorType = 'objectstore' | 'database' | 'cloud' | 'storage' | 'api';

export interface Connector {
  id: string;
  name: string;
  description: string;
  type: ConnectorSubType;
  connectorConfig?: DataSourceConnectorConfig;
  createdAt: string;
  updatedAt: string;
}

// Dataset preview/stats/histogram types
export interface FilterCriteria {
  column: string
  op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'NOT LIKE' | 'IS NULL' | 'IS NOT NULL' | 'IN'
  value?: string
}

export interface OrderBy {
  column: string
  direction: 'asc' | 'desc'
}

export interface PreviewResponse {
  columns: string[]
  columnTypes: string[]
  /** Row data; may be null when empty (e.g. some backends return null instead of []). */
  rows: unknown[][] | null
  rowCount: number
  totalCount: number
  offsetCapped: boolean
  executionTime: number
}

export interface ColumnStat {
  type: string
  category?: 'integer' | 'float' | 'categorical' | 'string' | 'temporal' | 'boolean'
  min?: string
  max?: string
  avg?: string
  median?: string
  approxUnique?: number
  nullPercentage?: number
  nullCount?: number
  count?: number
  q25?: string
  q50?: string
  q75?: string
  avgLength?: number
  trueCount?: number
  truePercentage?: number
  histogram?: HistogramBucket[]
}

export interface StatsResponse {
  stats: Record<string, ColumnStat>
  partial: boolean
  error?: string
}

export interface HistogramBucket {
  label: string
  count: number
}

export interface FileStatsFacet {
  extensionDistribution: HistogramBucket[]
  sizeDistribution: HistogramBucket[]
  ageDistribution: HistogramBucket[]
  totalFiles: number
  totalSizeBytes: number
  avgFileSizeBytes: number
  medianFileSizeBytes?: number
  oldestFile?: string
  newestFile?: string
}

export interface HistogramResponse {
  column: string
  type: 'numeric' | 'categorical'
  buckets: HistogramBucket[]
  error?: string
}

export { classifyDuckDBType, isNumericCategory, type ColumnTypeCategory } from '../utils/duckdb-types'

// Dataset types
export type DataSetKind = 'unstructured' | 'structured';
export type DataSetType = 'acquired' | 'manual';

export interface DataSetFile {
  id: string;
  dataSetId: string;
  fileKey: string;
  fileUrl: string;
  originalName?: string;
  size?: number;
  createdAt: string;
}

export interface DataSetManifest {
  id: string;
  dataSetId: string;
  manifestId: number;
  status: 'draft' | 'committed' | 'deprecated';
  metadata?: Record<string, any>;
  schema?: Record<string, any>;
  files?: DataSetManifestFile[];
  createdAt: string;
  updatedAt: string;
}

export interface DataSetManifestFile {
  id: string;
  manifestId: string;
  fileName: string;
  uri?: string;
  createdAt: string;
}

export interface PiiSummary {
  filesWithPii: number;
  totalFiles: number;
  piiAnalysisEnabled: boolean;
  filesWithHighRisk?: number;
  filesWithMediumRisk?: number;
  filesWithLowRisk?: number;
}

export type FacetState = 'in_progress' | 'ready' | 'errored';

export interface Facet {
  id: string;
  projectId: string;
  entityType: string;
  entityId: string;
  facetType: string;
  state: FacetState;
  jobId?: string;
  errorMessage?: string;
  summary?: Record<string, any>;
  progress?: {
    phase?: string;
    percentage?: number;
    message?: string;
    currentFile?: string;
    totalFiles?: number;
    processedFiles?: number;
    estimatedRemainingFormatted?: string;
    elapsedFormatted?: string;
    totalUnits?: number;
    units?: Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown> }>;
  };
  lastUpdated: string;
  createdAt: string;
}

export interface PiiFileDetail {
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  piiEntities: string[] | null;
  piiCount: number | null;
  sensitivityClass: string;
  hasPii: boolean | null;
  piiRiskLevel: string;
  highRiskCount: number;
  mediumRiskCount: number;
  lowRiskCount: number;
}

export interface PiiDetails {
  datasetId: string;
  analysisTimestamp: string;
  summary: PiiSummary;
  files: PiiFileDetail[];
}

export interface DataSet {
  id: string;
  name: string;
  description: string;
  type: DataSetType;
  originConnector?: string;
  /** Volume-type data source id for POSIX-mounted acquisition */
  originVolume?: string;
  kind: DataSetKind;
  filterSpec?: Record<string, any>;
  fileProcessors?: string[];
  sqlQuery?: string;
  sourceDatabase?: string;
  sourceSchema?: string;
  files?: DataSetFile[];
  manifest?: DataSetManifest;
  status?: 'in_progress' | 'ready' | 'errored' | 'deprecated';
  jobId?: string;
  errorMessage?: string;
  progress?: {
    phase?: string;
    percentage?: number;
    message?: string;
    currentFile?: string;
    totalFiles?: number;
    processedFiles?: number;
    estimatedRemainingFormatted?: string;
    elapsedFormatted?: string;
    totalUnits?: number;
    units?: Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown> }>;
  };
  facets?: Facet[];
  enablePiiAnalysis?: boolean;
  piiAnalysisImageOnly?: boolean;
  catalogTableRef?: string;
  namespace?: string;
  catalogTableName?: string;
  warehouseName?: string;
  catalogTable?: any;
  resourceSelector?: Array<Record<string, any>>;
  acquisitionConfig?: AcquisitionConfig;
  scheduleConfig?: ScheduleConfig;
  dependentsSummary?: DependentsSummary;
  createdAt: string;
  updatedAt: string;
}

export interface AcquisitionConfig {
  /** Include only files matching this pattern (e.g. "*.csv" or "*.csv,*.parquet"). Empty = all files. */
  fileGlob?: string;
  /** Exclude files matching this pattern (e.g. "*.tmp" or "*.tmp,.DS_Store"). Optional. */
  fileExcludePattern?: string;
  writeMode: 'append' | 'overwrite' | 'incremental';
  watermarkColumn?: string;
  lastWatermarkValue?: string;
  maxRows?: number;
  queryTimeoutSeconds?: number;
}

export interface ScheduleConfig {
  cronExpression: string;
  timezone: string;
  temporalScheduleId?: string;
  enabled: boolean;
}

export interface CreateDataSetRequest {
  name: string;
  description: string;
  type: DataSetType;
  originConnector?: string;
  originVolume?: string;
  kind: DataSetKind;
  filterSpec?: Record<string, any>;
  fileProcessors?: string[];
  sqlQuery?: string;
  sourceDatabase?: string;
  sourceSchema?: string;
  uploadedFiles?: Array<string | { key: string; url: string; size?: number; originalName?: string }>;
  schema?: Record<string, any>;
  resourceSelector?: Array<Record<string, any>>;
  enablePiiAnalysis?: boolean; // Run PII detection on unstructured files during import
  piiAnalysisImageOnly?: boolean; // Only analyze images (skip text files)
  acquisitionConfig?: AcquisitionConfig;
  scheduleConfig?: ScheduleConfig;
}

export interface UpdateDataSetRequest {
  name?: string;
  description?: string;
  type?: DataSetType;
  originConnector?: string;
  originVolume?: string;
  kind?: DataSetKind;
  filterSpec?: Record<string, any>;
  fileProcessors?: string[];
  sqlQuery?: string;
  sourceDatabase?: string;
  sourceSchema?: string;
  uploadedFiles?: Array<string | { key: string; url: string; size?: number; originalName?: string }>;
  schema?: Record<string, any>;
  resourceSelector?: Array<Record<string, any>>;
  acquisitionConfig?: AcquisitionConfig;
  scheduleConfig?: ScheduleConfig;
}

// DataSource types (unified volume + connector entity)
export type DataSourceType = 'volume' | 'connector';
export type ConnectorSubType = 'objectstore' | 'database' | 'cloud' | 'storage' | 'api';

export interface DataSourceVolumeConfig {
  region: string;
  volume_info: VolumeInfo;
  auth_info: AuthInfo;
  protocol: string;
  deployment_config?: DeploymentConfig;
}

export interface DataSourceConnectorConfig {
  connector_type: ConnectorSubType;
  scope?: 'account' | 'resource';
  provider?: string;
  database_type?: 'postgresql' | 'mysql';
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  ssl_mode?: string;
  endpoint?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  project_id?: string;
  default_region?: string;
  // Storage system (NetApp ONTAP) fields — connector_type === 'storage', scope === 'account'
  cluster_url?: string;
  verify_tls?: boolean;
  default_svm?: string;
  // API connector fields — connector_type === 'api'
  base_url?: string;
  include_query_results?: boolean;
  include_dashboards?: boolean;
  include_data_sources?: boolean;
  max_result_rows?: number;
}

export interface DataSourceMountHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  last_checked_at?: string;
  blocking?: string[];
  warnings?: string[];
  probed_lif?: string;
  repair_pending_pod_restart?: boolean;
  [key: string]: unknown;
}

export interface DataSourceItem {
  id: string;
  project_id: string;
  name: string;
  type: DataSourceType;
  description?: string;
  volume_config?: DataSourceVolumeConfig;
  connector_config?: DataSourceConnectorConfig;
  metadata: Record<string, any>;
  mount_health?: DataSourceMountHealth;
  last_connection_test_at?: string;
  last_connection_test_status?: 'success' | 'failed';
  last_connection_test_message?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDataSourceRequest {
  name: string;
  type: DataSourceType;
  description?: string;
  volume_config?: DataSourceVolumeConfig;
  connector_config?: DataSourceConnectorConfig;
  credential_id?: string;
  metadata?: Record<string, any>;
}

export interface UpdateDataSourceRequest {
  name?: string;
  description?: string;
  volume_config?: {
    region?: string;
    volume_info?: Partial<VolumeInfo>;
    auth_info?: Partial<AuthInfo>;
    protocol?: string;
    deployment_config?: Partial<DeploymentConfig>;
  };
  connector_config?: Partial<DataSourceConnectorConfig>;
  credential_id?: string;
  metadata?: Record<string, any>;
}

// Unified DataSource API
export const datasourceApi = {
  list: async (projectId: string, params?: {
    type?: DataSourceType;
    limit?: number;
    skip?: number;
    nameRegex?: string;
  }): Promise<DataSourceItem[]> => {
    const response = await configServiceApi.get<DataSourceItem[]>(
      `/api/v1/projects/${projectId}/datasources`,
      { params }
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  get: async (projectId: string, id: string): Promise<DataSourceItem> => {
    const response = await configServiceApi.get<DataSourceItem>(
      `/api/v1/projects/${projectId}/datasources/${id}`
    );
    return response.data;
  },

  create: async (projectId: string, data: CreateDataSourceRequest): Promise<DataSourceItem> => {
    const response = await configServiceApi.post<DataSourceItem>(
      `/api/v1/projects/${projectId}/datasources`,
      data
    );
    return response.data;
  },

  update: async (projectId: string, id: string, data: UpdateDataSourceRequest): Promise<DataSourceItem> => {
    const response = await configServiceApi.put<DataSourceItem>(
      `/api/v1/projects/${projectId}/datasources/${id}`,
      data
    );
    return response.data;
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/datasources/${id}`);
  },

  recordConnectionTestResult: async (
    projectId: string,
    id: string,
    result: { success: boolean; message?: string }
  ): Promise<DataSourceItem> => {
    const response = await configServiceApi.patch<DataSourceItem>(
      `/api/v1/projects/${projectId}/datasources/${id}/connection-test-result`,
      result
    );
    return response.data;
  },

  preflight: async (
    projectId: string,
    id: string
  ): Promise<{ mount_health?: DataSourceMountHealth; data_source?: DataSourceItem; explorer?: unknown; explorer_error?: unknown }> => {
    const response = await configServiceApi.post(
      `/api/v1/projects/${projectId}/datasources/${id}/preflight`,
      {}
    );
    return response.data;
  },

  bulkPreflight: async (
    projectId: string,
    body: { filter?: { type?: string; source?: string } }
  ): Promise<{ results: any[] }> => {
    const response = await configServiceApi.post(
      `/api/v1/projects/${projectId}/datasources/bulk-preflight`,
      body
    );
    return response.data;
  },

  bulkApply: async (
    projectId: string,
    body: { ids: string[]; dry_run?: boolean }
  ): Promise<{ outcomes: any[] }> => {
    const response = await configServiceApi.post(
      `/api/v1/projects/${projectId}/datasources/bulk-apply`,
      body
    );
    return response.data;
  },

  // Routing API (volumes only, delegates to existing deployment routing)
  getRouting: async (projectId: string, volumeName: string): Promise<BucketRoutingResponse> => {
    const response = await configServiceApi.get<BucketRoutingResponse>(
      `/api/v1/buckets/${projectId}/${volumeName}/routing`
    );
    return response.data;
  },
};

// Dataset APIs (now scoped under projects)
export const datasetApi = {
  list: async (projectId: string, params?: {
    limit?: number;
    skip?: number;
    field?: string;
    value?: string;
    nameRegex?: string;
  }): Promise<DataSet[]> => {
    const response = await configServiceApi.get<DataSet[]>(`/api/v1/projects/${projectId}/datasets`, { params });
    return Array.isArray(response.data) ? response.data : [];
  },

  get: async (projectId: string, id: string): Promise<DataSet> => {
    const response = await configServiceApi.get<DataSet>(`/api/v1/projects/${projectId}/datasets/${id}`);
    return response.data;
  },

  create: async (projectId: string, data: CreateDataSetRequest): Promise<DataSet> => {
    // Dataset creation involves multiple steps including Iceberg table creation which can take time
    // Increase timeout to 120 seconds (2 minutes) to accommodate long-running operations
    const response = await configServiceApi.post<DataSet>(`/api/v1/projects/${projectId}/datasets`, data, {
      timeout: 120000, // 2 minutes
    });
    return response.data;
  },

  update: async (projectId: string, id: string, data: UpdateDataSetRequest): Promise<DataSet> => {
    // Registering many manual-upload files creates a large JSON body and heavy DB work (manifest rows).
    // Default 30s client timeout is often too short for 100+ files on slower clusters.
    const n = Array.isArray(data.uploadedFiles) ? data.uploadedFiles.length : 0;
    const timeout =
      n > 0 ? Math.min(600_000, 90_000 + n * 2_500) : 30_000;
    const response = await configServiceApi.put<DataSet>(
      `/api/v1/projects/${projectId}/datasets/${id}`,
      data,
      { timeout }
    );
    return response.data;
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/datasets/${id}`);
  },

  /**
   * Trigger dataset import workflow
   * This should be called after files are uploaded to the dataset's data_files/ directory.
   * The workflow will:
   * - For structured data: convert to Parquet, infer schema, register with catalog
   * - For unstructured data: create metadata table, register with catalog
   */
  import: async (projectId: string, datasetId: string): Promise<{ workflowId: string; status: string }> => {
    const response = await configServiceApi.post<{ workflowId: string; status: string }>(
      `/api/v1/projects/${projectId}/datasets/${datasetId}/import`,
      {},
      { timeout: 120_000 }
    );
    return response.data;
  },

  /**
   * Fetch PII analysis details directly from S3.
   * The processor writes pii_details.json to S3 during import when PII analysis is enabled.
   * @returns PiiDetails or null if the file doesn't exist yet
   */
  getPiiDetails: async (bucketName: string, pathPrefix: string, datasetId: string): Promise<PiiDetails | null> => {
    try {
      const objectKey = `${pathPrefix}/datasets/${datasetId}/pii_details.json`;
      const blob = await s3Api.getObject(bucketName, objectKey);
      const text = await blob.text();
      return JSON.parse(text) as PiiDetails;
    } catch {
      return null;
    }
  },

  preview: async (
    _projectId: string,
    _datasetId: string,
    namespace?: string,
    tableName?: string,
    options?: {
      limit?: number;
      offset?: number;
      filters?: FilterCriteria[];
      orderBy?: OrderBy;
    },
  ): Promise<PreviewResponse> => {
    if (!namespace || !tableName) {
      throw new Error('Dataset namespace and tableName are required for preview')
    }
    const response = await analyticsApi.post<PreviewResponse>(
      '/api/v1/datasets/preview',
      {
        namespace,
        table: tableName,
        limit: options?.limit ?? 50,
        offset: options?.offset ?? 0,
        filters: options?.filters ?? [],
        orderBy: options?.orderBy,
      },
    );
    return response.data;
  },

  stats: async (
    namespace: string,
    tableName: string,
    filters?: FilterCriteria[],
  ): Promise<StatsResponse> => {
    const response = await analyticsApi.post<StatsResponse>(
      '/api/v1/datasets/stats',
      { namespace, table: tableName, filters: filters ?? [] },
    );
    return response.data;
  },

  columnHistogram: async (
    namespace: string,
    tableName: string,
    column: string,
    filters?: FilterCriteria[],
    signal?: AbortSignal,
  ): Promise<HistogramResponse> => {
    const response = await analyticsApi.post<HistogramResponse>(
      '/api/v1/datasets/histogram',
      { namespace, table: tableName, column, filters: filters ?? [] },
      { signal },
    );
    return response.data;
  },

  query: async (sql: string): Promise<PreviewResponse> => {
    const response = await analyticsApi.post<PreviewResponse>(
      '/api/flightsql/query',
      { query: sql },
      { headers: { Accept: 'application/json' } },
    )
    return response.data
  },

  /**
   * Supplementary actions on existing datasets
   */
  actions: {
    /**
     * Re-run PII analysis on an existing imported dataset.
     * Reads existing files from the Iceberg table, re-analyzes them, and updates PII columns.
     */
    reprocessPii: async (projectId: string, datasetId: string): Promise<{ workflowId: string; status: string }> => {
      const response = await configServiceApi.post<{ workflowId: string; status: string }>(
        `/api/v1/projects/${projectId}/datasets/${datasetId}/facets/pii/run`,
        {},
        { timeout: 30000 }
      );
      return response.data;
    },
  },
};

// KnowledgeBase Types
export type ChunkStrategy = 'fixed' | 'sentence' | 'recursive' | 'token' | 'markdown'

export type IndexingMode = 'hybrid' | 'semantic' | 'fts'

export type QuantizationType = 'auto' | 'none' | 'ivf_pq' | 'scalar' | 'ivf_rq'

export type RerankerType = 'rrf' | 'cross_encoder' | 'cohere' | 'linear'

export interface ChunkOptions {
  maxSentences?: number      // sentence strategy: max sentences per chunk
  overlapSentences?: number  // sentence strategy: overlap sentences between chunks
  maxTokens?: number         // token strategy: max tokens per chunk
  tokenOverlap?: number      // token strategy: overlap tokens between chunks
  splitOnHeaders?: boolean   // markdown strategy: split on headers
}

export interface QuantizationOptions {
  numPartitions?: number   // IVF_PQ / IVF_HNSW_SQ / IVF_RQ: number of partitions
  numSubVectors?: number   // IVF_PQ: PQ sub-vectors (default: 96)
  efConstruction?: number  // IVF_HNSW_SQ: HNSW ef_construction (default: 150)
  m?: number               // IVF_HNSW_SQ: HNSW connectivity parameter
  numBits?: number         // IVF_RQ: bits per dimension (default: 1)
}

export interface KnowledgeBaseStats {
  documentCount?: number      // Number of source documents processed
  chunkCount?: number         // Total number of chunks created
  vectorCount?: number        // Total number of vectors (same as chunks)
  storageBytes?: number       // Total storage size in bytes
  storageMB?: number          // Total storage size in megabytes
  fileCount?: number          // Number of LanceDB files
  avgChunkSize?: number       // Average chunk size in characters
  lastProcessedAt?: string    // ISO 8601 timestamp of last processing
}

export interface KnowledgeBase {
  id: string
  projectId: string
  name: string
  description?: string
  sourceDataset: string
  embeddingModel: string
  chunkSize: number
  chunkStrategy: ChunkStrategy
  chunkOverlap?: number
  chunkOptions?: ChunkOptions
  indexingMode: IndexingMode
  quantizationType?: QuantizationType // 'auto' (default), 'none', 'ivf_pq', 'scalar', 'ivf_rq'
  quantizationOptions?: QuantizationOptions // Options for IVF_PQ quantization
  vectorSize: number
  dataType?: string // Deprecated: no longer used in UI
  textColumns?: string // Comma-separated list of columns for text extraction (required for structured datasets)
  status?: 'in_progress' | 'ready' | 'errored' | 'deprecated'
  progress?: {
    phase?: string
    percentage?: number
    totalFiles?: number
    processedFiles?: number
    totalDocuments?: number
    documentCount?: number
    chunksCreated?: number
    vectorsCreated?: number
    currentFile?: string
    estimatedRemainingFormatted?: string
    elapsedFormatted?: string
    lastUpdated?: string
    totalUnits?: number
    units?: Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown> }>
  }
  stats?: KnowledgeBaseStats // Legacy; prefer embedding facet summary for stats
  facets?: Facet[] // Workflow-populated facets (embedding facet holds documentCount, chunkCount, etc.)
  errorMessage?: string
  jobId?: string
  bucketName?: string
  namespace?: string
  lanceTablePath?: string
  dependentsSummary?: DependentsSummary
  createdAt: string
  updatedAt: string
}

export interface CreateKnowledgeBaseRequest {
  name: string
  description?: string
  sourceDataset: string
  embeddingModel: string
  /**
   * Preferred FK to the Model catalog (UUID). When set, config-service uses
   * this to resolve provider/providerModelId/dimensions and forwards them
   * into the kb-processor workflow input. The legacy `embeddingModel` name
   * field is still accepted for back-compat with old clients.
   */
  embeddingModelId?: string
  chunkSize: number
  chunkStrategy?: ChunkStrategy
  chunkOverlap?: number
  chunkOptions?: ChunkOptions
  indexingMode?: IndexingMode // 'hybrid' (default), 'semantic', 'fts'
  quantizationType?: QuantizationType // 'auto' (default), 'none', 'ivf_pq', 'scalar', 'ivf_rq' - vector index strategy
  quantizationOptions?: QuantizationOptions // Options for IVF_PQ quantization
  vectorSize: number
  dataType?: string // Deprecated: no longer used in UI
  textColumns?: string // Comma-separated list of columns for text extraction (required for structured datasets)
  processingMode?: 'full' | 'incremental' // Processing mode: 'full' (default) overwrites, 'incremental' appends
}

export interface UpdateKnowledgeBaseRequest {
  name?: string
  description?: string
  sourceDataset?: string
  embeddingModel?: string
  chunkSize?: number
  chunkStrategy?: ChunkStrategy
  chunkOverlap?: number
  chunkOptions?: ChunkOptions
  indexingMode?: IndexingMode
  quantizationType?: QuantizationType
  quantizationOptions?: QuantizationOptions
  vectorSize?: number
  dataType?: string
  textColumns?: string // Comma-separated list of columns for text extraction (required for structured datasets)
}

// KnowledgeBase Search Types (for kb-retrieval-service)
export type KBSearchMode = 'vector' | 'fts' | 'hybrid'

export interface KBSearchRequest {
  query: string
  topK?: number        // default: 10, max: 100
  minScore?: number    // default: 0.0, range: 0.0-1.0
  distanceMetric?: 'cosine' | 'l2' | 'dot'
  /** Override search mode; if not set, derived from KB indexingMode */
  searchMode?: KBSearchMode
  /** Reranker for hybrid search: rrf (default), cross_encoder, cohere, linear */
  rerankerType?: RerankerType
  /** Options for reranker: model (cross_encoder), apiKey/model (cohere), weight (linear) */
  rerankerOptions?: { model?: string; apiKey?: string; weight?: number }
  /** IVF tuning: nprobe (1-1000) */
  nprobe?: number
  /** Refine factor for IVF_PQ */
  refineFactor?: number
}

export interface KBSearchResult {
  id: string
  documentId: string
  source: string  // Document name or file path
  text: string
  score: number
  chunkIndex: number
  downloadUrl?: string  // S3 download URL provided by kb-retrieval-service
  metadata?: {
    file_name?: string
    file_path?: string
    file_type?: string
    document_id?: string
    chunk_index?: number
    total_chunks?: number
    table_ref?: string  // For structured datasets
    [key: string]: any
  }
}

export interface KBSearchResponse {
  results: KBSearchResult[]
  query: string
  topK: number
  resultCount: number
  processingTimeMs: number
  knowledgeBaseId: string
  searchMode: string
  distanceMetric: string
  rerankerType?: string
  indexingMode?: string
}

// MCP Server Catalog Types
export interface MCPServerCatalogEnvSchema {
  name: string
  description: string
  required: boolean
  secret: boolean
  defaultValue?: string
}

export interface MCPServerCatalogCredentialMapping {
  expectedProvider: string
  envFromKeys?: Record<string, string>
  fileFromKeys?: Record<string, { mountPath: string; envForPath: string; mode?: number }>
}

export interface MCPServerCatalogEntry {
  id: string
  name: string
  description: string
  category: 'infrastructure' | 'database' | 'filesystem' | 'development' | 'general' | 'monitoring'
  image: string
  defaultTag: string
  envSchema: MCPServerCatalogEnvSchema[]
  securityProfile: 'strict' | 'network-access'
  resourcePreset: 'small' | 'medium' | 'large'
  requiresRBAC: boolean
  volumeMounts?: { mountPath: string; sizeDefault: string }[]
  defaultAllowedTools?: string[]
  credentialMapping?: MCPServerCatalogCredentialMapping
}

// MCP Server Types
export interface MCPServer {
  id: string
  projectId: string
  name: string
  description?: string
  transport: 'http' | 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  authType: 'none' | 'api_key' | 'bearer_token' | 'basic' | 'oauth2'
  credentialId?: string
  /** Runtime credential for managed servers whose catalog declares credentialMapping (e.g. ONTAP). */
  runtimeCredentialId?: string
  authorizationUrl?: string
  tokenUrl?: string
  staticHeaders?: Record<string, string>
  queryParams?: MCPConnectionParam[]
  headerParams?: MCPConnectionParam[]
  authConfig?: MCPAuthConfig
  extraHeaders?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  specPath?: string
  llmproxyGatewayServerId?: string
  llmproxyGatewayServerName?: string
  syncStatus: 'synced' | 'pending' | 'error'
  status: 'connected' | 'disconnected' | 'error' | 'unknown'
  timeout: number
  trust: boolean
  deploymentType: 'remote' | 'managed' | 'platform'
  catalogId?: string
  managedConfig?: {
    resourcePreset?: string
    envOverrides?: Record<string, string>
    volumeSize?: string
  }
  k8sResourceName?: string
  runtimeStatus?: 'provisioning' | 'running' | 'failed' | 'deleting'
  dependentsSummary?: DependentsSummary
  createdAt: string
  updatedAt: string
}

export interface MCPSecretRef {
  credentialId: string
  field: string
}

export interface MCPConnectionParam {
  name: string
  value?: string
  secretRef?: MCPSecretRef
  enabled?: boolean
}

export interface MCPAuthConfig {
  location: 'header' | 'query' | 'cookie'
  keyName: string
  prefix?: string
  secretRef?: MCPSecretRef
}

export interface RuntimeStatusInfo {
  runtimeStatus: string
  phase?: string
  ready: boolean
  restartCount: number
  message?: string
}

export interface CreateMCPServerRequest {
  name: string
  description?: string
  deploymentType?: 'remote' | 'managed'
  catalogId?: string
  managedConfig?: {
    resourcePreset?: string
    envOverrides?: Record<string, string>
    volumeSize?: string
  }
  transport?: 'http' | 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  authType?: 'none' | 'api_key' | 'bearer_token' | 'basic' | 'oauth2'
  credentialId?: string
  /**
   * Credential the runtime uses to authenticate to the *wrapped* system
   * (e.g. an ONTAP cluster). Required when the catalog entry declares
   * a credentialMapping.
   */
  runtimeCredentialId?: string
  authorizationUrl?: string
  tokenUrl?: string
  staticHeaders?: Record<string, string>
  queryParams?: MCPConnectionParam[]
  headerParams?: MCPConnectionParam[]
  authConfig?: MCPAuthConfig
  extraHeaders?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  specPath?: string
  timeout?: number
  trust?: boolean
}

export interface UpdateMCPServerRequest {
  name?: string
  description?: string
  managedConfig?: {
    resourcePreset?: string
    envOverrides?: Record<string, string>
    volumeSize?: string
  }
  transport?: 'http' | 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  authType?: 'none' | 'api_key' | 'bearer_token' | 'basic' | 'oauth2'
  credentialId?: string
  runtimeCredentialId?: string
  authorizationUrl?: string
  tokenUrl?: string
  staticHeaders?: Record<string, string>
  queryParams?: MCPConnectionParam[]
  headerParams?: MCPConnectionParam[]
  authConfig?: MCPAuthConfig
  extraHeaders?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  specPath?: string
  timeout?: number
  trust?: boolean
}

export interface MCPToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, any>
}

export interface TestConnectionResult {
  success: boolean
  message: string
  status: string
}

// Credential Types
export interface Credential {
  id: string
  projectId: string
  name: string
  description?: string
  provider: string
  metadata?: Record<string, any>
  labels?: string[]
  expiresAt?: string
  lastRotatedAt?: string
  rotationVersion?: number
  dependentsSummary?: DependentsSummary
  createdAt: string
  updatedAt: string
}

export interface CreateCredentialRequest {
  name: string
  description?: string
  provider: string
  metadata?: Record<string, any>
  labels?: string[]
  expiresAt?: string
  secretData: Record<string, string>
}

// Credential APIs (scoped under projects)
export const credentialApi = {
  list: async (projectId: string, params?: { provider?: string; labels?: string }): Promise<Credential[]> => {
    const queryParams = new URLSearchParams()
    if (params?.provider) queryParams.set('provider', params.provider)
    if (params?.labels) queryParams.set('labels', params.labels)
    const qs = queryParams.toString()
    const response = await configServiceApi.get<Credential[]>(
      `/api/v1/projects/${projectId}/credentials${qs ? `?${qs}` : ''}`
    )
    return Array.isArray(response.data) ? response.data : []
  },

  get: async (projectId: string, id: string): Promise<Credential> => {
    const response = await configServiceApi.get<Credential>(
      `/api/v1/projects/${projectId}/credentials/${id}`
    )
    return response.data
  },

  create: async (projectId: string, data: CreateCredentialRequest): Promise<Credential> => {
    const response = await configServiceApi.post<Credential>(
      `/api/v1/projects/${projectId}/credentials`,
      data
    )
    return response.data
  },

  update: async (
    projectId: string,
    id: string,
    data: { name?: string; description?: string; metadata?: Record<string, any>; labels?: string[]; expiresAt?: string }
  ): Promise<Credential> => {
    const response = await configServiceApi.patch<Credential>(
      `/api/v1/projects/${projectId}/credentials/${id}`,
      data
    )
    return response.data
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/credentials/${id}`)
  },

  validate: async (projectId: string, id: string): Promise<{ valid: boolean; error?: string }> => {
    const response = await configServiceApi.post<{ valid: boolean; error?: string }>(
      `/api/v1/projects/${projectId}/credentials/${id}/validate`
    )
    return response.data
  },

  rotate: async (
    projectId: string,
    id: string,
    data: { secretData: Record<string, string>; expiresAt?: string }
  ): Promise<Credential> => {
    const response = await configServiceApi.post<Credential>(
      `/api/v1/projects/${projectId}/credentials/${id}/rotate`,
      data
    )
    return response.data
  },
}

// Provider Model Types (from list-available)
export interface ProviderModel {
  id: string
  name: string
  type: 'llm' | 'embedding'
  description?: string
  contextWindow?: number
  /**
   * Vector dimensions for embedding models. Populated by the config-service
   * /list-available endpoint from the static catalog in
   * providers/embeddingDimensions.ts. The RegisterModelWizard prefills its
   * "Dimensions" input from this and lets the user confirm or override
   * before registration.
   */
  dimensions?: number
  rateCard?: {
    inputPricePerToken?: number
    outputPricePerToken?: number
    currency?: string
  }
  metadata?: Record<string, any>
}

// Model Types
export interface Model {
  id: string
  projectId: string
  name: string
  displayName?: string
  provider?: string
  providerModelId?: string
  /**
   * Upstream provider deployment/inference name when distinct from `providerModelId`.
   * Used when the name the gateway must call (e.g. a cloud deployment id) differs
   * from the logical model id selected during registration.
   */
  providerDeploymentName?: string
  /**
   * Ready-to-send Bifrost model id, prefixed with the gateway provider
   * (e.g. `azure/projm5ehnnub_f1c94b5a_gpt-4o-mini-model`). Computed at
   * registration time so runtime callers can use the value verbatim.
   */
  gatewayModelId?: string
  /**
   * Unique Bifrost routing identifier encoding project + credential + upstream
   * model (e.g. `projm5ehnnub_f1c94b5a_gpt-4o-mini-model`). Used in
   * provider_key.models[], provider deployment-routing maps (when applicable),
   * routing CEL, and the project virtual key allowed_models list.
   */
  gatewayBindingName?: string
  credentialId?: string
  modelType?: string
  /**
   * System-managed built-in model (e.g., in-cluster TEI embedding models).
   * True for catalog entries seeded by `BuiltinModelsService`. Built-ins are
   * immutable from the API: PUT rejects non-displayName edits, DELETE 400s.
   */
  isBuiltin?: boolean
  /**
   * Free-form JSONB carrying model metadata. Shape varies by `modelType`:
   *   - llm:       { architecture, base_model, variant, parameters, quantization, size, ... }
   *   - embedding: { dimensions, recommendedChunkSize, category, description, ... }
   */
  model_info?: {
    // LLM fields (legacy strict shape kept for back-compat)
    architecture?: string
    base_model?: string
    variant?: string
    parameters?: string
    quantization?: string
    size?: number
    // Embedding fields (Phase 1 of the unified-embedding port)
    dimensions?: number
    recommendedChunkSize?: number
    category?: 'balanced' | 'quality' | 'fast' | 'multilingual'
    description?: string
    // Plus arbitrary other keys
    [k: string]: unknown
  }
  endpoint?: string
  auth?: {
    access_token: string
    secret_key: string
  }
  limits?: {
    tpm: number
    timeout: number
    stream_timeout: number
    max_retries: number
  }
  modelClass?: string
  rateCardOverride?: Record<string, any>
  dependentsSummary?: DependentsSummary
  createdAt: string
  updatedAt: string
}

// Manifest APIs (scoped under datasets)
export const manifestApi = {
  list: async (projectId: string, dataSetId: string): Promise<DataSetManifest[]> => {
    const response = await configServiceApi.get<DataSetManifest[]>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests`
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  get: async (projectId: string, dataSetId: string, manifestId: string): Promise<DataSetManifest> => {
    const response = await configServiceApi.get<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}`
    );
    return response.data;
  },

  create: async (
    projectId: string,
    dataSetId: string,
    data?: { uris?: string[]; metadata?: Record<string, any>; schema?: Record<string, any> }
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.post<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests`,
      data || {}
    );
    return response.data;
  },

  updateSchema: async (
    projectId: string,
    dataSetId: string,
    manifestId: string,
    schema?: Record<string, any>
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.put<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}/schema`,
      { schema }
    );
    return response.data;
  },

  updateMetadata: async (
    projectId: string,
    dataSetId: string,
    manifestId: string,
    metadata: Record<string, any>
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.put<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}/metadata`,
      { metadata }
    );
    return response.data;
  },

  /**
   * Update manifest status (draft -> committed -> deprecated)
   * When committing a manifest, the backend will trigger the dataset import workflow
   */
  updateStatus: async (
    projectId: string,
    dataSetId: string,
    manifestId: string,
    status: 'draft' | 'committed' | 'deprecated'
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.put<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}/status`,
      { status },
      { timeout: status === 'committed' ? 300_000 : 30_000 }
    );
    return response.data;
  },

  /**
   * Commit a draft manifest
   * This will finalize the manifest and trigger the dataset import workflow
   */
  commit: async (
    projectId: string,
    dataSetId: string,
    manifestId: string
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.put<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}/status`,
      { status: 'committed' },
      { timeout: 300_000 }
    );
    return response.data;
  },

  /**
   * Replace draft manifest file list from already-uploaded S3 URIs (chunk 0; avoids giant dataset PUT).
   */
  setSourceUris: async (
    projectId: string,
    dataSetId: string,
    manifestId: string,
    uris: string[]
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.put<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}/source-uris`,
      { uris },
      { timeout: Math.min(600_000, 120_000 + uris.length * 500) }
    );
    return response.data;
  },

  /**
   * Append already-uploaded S3 URIs to a draft manifest (subsequent chunks).
   */
  appendSourceUris: async (
    projectId: string,
    dataSetId: string,
    manifestId: string,
    uris: string[]
  ): Promise<DataSetManifest> => {
    const response = await configServiceApi.post<DataSetManifest>(
      `/api/v1/projects/${projectId}/datasets/${dataSetId}/manifests/${manifestId}/append-source-uris`,
      { uris },
      { timeout: Math.min(600_000, 120_000 + uris.length * 500) }
    );
    return response.data;
  },
};

// KnowledgeBase APIs (scoped under projects)
export const knowledgeBaseApi = {
  list: async (projectId: string): Promise<KnowledgeBase[]> => {
    const response = await configServiceApi.get<KnowledgeBase[]>(
      `/api/v1/projects/${projectId}/knowledgebases`
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  get: async (projectId: string, id: string): Promise<KnowledgeBase> => {
    const response = await configServiceApi.get<KnowledgeBase>(
      `/api/v1/projects/${projectId}/knowledgebases/${id}`
    );
    return response.data;
  },

  create: async (projectId: string, data: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> => {
    const response = await configServiceApi.post<KnowledgeBase>(
      `/api/v1/projects/${projectId}/knowledgebases`,
      { ...data, projectId }
    );
    return response.data;
  },

  update: async (
    projectId: string,
    id: string,
    data: UpdateKnowledgeBaseRequest
  ): Promise<KnowledgeBase> => {
    const response = await configServiceApi.put<KnowledgeBase>(
      `/api/v1/projects/${projectId}/knowledgebases/${id}`,
      data
    );
    return response.data;
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/knowledgebases/${id}`);
  },

  /**
   * Re-process a knowledge base by triggering the creation workflow again.
   * Optionally update embedding model and chunking settings before processing.
   * Always uses full processing mode (regenerates all embeddings).
   */
  reprocess: async (
    projectId: string,
    id: string,
    options?: {
      embeddingModel?: string
      vectorSize?: number
      chunkSize?: number
      chunkStrategy?: ChunkStrategy
      chunkOverlap?: number
      chunkOptions?: ChunkOptions
      indexingMode?: IndexingMode
      quantizationType?: QuantizationType
      quantizationOptions?: QuantizationOptions
    }
  ): Promise<{ workflowId: string; status: string; knowledgeBaseId: string; projectId: string }> => {
    const response = await configServiceApi.post<{ workflowId: string; status: string; knowledgeBaseId: string; projectId: string }>(
      `/api/v1/projects/${projectId}/knowledgebases/${id}/create`,
      options || {}
    );
    return response.data;
  },

  /**
   * Search a knowledge base using semantic vector search.
   * This calls the kb-retrieval-service through the API gateway at /kb.
   */
  search: async (
    projectId: string,
    kbId: string,
    request: KBSearchRequest
  ): Promise<KBSearchResponse> => {
    const response = await kbApi.post<KBSearchResponse>(
      `/api/v1/projects/${projectId}/knowledgebases/${kbId}/search`,
      request
    );
    return response.data;
  },

  /**
   * Supplementary actions on existing knowledge bases
   */
  actions: {
    /**
     * Re-process a knowledge base via the embedding facet run route.
     * Triggers a full reprocessing workflow.
     * Optionally update embedding model and chunking settings.
     */
    reprocess: async (
      projectId: string,
      kbId: string,
      options?: {
        embeddingModel?: string
        vectorSize?: number
        chunkSize?: number
        chunkStrategy?: ChunkStrategy
        chunkOverlap?: number
        chunkOptions?: ChunkOptions
        indexingMode?: IndexingMode
        quantizationType?: QuantizationType
        quantizationOptions?: QuantizationOptions
      }
    ): Promise<{ workflowId: string; status: string }> => {
      const response = await configServiceApi.post<{ workflowId: string; status: string }>(
        `/api/v1/projects/${projectId}/knowledgebases/${kbId}/facets/embedding/run`,
        options || {}
      );
      return response.data;
    },
  },
};

// MCP Server Catalog API (not project-scoped)
export const mcpCatalogApi = {
  list: async (): Promise<MCPServerCatalogEntry[]> => {
    const response = await configServiceApi.get<MCPServerCatalogEntry[]>(
      '/api/v1/mcp-server-catalog'
    );
    return Array.isArray(response.data) ? response.data : [];
  },
};

// MCP Server APIs (scoped under projects)
export const mcpServerApi = {
  list: async (projectId: string): Promise<MCPServer[]> => {
    const response = await configServiceApi.get<MCPServer[]>(
      `/api/v1/projects/${projectId}/mcp-servers`
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  get: async (projectId: string, id: string): Promise<MCPServer> => {
    const response = await configServiceApi.get<MCPServer>(
      `/api/v1/projects/${projectId}/mcp-servers/${id}`
    );
    return response.data;
  },

  create: async (projectId: string, data: CreateMCPServerRequest): Promise<MCPServer> => {
    const response = await configServiceApi.post<MCPServer>(
      `/api/v1/projects/${projectId}/mcp-servers`,
      { ...data, projectId }
    );
    return response.data;
  },

  update: async (
    projectId: string,
    id: string,
    data: UpdateMCPServerRequest
  ): Promise<MCPServer> => {
    const response = await configServiceApi.put<MCPServer>(
      `/api/v1/projects/${projectId}/mcp-servers/${id}`,
      data
    );
    return response.data;
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/mcp-servers/${id}`);
  },

  testConnection: async (projectId: string, id: string): Promise<TestConnectionResult> => {
    const response = await configServiceApi.post<TestConnectionResult>(
      `/api/v1/projects/${projectId}/mcp-servers/${id}/test-connection`
    );
    return response.data;
  },

  listTools: async (projectId: string, id: string): Promise<MCPToolInfo[]> => {
    const response = await configServiceApi.get<MCPToolInfo[]>(
      `/api/v1/projects/${projectId}/mcp-servers/${id}/tools`,
      { timeout: 125000 },
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  getRuntimeStatus: async (projectId: string, id: string): Promise<RuntimeStatusInfo> => {
    const response = await configServiceApi.get<RuntimeStatusInfo>(
      `/api/v1/projects/${projectId}/mcp-servers/${id}/runtime-status`
    );
    return response.data;
  },

  callTool: async (projectId: string, id: string, toolName: string, args: Record<string, any>): Promise<any> => {
    const response = await configServiceApi.post(
      `/api/v1/projects/${projectId}/mcp-servers/${id}/tools/call`,
      { toolName, arguments: args },
      { timeout: 120000 },
    );
    return response.data;
  },
};

// Model APIs (scoped under projects)
export interface DependentsSummary {
  total: number
  byKind: Record<string, number>
}

export interface DependentItem {
  kind: string
  id: string
  name: string | null
  relation: string
}

export interface DependentsPage {
  items: DependentItem[]
  nextCursor: string | null
  totalByKind: Record<string, number>
}

export interface DependentsListOptions {
  limit?: number
  cursor?: string
  kind?: string
}

/**
 * Generic dependents API. The backend exposes `.../<entityKind>/:id/dependents`
 * for every entity kind in the catalog; this helper builds the URL from a
 * `routeKind` plural segment (e.g. "models", "agents", "knowledgebases").
 */
export const dependentsApi = {
  list: async (
    projectId: string,
    routeKind: string,
    id: string,
    opts: DependentsListOptions = {},
  ): Promise<DependentsPage> => {
    const params = new URLSearchParams()
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.cursor) params.set('cursor', opts.cursor)
    if (opts.kind) params.set('kind', opts.kind)
    const qs = params.toString()
    const response = await configServiceApi.get<DependentsPage>(
      `/api/v1/projects/${projectId}/${routeKind}/${id}/dependents${qs ? `?${qs}` : ''}`,
    )
    return response.data
  },
}

/**
 * Extract the `dependents` payload from a 409 delete-blocker response so
 * the GUI delete dialog can show actionable content without a second
 * round trip.
 */
export function getDependentsFromError(err: unknown): DependentsPage | null {
  if (!axios.isAxiosError(err)) return null
  const data = err.response?.data as { dependents?: unknown } | undefined
  const d = data?.dependents
  if (!d || typeof d !== 'object') return null
  const candidate = d as Partial<DependentsPage>
  if (!Array.isArray(candidate.items)) return null
  return {
    items: candidate.items as DependentItem[],
    nextCursor: candidate.nextCursor ?? null,
    totalByKind: candidate.totalByKind ?? {},
  }
}

export const modelApi = {
  list: async (
    projectId: string,
    opts?: { modelType?: 'llm' | 'embedding' },
  ): Promise<Model[]> => {
    const params = opts?.modelType ? `?modelType=${encodeURIComponent(opts.modelType)}` : '';
    const response = await configServiceApi.get<Model[]>(
      `/api/v1/projects/${projectId}/models${params}`
    );
    return Array.isArray(response.data) ? response.data : [];
  },

  /** Convenience wrapper — returns only embedding-type models for the KB wizard. */
  listEmbedding: async (projectId: string): Promise<Model[]> => {
    return modelApi.list(projectId, { modelType: 'embedding' });
  },

  get: async (projectId: string, id: string): Promise<Model> => {
    const response = await configServiceApi.get<Model>(
      `/api/v1/projects/${projectId}/models/${id}`
    );
    return response.data;
  },

  create: async (projectId: string, data: Partial<Model>): Promise<Model> => {
    const response = await configServiceApi.post<Model>(
      `/api/v1/projects/${projectId}/models`,
      data
    );
    return response.data;
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/models/${id}`);
  },

  listAvailable: async (
    projectId: string,
    body: { provider: string; credentialId?: string; type?: 'llm' | 'embedding' }
  ): Promise<{ provider: string; models: ProviderModel[] }> => {
    const response = await configServiceApi.post<{ provider: string; models: ProviderModel[] }>(
      `/api/v1/projects/${projectId}/models/list-available`,
      body
    );
    return response.data;
  },

  listClasses: async (projectId: string): Promise<string[]> => {
    const response = await configServiceApi.get<string[]>(
      `/api/v1/projects/${projectId}/models/classes`
    );
    return Array.isArray(response.data) ? response.data : [];
  },
};

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface ModelPlaygroundMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelPlaygroundInvokeRequest {
  messages: ModelPlaygroundMessage[]
  temperature?: number
  maxTokens?: number
}

export interface ModelPlaygroundInvokeResponse {
  response: string
  latencyMs: number
  modelName?: string
  usage?: TokenUsage
}

export const modelPlaygroundApi = {
  invoke: async (
    projectId: string,
    modelId: string,
    payload: ModelPlaygroundInvokeRequest,
  ): Promise<ModelPlaygroundInvokeResponse> => {
    const response = await configServiceApi.post<ModelPlaygroundInvokeResponse>(
      `/api/v1/projects/${projectId}/models/${modelId}/infer`,
      payload,
      { timeout: 125000 },
    )
    return response.data
  },
}

// Search API
export interface SearchRequest {
  entityType: 'connectors' | 'datasets';
  fields?: Record<string, any>;
  nameRegex?: string;
  limit?: number;
  skip?: number;
}

export const searchApi = {
  search: async <T = any>(request: SearchRequest): Promise<T[]> => {
    const response = await configServiceApi.post<T[]>(
      '/api/v1/search',
      request
    );
    return Array.isArray(response.data) ? response.data : [];
  },
};


// Workflow Status & Logs API (via workflow-engine through API gateway)
export interface WorkflowStatus {
  workflowId: string
  runId: string
  workflowType: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'terminated' | 'timed_out' | 'continued_as_new' | 'unknown'
  startTime?: string
  endTime?: string
  executionDuration?: string
  taskQueue?: string
  historyLength: number
  workflowCategory: string
  isRunning: boolean
  failureMessage?: string
  failureDetails?: string
}

export interface WorkflowLogEntry {
  eventId: number
  eventType: string
  timestamp: string
  details?: string
}

export interface WorkflowLogsResponse {
  workflowId: string
  entries: WorkflowLogEntry[]
  total: number
}

export interface WorkflowLogsParams {
  search?: string
  tail?: number
  since?: string
}

/** Live payload from workflow-engine GET …/workflows/:id/progress (in-memory or Redis). */
export interface WorkflowEngineProgress {
  phase?: string
  percentage?: number
  message?: string
  totalUnits?: number
  extra?: Record<string, unknown>
  units?: Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown>; lastUpdated?: string }>
  lastUpdated?: string
}

export const workflowApi = {
  /**
   * Get workflow status/metadata by Temporal workflow ID.
   * Works for all workflow types: kb-creation, dataset-import, pipeline, etc.
   */
  getStatus: async (workflowId: string): Promise<WorkflowStatus> => {
    const response = await workflowApiClient.get<WorkflowStatus>(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/status`
    )
    return response.data
  },

  /**
   * Get workflow result payload for a completed workflow.
   * Returns 404 if not found, 409 if still running.
   */
  getResult: async (workflowId: string): Promise<{ success?: boolean; message?: string; data?: Record<string, unknown> }> => {
    const response = await workflowApiClient.get<{ success?: boolean; message?: string; data?: Record<string, unknown> }>(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/result`
    )
    return response.data
  },

  /**
   * Get workflow logs (Temporal history events) with optional filtering.
   */
  getLogs: async (workflowId: string, params?: WorkflowLogsParams): Promise<WorkflowLogsResponse> => {
    const response = await workflowApiClient.get<WorkflowLogsResponse>(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/logs`,
      { params }
    )
    return response.data
  },

  /**
   * Transient progress (scatter units, acquisition counters). 404 when no row exists yet.
   */
  getProgress: async (workflowId: string): Promise<WorkflowEngineProgress | null> => {
    try {
      const response = await workflowApiClient.get<WorkflowEngineProgress>(
        `/api/v1/workflows/${encodeURIComponent(workflowId)}/progress`
      )
      return response.data ?? null
    } catch (e: unknown) {
      const ax = e as AxiosError
      if (ax.response?.status === 404) return null
      throw e
    }
  },

  /**
   * Request cancellation of a running workflow.
   * Optional runId targets a specific run; omit for current run.
   */
  cancel: async (workflowId: string, runId?: string): Promise<void> => {
    await workflowApiClient.post(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/cancel`,
      runId ? { runId } : {}
    )
  },
}

// Connector API (via workflow-engine through API gateway)
export const connectorApi = {
  testConnection: async (
    projectId: string,
    connectorId: string,
    connectorConfig: DataSourceConnectorConfig,
    credentialId: string
  ): Promise<{ workflowId: string; status: string }> => {
    const response = await workflowApiClient.post(
      `/api/v1/projects/${projectId}/connectors/${connectorId}/test`,
      { connectorConfig, credentialId }
    )
    return response.data
  },
}

// Explorer types
export interface ExplorerNode {
  id: string;
  label: string;
  type: string;
  kind?: string;
  childrenHint?: 'hasChildren' | 'leaf' | 'unknown';
  resource?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  actions?: string[];
}

export interface ExplorerResponse {
  nodes: ExplorerNode[];
  nextToken?: string;
  error?: { code: string; message: string };
}

export interface DataAccessModel {
  rootAction: string;
  selectionMode: 'single' | 'multi';
  selectableTypes: string[];
  queryEditor?: { language: string };
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  scopes: ('account' | 'resource')[];
  supportedActions: string[];
  supportedNodeTypes: string[];
  connectorConfigSchema: Record<string, {
    required: string[];
    optional: string[];
    properties: Record<string, { type: string; description?: string }>;
  }>;
  hasAcquisition: boolean;
  hasRegionSelector?: boolean;
  dataAccessModel?: DataAccessModel;
}

export const explorerApi = {
  getProviders: async (): Promise<{ providers: ProviderCatalogEntry[] }> => {
    const response = await configServiceApi.get<{ providers: ProviderCatalogEntry[] }>(
      '/api/v1/explorer/providers'
    )
    return response.data
  },

  startSession: async (
    projectId: string,
    connectorId: string
  ): Promise<{ sessionId: string }> => {
    const response = await workflowApiClient.post<{ sessionId: string }>(
      '/api/v1/explore/session',
      { projectId, connectorId }
    )
    return response.data
  },

  list: async (
    sessionId: string,
    action: string,
    payload: Record<string, unknown> = {},
    options?: { projectId?: string; connectorId?: string; refresh?: boolean }
  ): Promise<ExplorerResponse> => {
    const body: Record<string, unknown> = { action, payload }
    if (options?.projectId && options?.connectorId) {
      body.projectId = options.projectId
      body.connectorId = options.connectorId
    }
    if (options?.refresh === true) {
      body.refresh = true
    }
    const response = await workflowApiClient.post<ExplorerResponse>(
      `/api/v1/explore/session/${encodeURIComponent(sessionId)}/list`,
      body
    )
    return response.data
  },
}

// Volume browsing API -- list directory contents of a mounted volume
export interface VolumeDirEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  lastModified: string;
}

export interface VolumeBrowseResult {
  entries: VolumeDirEntry[];
  mountPath: string;
  subPath: string;
  totalDirCount?: number;
  totalFileCount?: number;
  scannedEntries?: number;
  truncated?: boolean;
}

export const volumeBrowseApi = {
  listDirectory: async (
    projectId: string,
    volumeId: string,
    subPath: string = ''
  ): Promise<VolumeBrowseResult> => {
    const response = await workflowApiClient.post<VolumeBrowseResult>(
      '/api/v1/connectors/volume-browse',
      { projectId, volumeId, subPath }
    )
    return response.data
  },
}

// Acquisition API -- dataset-scoped operations (via workflow-engine through API gateway)
export const acquisitionApi = {
  acquire: async (projectId: string, datasetId: string): Promise<{ workflowId: string; status: string; datasetId: string }> => {
    const response = await workflowApiClient.post(
      `/api/v1/projects/${projectId}/datasets/${datasetId}/acquire`
    )
    return response.data
  },
  createSchedule: async (
    projectId: string,
    datasetId: string,
    cronExpression: string,
    timezone: string
  ): Promise<{ temporalScheduleId: string; cronExpression: string; timezone: string }> => {
    const response = await workflowApiClient.post(
      `/api/v1/projects/${projectId}/datasets/${datasetId}/schedule`,
      { cronExpression, timezone, enabled: true }
    )
    return response.data
  },
  deleteSchedule: async (projectId: string, datasetId: string, temporalScheduleId: string): Promise<void> => {
    await workflowApiClient.delete(
      `/api/v1/projects/${projectId}/datasets/${datasetId}/schedule`,
      { data: { temporalScheduleId } }
    )
  },
}

// Agent Types
export interface Agent {
  id: string
  projectId: string
  name: string
  description?: string
  role: string
  systemPrompt: string
  modelId?: string
  modelClass?: string
  temperature?: number
  maxTokens?: number
  mcpServerIds: string[]
  mcpServerConfig?: Record<string, { permissions: string[]; rateLimit?: number; allowedTools?: string[] }>
  knowledgeBaseIds: string[]
  ragConfig?: {
    topK: number
    similarityThreshold: number
    searchMode: 'semantic' | 'hybrid' | 'fts'
  }
  datasetIds: string[]
  outcomeSchema?: object
  outcomeDescription?: string
  memoryType: 'none' | 'conversation' | 'sliding_window'
  memoryConfig?: { windowSize?: number }
  guardrails?: {
    maxIterations: number
    timeoutSeconds: number
    contentFilters?: string[]
  }
  dependentsSummary?: DependentsSummary
  createdAt: string
  updatedAt: string
}

export interface CreateAgentRequest {
  name: string
  description?: string
  role: string
  systemPrompt: string
  modelId?: string
  modelClass?: string
  temperature?: number
  maxTokens?: number
  mcpServerIds?: string[]
  mcpServerConfig?: Record<string, { permissions: string[]; rateLimit?: number; allowedTools?: string[] }>
  knowledgeBaseIds?: string[]
  ragConfig?: {
    topK: number
    similarityThreshold: number
    searchMode: 'semantic' | 'hybrid' | 'fts'
  }
  outcomeSchema?: object
  outcomeDescription?: string
  memoryType?: 'none' | 'conversation' | 'sliding_window'
  memoryConfig?: { windowSize?: number }
  guardrails?: {
    maxIterations: number
    timeoutSeconds: number
    contentFilters?: string[]
  }
}

export type UpdateAgentRequest = Partial<CreateAgentRequest>

export interface AgentTeam {
  id: string
  projectId: string
  name: string
  description?: string
  orchestrationPolicy: 'coordinate' | 'route' | 'collaborate' | 'sequential'
  manager?: {
    name: string
    role?: string
    modelId?: string
    modelClass?: string
    systemPrompt: string
    temperature?: number
    maxTokens?: number
  }
  members: Array<{
    memberType: 'agent' | 'team'
    memberId: string
    role?: string
  }>
  sharedKnowledgeBaseIds: string[]
  sharedDatasetIds: string[]
  dependentsSummary?: DependentsSummary
  createdAt: string
  updatedAt: string
}

// Agent APIs (scoped under projects)
export const agentApi = {
  list: async (projectId: string): Promise<Agent[]> => {
    const response = await configServiceApi.get<Agent[]>(
      `/api/v1/projects/${projectId}/agents`
    )
    return Array.isArray(response.data) ? response.data : []
  },

  get: async (projectId: string, id: string): Promise<Agent> => {
    const response = await configServiceApi.get<Agent>(
      `/api/v1/projects/${projectId}/agents/${id}`
    )
    return response.data
  },

  create: async (projectId: string, data: CreateAgentRequest): Promise<Agent> => {
    const response = await configServiceApi.post<Agent>(
      `/api/v1/projects/${projectId}/agents`,
      { ...data, projectId }
    )
    return response.data
  },

  update: async (projectId: string, id: string, data: UpdateAgentRequest): Promise<Agent> => {
    const response = await configServiceApi.put<Agent>(
      `/api/v1/projects/${projectId}/agents/${id}`,
      data
    )
    return response.data
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/agents/${id}`)
  },

  getHistory: async (projectId: string, id: string): Promise<any[]> => {
    const response = await configServiceApi.get<any[]>(
      `/api/v1/projects/${projectId}/agents/${id}/history`
    )
    return Array.isArray(response.data) ? response.data : []
  },

  restoreVersion: async (projectId: string, id: string, version: number): Promise<any> => {
    const response = await configServiceApi.post(
      `/api/v1/projects/${projectId}/agents/${id}/restore-version`,
      { version }
    )
    return response.data
  },
}

// Agent Team APIs (scoped under projects)
export const agentTeamApi = {
  list: async (projectId: string): Promise<AgentTeam[]> => {
    const response = await configServiceApi.get<AgentTeam[]>(
      `/api/v1/projects/${projectId}/agent-teams`
    )
    return Array.isArray(response.data) ? response.data : []
  },

  get: async (projectId: string, id: string): Promise<AgentTeam> => {
    const response = await configServiceApi.get<AgentTeam>(
      `/api/v1/projects/${projectId}/agent-teams/${id}`
    )
    return response.data
  },

  create: async (projectId: string, data: Partial<AgentTeam>): Promise<AgentTeam> => {
    const response = await configServiceApi.post<AgentTeam>(
      `/api/v1/projects/${projectId}/agent-teams`,
      { ...data, projectId }
    )
    return response.data
  },

  update: async (projectId: string, id: string, data: Partial<AgentTeam>): Promise<AgentTeam> => {
    const response = await configServiceApi.put<AgentTeam>(
      `/api/v1/projects/${projectId}/agent-teams/${id}`,
      data
    )
    return response.data
  },

  delete: async (projectId: string, id: string): Promise<void> => {
    await configServiceApi.delete(`/api/v1/projects/${projectId}/agent-teams/${id}`)
  },
}

// Agent Invoke APIs (use agent-service via /agents gateway proxy)
export const agentInvokeApi = {
  /**
   * Fire-and-forget async invocation.
   * Returns a taskId immediately; poll with getTaskStatus().
   */
  invokeAsync: async (
    projectId: string,
    agentId: string,
    message: string,
    sessionId: string | null,
  ): Promise<{ taskId: string }> => {
    const response = await agentServiceApi.post<{ taskId: string }>(
      `/api/v1/projects/${projectId}/agents/${agentId}/invoke/async`,
      { message, sessionId },
    )
    return response.data
  },

  /**
   * Poll task status until completed / failed.
   */
  getTaskStatus: async (
    projectId: string,
    taskId: string,
  ): Promise<{
    status: string;
    result?: {
      response: string;
      sessionId: string;
      latencyMs?: number;
      modelName?: string;
      usage?: TokenUsage;
      citations?: Array<{
        source: string;
        documentId?: string;
        downloadUrl?: string;
        knowledgeBaseId?: string;
        knowledgeBaseName?: string;
        score?: number;
      }>;
    };
    error?: string;
  }> => {
    const response = await agentServiceApi.get(
      `/api/v1/projects/${projectId}/tasks/${taskId}`,
    )
    return response.data
  },

  /**
   * High-level helper: invoke async and poll until done.
   * Calls onProgress while polling, onDone when complete, onError on failure.
   * Returns an AbortController to cancel the polling loop.
   */
  invoke: (
    projectId: string,
    agentId: string,
    message: string,
    sessionId: string | null,
    onDone: (response: string, sessionId: string, metadata?: {
      latencyMs?: number;
      modelName?: string;
      usage?: TokenUsage;
      citations?: Array<{
        source: string;
        documentId?: string;
        downloadUrl?: string;
        knowledgeBaseId?: string;
        knowledgeBaseName?: string;
        score?: number;
      }>;
    }) => void,
    onError: (error: string) => void,
  ): AbortController => {
    const controller = new AbortController()

    const run = async () => {
      try {
        const { taskId } = await agentInvokeApi.invokeAsync(
          projectId, agentId, message, sessionId,
        )

        const POLL_INTERVAL = 2000
        const MAX_POLLS = 150 // 5 minutes max

        for (let i = 0; i < MAX_POLLS; i++) {
          if (controller.signal.aborted) return

          await new Promise((r) => setTimeout(r, POLL_INTERVAL))
          if (controller.signal.aborted) return

          const task = await agentInvokeApi.getTaskStatus(projectId, taskId)

          if (task.status === 'completed' && task.result) {
            onDone(task.result.response, task.result.sessionId, {
              latencyMs: task.result.latencyMs,
              modelName: task.result.modelName,
              usage: task.result.usage,
              citations: task.result.citations,
            })
            return
          }
          if (task.status === 'failed') {
            onError(task.error || 'Agent task failed')
            return
          }
        }

        onError('Agent response timed out')
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        onError(err instanceof Error ? err.message : 'Invocation failed')
      }
    }

    run()
    return controller
  },

  listSessions: async (projectId: string, agentId: string): Promise<SessionInfo[]> => {
    const response = await agentServiceApi.get<{ sessions: SessionInfo[] }>(
      `/api/v1/projects/${projectId}/agents/${agentId}/sessions`
    )
    return response.data.sessions || []
  },

  getSession: async (
    projectId: string,
    agentId: string,
    sessionId: string
  ): Promise<{
    sessionId: string;
    name?: string;
    createdAt?: string;
    messages: Array<{
      role: string;
      content: string;
      timestamp?: string;
      latencyMs?: number;
      modelName?: string;
      usage?: TokenUsage;
      traceId?: string;
      citations?: Array<{
        source: string;
        documentId?: string;
        downloadUrl?: string;
        knowledgeBaseId?: string;
        knowledgeBaseName?: string;
        score?: number;
      }>;
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        args?: Record<string, unknown>;
        result?: unknown;
      }>;
    }>;
  }> => {
    const response = await agentServiceApi.get(
      `/api/v1/projects/${projectId}/agents/${agentId}/sessions/${sessionId}`
    )
    return response.data
  },

  renameSession: async (
    projectId: string,
    agentId: string,
    sessionId: string,
    name: string
  ): Promise<{ sessionId: string; name: string }> => {
    const response = await agentServiceApi.patch(
      `/api/v1/projects/${projectId}/agents/${agentId}/sessions/${sessionId}`,
      { name }
    )
    return response.data
  },

  deleteSession: async (
    projectId: string,
    agentId: string,
    sessionId: string
  ): Promise<void> => {
    await agentServiceApi.delete(
      `/api/v1/projects/${projectId}/agents/${agentId}/sessions/${sessionId}`
    )
  },
}

// Agent Team Invoke APIs (use agent-service)
export const agentTeamInvokeApi = {
  invokeAsync: async (
    projectId: string,
    teamId: string,
    message: string,
    sessionId: string | null,
  ): Promise<{ taskId: string }> => {
    const response = await agentServiceApi.post<{ taskId: string }>(
      `/api/v1/projects/${projectId}/agent-teams/${teamId}/invoke/async`,
      { message, sessionId },
    )
    return response.data
  },

  invokeSync: async (
    projectId: string,
    teamId: string,
    message: string,
    sessionId: string | null,
  ): Promise<{
    response: string
    sessionId: string
    latencyMs?: number
    modelName?: string
    usage?: TokenUsage
  }> => {
    const response = await agentServiceApi.post(
      `/api/v1/projects/${projectId}/agent-teams/${teamId}/invoke`,
      { message, sessionId },
    )
    return response.data
  },

  listSessions: async (projectId: string, teamId: string): Promise<SessionInfo[]> => {
    const response = await agentServiceApi.get<{ sessions: SessionInfo[] }>(
      `/api/v1/projects/${projectId}/agent-teams/${teamId}/sessions`
    )
    return response.data.sessions || []
  },

  getSession: async (
    projectId: string,
    teamId: string,
    sessionId: string,
  ): Promise<{
    sessionId: string
    name?: string
    createdAt?: string
    messages: Array<{
      role: 'user' | 'assistant'
      content: string
      timestamp?: string
      latencyMs?: number
      modelName?: string
      usage?: TokenUsage
      traceId?: string
      citations?: Array<{
        source: string
        documentId?: string
        downloadUrl?: string
        knowledgeBaseId?: string
        knowledgeBaseName?: string
        score?: number
      }>
      toolCalls?: Array<{
        id?: string
        name?: string
        arguments?: string
        result?: any
      }>
    }>
  }> => {
    const response = await agentServiceApi.get(
      `/api/v1/projects/${projectId}/agent-teams/${teamId}/sessions/${sessionId}`
    )
    return response.data
  },

  renameSession: async (
    projectId: string,
    teamId: string,
    sessionId: string,
    name: string,
  ): Promise<{ sessionId: string; name: string }> => {
    const response = await agentServiceApi.patch(
      `/api/v1/projects/${projectId}/agent-teams/${teamId}/sessions/${sessionId}`,
      { name }
    )
    return response.data
  },

  deleteSession: async (
    projectId: string,
    teamId: string,
    sessionId: string,
  ): Promise<void> => {
    await agentServiceApi.delete(
      `/api/v1/projects/${projectId}/agent-teams/${teamId}/sessions/${sessionId}`
    )
  },
}

/** Span row from Phoenix REST API (via agent-service proxy). */
export interface TraceSpan {
  id?: string
  name: string
  context: { trace_id: string; span_id: string }
  span_kind: string
  parent_id: string | null
  start_time: string
  end_time: string
  status_code: string
  status_message?: string
  attributes?: Record<string, unknown>
  events?: unknown[]
}

export const traceApi = {
  getSpans: async (projectId: string, traceId: string): Promise<TraceSpan[]> => {
    const response = await agentServiceApi.get<{ data: TraceSpan[]; next_cursor?: string | null }>(
      `/api/v1/projects/${projectId}/traces/${encodeURIComponent(traceId)}/spans`,
    )
    const body = response.data as { data?: TraceSpan[] } | TraceSpan[]
    if (Array.isArray(body)) return body
    return body.data ?? []
  },
}

export interface SessionInfo {
  id: string
  name: string
  createdAt: string
}

// ─── Lineage API ────────────────────────────────────────────────────────────

export const lineageApi = {
  getGraph: async (projectId: string): Promise<Facet | null> => {
    try {
      const resp = await configServiceApi.get(`/api/v1/projects/${projectId}/facets/lineage`)
      return resp.data?.data ?? null
    } catch (err: any) {
      if (err?.response?.status === 404) return null
      throw err
    }
  },
}

export { configServiceApi }
export default api


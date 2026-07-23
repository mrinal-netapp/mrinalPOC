export interface EnvSchemaEntry {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  /** Resolved default value, populated at API response time from defaultEnvFn. */
  defaultValue?: string;
}

export interface VolumeMount {
  mountPath: string;
  sizeDefault: string;
}

export interface RBACRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

export interface SecretKeyRef {
  secretName: string;
  key: string;
  envVar: string;
}

/**
 * Maps a connector credential's secret keys onto the runtime environment of a
 * managed MCP server. When a catalog entry declares ``credentialMapping``, the
 * MCPServer record must supply ``runtimeCredentialId`` pointing at a credential
 * whose ``provider`` matches ``expectedProvider``. The MCPRuntimeManager
 * materializes the credential into a per-server K8s Secret and projects each
 * mapped key as either an env var (``envFromKeys``) or a mounted file
 * (``fileFromKeys``).
 */
export interface CredentialFileMapping {
  /** In-pod path where the credential value is written. */
  mountPath: string;
  /** Env var that exposes ``mountPath`` to the application. */
  envForPath: string;
  /** Octal mode for the projected file (default 0o400). */
  mode?: number;
}

export interface CredentialMapping {
  /** Credential.provider must equal this value (e.g. 'ontap'). */
  expectedProvider: string;
  /** credentialKey -> env var name. Keys missing from the credential are skipped. */
  envFromKeys?: Record<string, string>;
  /** credentialKey -> file projection. Keys missing from the credential are skipped. */
  fileFromKeys?: Record<string, CredentialFileMapping>;
}

export interface MCPServerCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: 'infrastructure' | 'database' | 'filesystem' | 'development' | 'general' | 'monitoring';
  image: string;
  defaultTag: string;
  envSchema: EnvSchemaEntry[];
  securityProfile: 'strict' | 'network-access';
  resourcePreset: 'small' | 'medium' | 'large';
  requiresRBAC: boolean;
  clusterRoleName?: string;
  rbacRules?: RBACRule[];
  volumeMounts?: VolumeMount[];
  /** Health check path for liveness/readiness probes. Defaults to '/healthz' (supergateway). */
  healthPath?: string;
  /** Additional TCP ports to allow in the egress NetworkPolicy. */
  egressPorts?: number[];
  /** Individual key-to-env-var mappings from existing K8s Secrets. */
  secretKeyRefs?: SecretKeyRef[];
  /** Returns default env vars at provisioning time; user-provided envOverrides take precedence. */
  defaultEnvFn?: () => Record<string, string>;
  /** Override for container readOnlyRootFilesystem (defaults to true). */
  readOnlyRootFilesystem?: boolean;
  /** Override for container runAsNonRoot (defaults to true). */
  runAsNonRoot?: boolean;
  /** Override for container runAsUser. */
  runAsUser?: number;
  /** Override for container runAsGroup. */
  runAsGroup?: number;
  /** Probe type for liveness/readiness (defaults to 'http'). */
  healthProbe?: 'http' | 'tcp';
  /** Override for container imagePullPolicy (defaults to K8s default, typically IfNotPresent). */
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  /** Static prompt fragment injected into the agent system prompt when this server is attached. Supports {projectId} placeholder interpolation. */
  promptFragment?: string;
  /** Optional default allowed tools applied when caller does not provide tool filters. */
  defaultAllowedTools?: string[];
  /** Optional container command override for managed runtime pods. */
  command?: string[];
  /** Optional container args override for managed runtime pods. */
  args?: string[];
  /** HTTP path exposed by MCP runtime (default: /mcp). */
  mcpPath?: string;
  /**
   * When set, MCPServer.runtimeCredentialId is required and the credential's
   * provider must equal ``expectedProvider``. The runtime materializes the
   * credential into a per-server Secret and projects values as env vars / files.
   */
  credentialMapping?: CredentialMapping;
}

export const WEB_SEARCH_CATALOG_ID = 'web_search_mcp';
export const SEARXNG_WEB_SEARCH_CATALOG_ID = 'searxng_web_search_mcp';
export const ANALYTICS_DATASETS_CATALOG_ID = 'analytics_datasets_mcp';
/**
 * Platform-managed MCP server backing the artifact store. Registered
 * eagerly on config-service startup by `services/PlatformMCPBootstrap.ts`
 * so agents see it as soon as artifact-service is up.
 */
export const ARTIFACT_STORE_CATALOG_ID = 'artifact_store_mcp';

export const RESOURCE_PRESETS: Record<string, { cpu: string; memory: string; cpuLimit: string; memoryLimit: string }> = {
  small:  { cpu: '100m', memory: '256Mi', cpuLimit: '500m',  memoryLimit: '512Mi'  },
  medium: { cpu: '250m', memory: '512Mi', cpuLimit: '1000m', memoryLimit: '1Gi'    },
  large:  { cpu: '500m', memory: '1Gi',   cpuLimit: '2000m', memoryLimit: '2Gi'    },
};

export const MCP_SERVER_CATALOG: MCPServerCatalogEntry[] = [
  {
    id: WEB_SEARCH_CATALOG_ID,
    name: 'Tavily Web Search',
    description: 'Internet search via Tavily MCP with provider defaults and bounded query behavior.',
    category: 'general',
    image: 'nemo/mcp-server-web-search',
    defaultTag: 'latest',
    envSchema: [
      { name: 'TAVILY_API_KEY', description: 'Tavily API key used for internet search requests', required: true, secret: true },
      { name: 'TAVILY_TIMEOUT_MS', description: 'Per-request timeout in milliseconds (1000-30000)', required: false, secret: false, defaultValue: '10000' },
      { name: 'TAVILY_MAX_RETRIES', description: 'Maximum retries on transient provider failures (0-3)', required: false, secret: false, defaultValue: '1' },
      { name: 'TAVILY_MAX_RESULTS', description: 'Maximum search results returned per query (1-10)', required: false, secret: false, defaultValue: '5' },
      { name: 'TAVILY_ALLOWED_DOMAINS', description: 'Comma-separated domain allowlist. Empty means provider default behavior.', required: false, secret: false, defaultValue: '' },
    ],
    defaultEnvFn: () => ({
      TAVILY_TIMEOUT_MS: '10000',
      TAVILY_MAX_RETRIES: '1',
      TAVILY_MAX_RESULTS: '5',
      TAVILY_ALLOWED_DOMAINS: '',
    }),
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    defaultAllowedTools: ['tavily_search'],
    promptFragment: [
      'You have access to Tavily web search tools for current web information.',
      'Use web search only when external information is required, and cite sources in your response.',
      'Prefer concise queries and summarize findings instead of copying raw snippets.',
    ].join('\n'),
  },
  {
    id: SEARXNG_WEB_SEARCH_CATALOG_ID,
    name: 'SearxNG Web Search',
    description: 'Metasearch web search via SearxNG with no provider API key required.',
    category: 'general',
    image: 'nemo/mcp-server-searxng',
    defaultTag: 'latest',
    envSchema: [
      { name: 'SEARXNG_URL', description: 'Base URL for SearxNG instance (e.g. http://searxng:8080)', required: true, secret: false },
      { name: 'SEARXNG_BASE_URL', description: 'Legacy alias for SearxNG base URL', required: false, secret: false },
      { name: 'SEARXNG_TIMEOUT_MS', description: 'Per-request timeout in milliseconds (1000-30000)', required: false, secret: false, defaultValue: '10000' },
      { name: 'SEARXNG_MAX_RESULTS', description: 'Maximum results returned per query (1-10)', required: false, secret: false, defaultValue: '5' },
      { name: 'SEARXNG_ENGINES', description: 'Comma-separated engines to query (optional)', required: false, secret: false, defaultValue: '' },
      { name: 'SEARXNG_SAFE_SEARCH', description: 'Safe-search level: 0, 1, or 2', required: false, secret: false, defaultValue: '1' },
    ],
    defaultEnvFn: () => ({
      SEARXNG_URL: process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL || 'http://searxng:8080',
      SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL || process.env.SEARXNG_URL || 'http://searxng:8080',
      SEARXNG_TIMEOUT_MS: '10000',
      SEARXNG_MAX_RESULTS: '5',
      SEARXNG_ENGINES: '',
      SEARXNG_SAFE_SEARCH: '1',
    }),
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    defaultAllowedTools: [],
    promptFragment: [
      'You have access to SearxNG metasearch tools for web information.',
      'Prefer focused queries and summarize key findings with source links.',
      'Use web tools only when external/current information is needed.',
    ].join('\n'),
  },
  {
    id: 'kubernetes_mcp',
    name: 'Kubernetes',
    description: 'Read-only access to Kubernetes cluster resources including pods, services, deployments, logs, and metrics.',
    category: 'infrastructure',
    image: 'nemo/mcp-server-kubernetes',
    defaultTag: 'latest',
    envSchema: [],
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: true,
    clusterRoleName: 'mcp-server-kubernetes-readonly',
    healthPath: '/stats',
    promptFragment: [
      'You have read-only access to Kubernetes cluster resources.',
      'When presenting pod/deployment status, use markdown tables for listings.',
      'For resource relationships, consider using Mermaid flowcharts.',
      'Always include namespace context in your responses.',
    ].join('\n'),
    rbacRules: [
      { apiGroups: [''], resources: ['pods', 'services', 'configmaps', 'secrets', 'namespaces', 'nodes', 'persistentvolumeclaims', 'events'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: [''], resources: ['pods/log'], verbs: ['get', 'list'] },
      { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets', 'replicasets'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['metrics.k8s.io'], resources: ['pods', 'nodes'], verbs: ['get', 'list'] },
    ],
  },
  {
    id: 'postgres_mcp',
    name: 'PostgreSQL',
    description: 'Read-only access to PostgreSQL databases. Enables schema inspection and SQL query execution.',
    category: 'database',
    image: 'nemo/mcp-server-postgres',
    defaultTag: 'latest',
    envSchema: [
      { name: 'POSTGRES_CONNECTION_STRING', description: 'PostgreSQL connection URI (e.g. postgresql://user:pass@host:5432/db)', required: true, secret: true },
    ],
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    promptFragment: [
      'You have access to a PostgreSQL database via SQL tools.',
      'Always inspect the schema before querying (use list_tables or describe_table).',
      'Use parameterized queries where possible. Present query results as markdown tables.',
    ].join('\n'),
  },
  {
    id: 'filesystem_mcp',
    name: 'Filesystem',
    description: 'Local filesystem access with configurable allowed paths. Supports read, write, search, and directory operations.',
    category: 'filesystem',
    image: 'nemo/mcp-server-filesystem',
    defaultTag: 'latest',
    envSchema: [],
    securityProfile: 'strict',
    resourcePreset: 'small',
    requiresRBAC: false,
    volumeMounts: [{ mountPath: '/data', sizeDefault: '1Gi' }],
    promptFragment: [
      'You have access to the local filesystem with configurable paths.',
      'When listing directory contents, format them as markdown tables.',
    ].join('\n'),
  },
  {
    id: 'github_mcp',
    name: 'GitHub',
    description: 'Access GitHub repositories, issues, pull requests, and more via the GitHub API.',
    category: 'development',
    image: 'nemo/mcp-server-github',
    defaultTag: 'latest',
    envSchema: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub Personal Access Token', required: true, secret: true },
    ],
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    promptFragment: [
      'You have access to GitHub repositories, issues, and pull requests.',
      'When listing issues or PRs, format them as markdown tables with key columns (number, title, status, author).',
    ].join('\n'),
  },
  {
    id: 'sqlite_mcp',
    name: 'SQLite',
    description: 'SQLite database access with persistent storage. Supports schema inspection and query execution.',
    category: 'database',
    image: 'nemo/mcp-server-sqlite',
    defaultTag: 'latest',
    envSchema: [],
    securityProfile: 'strict',
    resourcePreset: 'small',
    requiresRBAC: false,
    volumeMounts: [{ mountPath: '/data', sizeDefault: '1Gi' }],
    promptFragment: [
      'You have access to a SQLite database.',
      'Always inspect the schema before querying. Present query results as markdown tables.',
    ].join('\n'),
  },
  {
    id: 'memory_mcp',
    name: 'Memory',
    description: 'Stateless in-memory knowledge graph for storing and querying structured data during agent sessions.',
    category: 'general',
    image: 'nemo/mcp-server-memory',
    defaultTag: 'latest',
    envSchema: [],
    securityProfile: 'strict',
    resourcePreset: 'small',
    requiresRBAC: false,
    promptFragment: [
      'You have access to an in-memory knowledge graph.',
      'Use it to store and recall structured facts during the conversation.',
      'When presenting graph contents, consider using Mermaid flowcharts to show entity relationships.',
    ].join('\n'),
  },
  {
    id: 'duckdb_iceberg',
    name: 'DuckDB Iceberg',
    description: 'SQL access to project datasets in the Iceberg catalog via DuckDB.',
    category: 'database',
    image: 'nemo/mcp-server-duckdb',
    defaultTag: 'latest',
    envSchema: [
      { name: 'WAREHOUSE_NAME', description: 'Lakekeeper warehouse name', required: false, secret: false },
      { name: 'LAKEKEEPER_CATALOG_URL', description: 'Lakekeeper catalog REST URL', required: false, secret: false },
      { name: 'KEYCLOAK_TOKEN_URL', description: 'Keycloak OIDC token endpoint URL', required: false, secret: false },
      { name: 'MAX_ROWS', description: 'Maximum rows returned per query', required: false, secret: false },
    ],
    defaultEnvFn: () => ({
      WAREHOUSE_NAME: process.env.DUCKDB_DEFAULT_WAREHOUSE || 'nemo',
      LAKEKEEPER_CATALOG_URL: process.env.LAKEKEEPER_CATALOG_URL || 'http://lakekeeper:8181/catalog',
      KEYCLOAK_TOKEN_URL: process.env.DUCKDB_KEYCLOAK_TOKEN_URL
        || `${process.env.KEYCLOAK_INTERNAL_ISSUER || 'http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo'}/protocol/openid-connect/token`,
      OAUTH2_SCOPE: 'openid profile email',
      MAX_ROWS: '500',
      S3_ENDPOINT: process.env.DUCKDB_S3_ENDPOINT || '',
    }),
    secretKeyRefs: [
      { secretName: 'keycloak-oidc-secrets', key: 'lakekeeper-client-id', envVar: 'LAKEKEEPER_CLIENT_ID' },
      { secretName: 'keycloak-oidc-secrets', key: 'lakekeeper-client-secret', envVar: 'LAKEKEEPER_CLIENT_SECRET' },
      { secretName: 'nemo-s3gateway-credentials', key: 'access-key', envVar: 'S3_ACCESS_KEY' },
      { secretName: 'nemo-s3gateway-credentials', key: 'secret-key', envVar: 'S3_SECRET_KEY' },
    ],
    egressPorts: [8181, 8080, 7070],
    securityProfile: 'network-access',
    resourcePreset: 'medium',
    requiresRBAC: false,
    readOnlyRootFilesystem: false,
    healthProbe: 'tcp',
    promptFragment: [
      'You have access to SQL data tools for querying project datasets.',
      'Tables are in the Iceberg catalog at: iceberg.{projectId}.<table_name>.',
      'Always call list_tables(database="iceberg", schema="{projectId}") to discover available tables.',
      'Use execute_query with fully qualified names like: SELECT * FROM iceberg."{projectId}".<table> LIMIT 100.',
      '',
      'IMPORTANT — How to present execute_query results:',
      'The UI AUTOMATICALLY renders every execute_query result as an interactive table with chart toggle.',
      'You MUST NOT include markdown tables, code blocks, or any reproduction of the query data in your text.',
      'NEVER render the rows or columns yourself — the UI already does it.',
      'Your text response after an execute_query call should ONLY contain:',
      '  1. A brief natural-language summary of the key insights (1-3 sentences)',
      '  2. Any notable patterns, outliers, or observations',
      'Do NOT echo column names, row values, counts, or raw numbers in table format.',
      '',
      'For list_tables, list_columns, and other metadata tools (NOT execute_query): you may format results as markdown tables.',
      '',
      'For aggregations, write SQL with clear column aliases (e.g. SELECT category AS label, COUNT(*) AS count) so the chart renderer can auto-detect axes.',
    ].join('\n'),
  },
  {
    id: 'Ontap_mcp_logs',
    name: 'NetApp ONTAP',
    description: 'Discover and manage NetApp ONTAP storage (SVMs, volumes, LUNs, snapshots) and query EMS/audit logs via REST.',
    category: 'infrastructure',
    image: 'nemo/mcp-server-ontap',
    defaultTag: 'latest',
    envSchema: [
      // Cluster URL is the only env var the user must provide directly. Everything else
      // is materialized from the linked runtime credential by MCPRuntimeManager.
      { name: 'ONTAP_CLUSTER_URL', description: 'ONTAP cluster management URL (e.g. https://cluster.example.com)', required: true,  secret: false },
      { name: 'ONTAP_VERIFY_TLS',  description: 'Verify TLS certificate (true/false)', required: false, secret: false, defaultValue: 'true' },
      { name: 'ONTAP_DEFAULT_SVM', description: 'Optional default SVM name to scope tool calls', required: false, secret: false },
    ],
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    healthProbe: 'http',
    /*
     * Tool surface — keep these names stable; the catalog and the in-tree
     * mcp-server-ontap server.py share this list. Adding new tools is
     * additive; renames must update both sides and bump defaultAllowedTools.
     *   Read:  list_svms, list_volumes, list_luns, list_snapshots,
     *          list_aggregates, list_network_interfaces, get_volume,
     *          get_cluster, get_volume_metrics,
     *          query_ems_events, get_ems_event, lookup_ems_message,
     *          query_audit_messages
     *   Write: create_snapshot, delete_snapshot, restore_snapshot,
     *          create_volume, delete_volume, resize_volume,
     *          set_volume_qos, set_export_policy
     */
    defaultAllowedTools: [
      'list_svms', 'list_volumes', 'list_luns', 'list_snapshots',
      'list_aggregates', 'list_network_interfaces',
      'get_volume', 'get_cluster', 'get_volume_metrics',
      'query_ems_events', 'get_ems_event', 'lookup_ems_message', 'query_audit_messages',
    ],
    credentialMapping: {
      expectedProvider: 'ontap',
      envFromKeys: {
        username: 'ONTAP_USERNAME',
        password: 'ONTAP_PASSWORD',
      },
      fileFromKeys: {
        client_cert_pem: { mountPath: '/etc/ontap/client.crt', envForPath: 'ONTAP_CLIENT_CERT_PATH', mode: 0o400 },
        client_key_pem:  { mountPath: '/etc/ontap/client.key', envForPath: 'ONTAP_CLIENT_KEY_PATH',  mode: 0o400 },
        ca_bundle_pem:   { mountPath: '/etc/ontap/ca.pem',     envForPath: 'ONTAP_CA_BUNDLE_PATH',   mode: 0o444 },
      },
    },
    promptFragment: [
      'You can read and (when allowed) manage NetApp ONTAP storage resources via MCP tools.',
      'For cluster events use query_ems_events; for admin/API command history use query_audit_messages.',
      'Use hours (e.g. 720 for 30 days) or ISO-8601 time_after/time_before on log tools to bound the query window.',
      'Use lookup_ems_message to explain EMS event names (description and corrective action).',
      'Log tools query live ONTAP buffers — not long-term archives. Narrow filters (severity, log_message) before large max_records.',
      'Always discover SVMs and volumes before acting. Confirm destructive actions (delete_volume, delete_snapshot).',
      'Present listings as markdown tables; for capacity show used/total and a percentage.',
      'Write tools are gated by the per-server allowedTools list; if a write tool fails with "tool not found", ask the operator to enable it.',
    ].join('\n'),
  },
  {
    id: 'ontap_mcp_official',
    name: 'NetApp ONTAP (Official MCP)',
    description: 'Official NetApp ONTAP MCP server integration (read-first by default, writes require explicit tool allowlist expansion).',
    category: 'infrastructure',
    image: 'ghcr.io/netapp/ontap-mcp',
    defaultTag: 'latest',
    args: ['start', '--host', '0.0.0.0', '--port', '8000', '--stateless'],
    mcpPath: '/',
    envSchema: [
      // OFFICIAL ontap-mcp expects ONTAP_URL and auth credentials.
      // Everything secret is projected from runtimeCredentialId via credentialMapping.
      { name: 'ONTAP_URL', description: 'ONTAP cluster management URL (e.g. https://cluster.example.com)', required: true, secret: false },
      { name: 'ONTAP_INSECURE', description: 'Skip TLS verification for ONTAP API calls (true/false)', required: false, secret: false, defaultValue: 'false' },
      // Backward-compatible alias used by existing internal integrations and egress-port derivation.
      { name: 'ONTAP_CLUSTER_URL', description: 'Compatibility alias for ONTAP URL (optional when ONTAP_URL is set)', required: false, secret: false },
    ],
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    healthProbe: 'tcp',
    runAsNonRoot: false,
    runAsUser: 0,
    runAsGroup: 0,
    /*
     * Tool surface is provided by official upstream ONTAP MCP.
     * Keep defaults read-only and expand per-server as needed.
     */
    defaultAllowedTools: [
      'list_ontap_endpoints',
      'search_ontap_endpoints',
      'describe_ontap_endpoint',
      'ontap_get',
      'list_registered_clusters',
    ],
    credentialMapping: {
      expectedProvider: 'ontap',
      envFromKeys: {
        username: 'ONTAP_USERNAME',
        password: 'ONTAP_PASSWORD',
      },
      fileFromKeys: {
        client_cert_pem: { mountPath: '/etc/ontap/client.crt', envForPath: 'ONTAP_CLIENT_CERT_PATH', mode: 0o400 },
        client_key_pem:  { mountPath: '/etc/ontap/client.key', envForPath: 'ONTAP_CLIENT_KEY_PATH',  mode: 0o400 },
        ca_bundle_pem:   { mountPath: '/etc/ontap/ca.pem',     envForPath: 'ONTAP_CA_BUNDLE_PATH',   mode: 0o444 },
      },
    },
    promptFragment: [
      'You are connected to the official NetApp ONTAP MCP server.',
      'Default allowlist is read-only; write/destructive tools must be explicitly enabled per server policy.',
      'Use list_ontap_endpoints / search_ontap_endpoints / describe_ontap_endpoint to discover the API surface before actions.',
      'Use ontap_get for endpoint-level read workflows when dedicated tools are unavailable.',
      'Confirm destructive operations before execution and prefer snapshot-based safeguards.',
      'Write tools are gated by the per-server allowedTools list; if a write tool fails with "tool not found", ask the operator to enable it.',
    ].join('\n'),
  },
  {
    id: 'prometheus_mcp',
    name: 'Prometheus',
    description: 'Query and explore Prometheus metrics via PromQL. Supports instant queries, range queries, metric discovery, and target inspection.',
    category: 'monitoring',
    image: 'nemo/mcp-server-prometheus',
    defaultTag: 'latest',
    envSchema: [
      { name: 'PROMETHEUS_URL', description: 'Prometheus server URL (auto-populated with platform default)', required: false, secret: false },
    ],
    defaultEnvFn: () => ({
      PROMETHEUS_URL: process.env.PROMETHEUS_MCP_DEFAULT_URL || 'http://prometheus-prometheus.monitoring:9090',
    }),
    egressPorts: [9090],
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    healthProbe: 'tcp',
    imagePullPolicy: 'Always',
    promptFragment: [
      'You have access to a Prometheus metrics server for this platform.',
      'Available tools: execute_query (instant PromQL), execute_range_query (time-range PromQL), list_metrics, get_metric_metadata, get_targets.',
      'Always call list_metrics first to discover what metrics exist before writing PromQL queries.',
      'Use get_metric_metadata to understand a metric type (counter, gauge, histogram) before querying.',
      'For rate/increase on counters, always use rate() or increase() -- never raw counter values.',
      'Keep time ranges reasonable (last 1h-24h) unless the user asks for a wider window.',
      'This instance monitors the platform infrastructure. All AgentStudio services expose metrics here.',
    ].join('\n'),
  },
  {
    id: 'gcnv_mcp',
    name: 'Google Cloud NetApp Volumes',
    description:
      'Manage Google Cloud NetApp Volumes (GCNV) via the public NetApp npm package gcnv-mcp-server, ' +
      'wrapped with supergateway for cluster deployment. Tools use names like gcnv_storage_pool_list.',
    category: 'infrastructure',
    image: 'nemo/mcp-server-gcnv',
    defaultTag: 'latest',
    envSchema: [
      {
        name: 'GOOGLE_CLOUD_PROJECT',
        description:
          'GCP project ID — pass as projectId on tool calls (this value is exposed to the pod for operator/agent context).',
        required: true,
        secret: false,
      },
      {
        name: 'GOOGLE_CLOUD_LOCATION',
        description:
          'Default GCP region or zone (e.g. us-central1) — pass as location on tool calls where applicable.',
        required: true,
        secret: false,
      },
      {
        name: 'GCNV_API_ENDPOINT',
        description: 'Optional custom NetApp Volumes API endpoint (rare; see upstream GCNV_API_ENDPOINT).',
        required: false,
        secret: false,
      },
    ],
    credentialMapping: {
      expectedProvider: 'gcp',
      fileFromKeys: {
        service_account_json: {
          mountPath: '/secrets/gcp/credentials.json',
          envForPath: 'GOOGLE_APPLICATION_CREDENTIALS',
        },
      },
    },
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    egressPorts: [443],
    healthProbe: 'http',
    imagePullPolicy: 'Always',
    defaultAllowedTools: [
      'gcnv_storage_pool_list',
      'gcnv_storage_pool_get',
      'gcnv_storage_pool_create',
      'gcnv_storage_pool_update',
      'gcnv_storage_pool_delete',
      'gcnv_volume_list',
      'gcnv_volume_get',
      'gcnv_volume_create',
      'gcnv_volume_update',
      'gcnv_volume_delete',
      'gcnv_snapshot_list',
      'gcnv_snapshot_get',
      'gcnv_snapshot_create',
      'gcnv_snapshot_update',
      'gcnv_snapshot_delete',
      'gcnv_snapshot_revert',
      'gcnv_backup_vault_list',
      'gcnv_backup_vault_get',
      'gcnv_backup_vault_create',
      'gcnv_backup_vault_update',
      'gcnv_backup_vault_delete',
      'gcnv_backup_list',
      'gcnv_backup_get',
      'gcnv_backup_create',
      'gcnv_backup_update',
      'gcnv_backup_delete',
      'gcnv_backup_restore',
      'gcnv_backup_restore_files',
      'gcnv_replication_list',
      'gcnv_replication_get',
      'gcnv_replication_create',
      'gcnv_replication_update',
      'gcnv_replication_delete',
      'gcnv_replication_stop',
      'gcnv_replication_resume',
      'gcnv_replication_reverse_direction',
      'gcnv_replication_sync',
      'gcnv_replication_establish_peering',
      'gcnv_operation_list',
      'gcnv_operation_get',
      'gcnv_operation_cancel',
    ],
    promptFragment: [
      'You have access to Google Cloud NetApp Volumes (GCNV) via NetApp’s public MCP server (tools are prefixed with gcnv_).',
      'Authenticate with a GCP service account (GOOGLE_APPLICATION_CREDENTIALS). Enable the NetApp Volumes API on the project.',
      'Most tools require projectId and location (region or zone) as arguments — use GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION from this server’s env as defaults unless the user specifies otherwise.',
      'Default tools include read (list/get) and write (create/update/delete, snapshot revert, backup restore, replication control, operation cancel) for storage pools, volumes, snapshots, backups, replications, and operations.',
      'Always read current state (list/get) before mutating, and confirm destructive actions (delete_*, revert) with the user before executing.',
      'Upstream package is preview software; verify behavior against current Google Cloud NetApp Volumes docs.',
    ].join('\n'),
  },
  {
    id: 'anf_mcp',
    name: 'Azure NetApp Files',
    description:
      'Discover and resize Azure NetApp Files (ANF) capacity pools and volumes via Azure Resource Manager. ' +
      'In-tree Python MCP server (not npm).',
    category: 'infrastructure',
    image: 'nemo/mcp-server-anf',
    defaultTag: 'latest',
    envSchema: [
      {
        name: 'AZURE_SUBSCRIPTION_ID',
        description: 'Azure subscription containing ANF resources',
        required: true,
        secret: false,
      },
      {
        name: 'AZURE_DEFAULT_REGION',
        description: 'Azure region where ANF volumes run (e.g. eastus)',
        required: true,
        secret: false,
      },
      {
        name: 'AZURE_RESOURCE_GROUP',
        description: 'Optional resource group filter for list operations',
        required: false,
        secret: false,
      },
      {
        name: 'LOG_LEVEL',
        description: 'Python log level (WARNING recommended for MCP pods)',
        required: false,
        secret: false,
        defaultValue: 'WARNING',
      },
    ],
    credentialMapping: {
      expectedProvider: 'azure_cloud',
      envFromKeys: {
        tenant_id: 'AZURE_TENANT_ID',
        client_id: 'AZURE_CLIENT_ID',
        client_secret: 'AZURE_CLIENT_SECRET',
      },
    },
    securityProfile: 'network-access',
    resourcePreset: 'medium',
    requiresRBAC: false,
    egressPorts: [443],
    healthProbe: 'http',
    defaultAllowedTools: [
      'anf_capacity_pool_list',
      'anf_capacity_pool_get',
      'anf_volume_list',
      'anf_volume_get',
      'anf_resize_capacity_pool',
      'anf_resize_volume',
    ],
    promptFragment: [
      'You have access to Azure NetApp Files (ANF) via MCP tools prefixed with anf_.',
      'Authenticate with an azure_cloud service principal (tenant/client/secret).',
      'Default tools: read (list/get) capacity pools and volumes, plus write resize (anf_resize_capacity_pool, anf_resize_volume). Always list or get current state before resizing.',
      'Resize changes billing — it follows provisioned pool size; confirm before increasing capacity.',
      'Pool size minimum is 1 TiB. Volume usageThreshold limits and shrink rules are enforced by Azure ARM.',
      'See Azure NetApp Files documentation for service levels, quotas, and ARM RBAC (capacityPools/write, volumes/write).',
    ].join('\n'),
  },
  {
    id: 'gcnv_logs_mcp',
    name: 'Google Cloud NetApp Volumes Logs',
    description:
      'Read-only access to Google Cloud NetApp Volumes (GCNV) logs, errors, and events via ' +
      'Google Cloud Logging (scoped to netapp.googleapis.com). Self-contained server; tools are ' +
      'prefixed with gcnv_ (gcnv_logs_list, gcnv_errors_list, gcnv_events_list, gcnv_log_summary).',
    category: 'monitoring',
    image: 'nemo/mcp-server-gcnv-logs',
    defaultTag: 'latest',
    envSchema: [
      {
        name: 'GOOGLE_CLOUD_PROJECT',
        description:
          'GCP project ID whose GCNV logs will be read — pass as projectId on tool calls (also exposed for operator/agent context).',
        required: true,
        secret: false,
      },
      {
        name: 'GOOGLE_CLOUD_LOCATION',
        description: 'Optional default GCP region or zone (e.g. us-central1) for scoping tool calls.',
        required: false,
        secret: false,
      },
    ],
    credentialMapping: {
      expectedProvider: 'gcp',
      fileFromKeys: {
        service_account_json: {
          mountPath: '/secrets/gcp/credentials.json',
          envForPath: 'GOOGLE_APPLICATION_CREDENTIALS',
        },
      },
    },
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    egressPorts: [443],
    healthProbe: 'http',
    imagePullPolicy: 'Always',
    defaultAllowedTools: [
      'gcnv_logs_list',
      'gcnv_errors_list',
      'gcnv_events_list',
      'gcnv_log_summary',
    ],
    promptFragment: [
      'You have read-only access to Google Cloud NetApp Volumes (GCNV) logs, errors, and events via Cloud Logging (tools are prefixed with gcnv_).',
      'Authenticate with a GCP service account (GOOGLE_APPLICATION_CREDENTIALS) that has roles/logging.viewer. All tools require projectId — use GOOGLE_CLOUD_PROJECT as the default unless the user specifies otherwise.',
      'Available tools:',
      '- gcnv_logs_list: general log entries; filter by resourceType/resourceName/severity and time range (plus an optional validated raw freeTextFilter).',
      '- gcnv_errors_list: failures and issues (severity>=ERROR or non-zero operation status) — use this first when triaging problems.',
      '- gcnv_events_list: lifecycle/admin-activity events (create/update/delete/replication/backup/snapshot) for change tracking.',
      '- gcnv_log_summary: aggregated counts by severity/method/resource over a window — use for historical patterns and optimization analysis.',
      'These tools default to the last 24h unless you pass startTime/endTime (RFC3339). Admin Activity audit logs are always available; Data Access (read-type) events require Data Access audit logs to be enabled on the project.',
      'These are read-only; for resource changes use the separate Google Cloud NetApp Volumes (gcnv_mcp) control-plane server.',
    ].join('\n'),
  },
  {
    id: 'anf_logs_mcp',
    name: 'Azure NetApp Files Logs',
    description:
      'Read-only access to Azure NetApp Files (ANF) logs, errors, and events via the Azure Monitor ' +
      'Activity Log (scoped to the Microsoft.NetApp resource provider). Self-contained server; ' +
      'tools are prefixed with anf_ (anf_logs_list, anf_errors_list, anf_events_list, anf_log_summary).',
    category: 'monitoring',
    image: 'nemo/mcp-server-anf-logs',
    defaultTag: 'latest',
    envSchema: [
      {
        name: 'AZURE_SUBSCRIPTION_ID',
        description:
          'Azure subscription id whose ANF Activity Log will be read — used as the default subscriptionId on tool calls.',
        required: true,
        secret: false,
      },
      {
        name: 'AZURE_DEFAULT_REGION',
        description: 'Optional default Azure region (e.g. eastus) for operator/agent context.',
        required: false,
        secret: false,
      },
      {
        name: 'AZURE_RESOURCE_GROUP',
        description: 'Optional default resource group to scope tool calls.',
        required: false,
        secret: false,
      },
    ],
    credentialMapping: {
      expectedProvider: 'azure_cloud',
      envFromKeys: {
        tenant_id: 'AZURE_TENANT_ID',
        client_id: 'AZURE_CLIENT_ID',
        client_secret: 'AZURE_CLIENT_SECRET',
      },
    },
    securityProfile: 'network-access',
    resourcePreset: 'small',
    requiresRBAC: false,
    egressPorts: [443],
    healthProbe: 'http',
    imagePullPolicy: 'Always',
    defaultAllowedTools: [
      'anf_logs_list',
      'anf_errors_list',
      'anf_events_list',
      'anf_log_summary',
    ],
    promptFragment: [
      'You have read-only access to Azure NetApp Files (ANF) logs, errors, and events via the Azure Monitor Activity Log (tools are prefixed with anf_).',
      'Authenticate with an Azure service principal (AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET) that has Reader (or Monitoring Reader) on the subscription/scope. Most tools accept subscriptionId — use AZURE_SUBSCRIPTION_ID as the default unless the user specifies otherwise.',
      'Available tools:',
      '- anf_logs_list: general Activity Log entries; filter by resourceGroup/resourceUri/resourceType/level and time range, optionally by category.',
      '- anf_errors_list: failures and issues (level>=Error or status=Failed) — use this first when triaging problems.',
      '- anf_events_list: lifecycle/admin-activity events (create/update/delete/action) for change tracking; create and update both map to the Azure "write" verb.',
      '- anf_log_summary: aggregated counts by level/operation/resource/category over a window — use for historical patterns and optimization analysis.',
      'These tools default to the last 24h unless you pass startTime/endTime (RFC3339). The Activity Log is control-plane only and retains ~90 days; for ANF diagnostic/file-access logs, route ANFFileAccess to a Log Analytics workspace (not covered here).',
    ].join('\n'),
  },
  {
    id: ANALYTICS_DATASETS_CATALOG_ID,
    name: 'Analytics Datasets',
    description: 'SQL analytics on project datasets via the shared analytics-engine (Iceberg catalog). Supports JOINs, aggregations, and multi-table queries with per-project tenant isolation.',
    category: 'database',
    image: 'nemo/mcp-server-analytics',
    defaultTag: 'latest',
    envSchema: [
      { name: 'ANALYTICS_ENGINE_URL', description: 'Analytics engine base URL', required: false, secret: false },
      { name: 'MAX_ROWS', description: 'Maximum rows returned per query', required: false, secret: false },
    ],
    defaultEnvFn: () => ({
      ANALYTICS_ENGINE_URL: process.env.ANALYTICS_ENGINE_URL || 'http://analytics-engine:5000',
      MAX_ROWS: '500',
    }),
    securityProfile: 'strict',
    resourcePreset: 'small',
    requiresRBAC: false,
    healthProbe: 'tcp',
    promptFragment: [
      'You have access to SQL analytics tools for querying project datasets.',
      'Tables are in the Iceberg catalog. Use list_datasets() first to discover available tables.',
      'Use describe_table(table) to see column names and types before querying.',
      'Use execute_query(sql) for analytical queries including JOINs across project tables.',
      'Use fully-qualified names: iceberg."<namespace>"."<table>" in your SQL.',
      '',
      'IMPORTANT:',
      '- Results are capped at 500 rows. Always use LIMIT for exploration.',
      '- When results show truncated=true, the full result set is larger than shown.',
      '- Only SELECT queries are allowed. DDL/DML will be rejected.',
      '- All table references must be in your project namespace.',
      '',
      'For aggregations, use clear column aliases (e.g. SELECT category AS label, COUNT(*) AS count)',
      'so the chart renderer can auto-detect axes.',
      '',
      'NOTE: Datasets may contain personally identifiable information (PII).',
      'Handle PII responsibly — summarize rather than reproduce raw PII values.',
    ].join('\n'),
  },
];

export function getCatalogEntry(catalogId: string): MCPServerCatalogEntry | undefined {
  return MCP_SERVER_CATALOG.find((entry) => entry.id === catalogId);
}

export function getCatalogEntryIds(): string[] {
  return MCP_SERVER_CATALOG.map((entry) => entry.id);
}

import type {
  ConnectorCreateInput,
  ConnectorScope,
  ConnectorType,
  DataSourceDetail,
  DataSourceProtocol,
  ScanDepth,
} from "@/api/data-source.types";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";

// -- Constants --

export const DEFAULT_LABEL_ITEMS = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "production", value: "production", label: "Production" },
  { key: "development", value: "development", label: "Development" },
  { key: "backup", value: "backup", label: "Backup" },
  { key: "nfs", value: "nfs", label: "NFS" },
  { key: "smb", value: "smb", label: "SMB" },
  { key: "s3", value: "s3", label: "S3" },
];

export const SOURCE_TYPE_OPTIONS = [
  { value: "NFS", title: "NFS share", description: "Network File System mount", isDisabled: false },
  { value: "SMB", title: "SMB share", description: "Windows file share", isDisabled: true },
  { value: "S3", title: "S3 compatible bucket", description: "Object storage service", isDisabled: true },
] as const;

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  NFS: "NFS share",
  SMB: "SMB share",
  S3: "S3 compatible bucket",
};

// -- Connector mapping (dialog subtype → backend provider / scope / type) --
//
// Drives the connector_config the backend validates against provider-catalog.json.
// S3Compatible / CustomObjectStore+S3 use the `s3_compatible` catalog entry for
// required-field markers only; runtime provider remains `s3`.
// CustomObjectStore / CustomDatabase are intentionally absent: their provider is
// chosen from a dropdown at runtime (S3↔GCS, PostgreSQL↔MySQL), so the dialog
// resolves those dynamically while reusing the category's scope + connector_type.

export const CONNECTOR_PROVIDER_MAP: Record<
  string,
  { provider: string; scope: ConnectorScope; connectorType: ConnectorType }
> = {
  GoogleCloud: { provider: "gcp", scope: "account", connectorType: "cloud" },
  MicrosoftAzure: { provider: "azure_cloud", scope: "account", connectorType: "cloud" },
  NetAppONTAP: { provider: "ontap", scope: "account", connectorType: "storage" },
  // Amazon FSx for NetApp ONTAP reuses the NetApp ONTAP connector: an FSxN file
  // system exposes an ONTAP management endpoint and authenticates with ONTAP
  // (fsxadmin/vsadmin) credentials, so it maps to the same provider/scope/type.
  AmazonFSxN: { provider: "ontap", scope: "account", connectorType: "storage" },
  AmazonS3: { provider: "s3", scope: "resource", connectorType: "objectstore" },
  GoogleCloudStorage: { provider: "gcs", scope: "resource", connectorType: "objectstore" },
  S3Compatible: { provider: "s3", scope: "resource", connectorType: "objectstore" },
  PostgreSQL: { provider: "postgresql", scope: "resource", connectorType: "database" },
  PostgreSQLSSL: { provider: "postgresql", scope: "resource", connectorType: "database" },
  MySQL: { provider: "mysql", scope: "resource", connectorType: "database" },
  Redash: { provider: "redash", scope: "account", connectorType: "api" },
};

// -- Data source categories (tabs) --

export const DATASOURCE_CATEGORY_TABS: TabItem[] = [
  { id: "StorageSystem", label: "Storage system" },
  { id: "ObjectStore", label: "Object store" },
  { id: "Database", label: "Database" },
  { id: "Volume", label: "Volume" },
  { id: "API", label: "API" },
];

export const PROVIDER_CATALOG_STRINGS = {
  LOADING_MESSAGE: "Loading provider configuration…",
  ERROR_MESSAGE:
    "Unable to load provider configuration. Required field markers and Add/Test actions stay disabled until this loads.",
  UNAVAILABLE_MESSAGE:
    "Provider configuration is unavailable. Add/Test actions are disabled.",
  RETRY_LABEL: "Retry",
} as const;

// -- Database source options --

export const DATABASE_SOURCE_OPTIONS = [
  {
    value: "GoogleCloud",
    title: "Google Cloud",
    description: "Connect to a GCP project to discover storage, databases, and metrics.",
  },
  {
    value: "MicrosoftAzure",
    title: "Microsoft Azure",
    description: "Connect to an Azure subscription to discover Azure NetApp Files metrics and services.",
  },
  {
    value: "NetAppONTAP",
    title: "NetApp ONTAP",
    description: "Manage ONTAP storage VMs, volumes, and snapshots using its cluster URL.",
  },
  {
    value: "AmazonFSxN",
    title: "Amazon FSxN",
    description: "Connect an Amazon FSx for NetApp ONTAP file system using its management endpoint and NetApp ONTAP credentials.",
  },
] as const;

// -- TLS certificate verification options (NetApp ONTAP cluster details) --

export const TLS_VERIFICATION_OPTIONS = [
  { key: "Enabled", value: "Enabled", label: "Enabled" },
  { key: "Disabled", value: "Disabled", label: "Disabled" },
];

// -- Instructions content per database subtype (shown under "Add new credentials") --

export const GCP_INSTRUCTIONS = {
  intro: "To connect a Google Cloud account:",
  steps: [
    "Sign in to the Google Cloud Console.",
    "Select or create a project and note its Project ID.",
    "Create a service account with the roles you need (for example, Storage and Monitoring).",
    "Generate a service account key in JSON format and download the file.",
    "In this form, enter the Project ID, choose a default region, and upload or paste the service account key JSON.",
  ],
};

export const ONTAP_INSTRUCTIONS = {
  intro: "To connect a NetApp ONTAP cluster:",
  steps: [
    "Sign in to your NetApp ONTAP management interface.",
    "Note the cluster management URL (HTTPS) you use to access System Manager or the REST API.",
    "Create or identify a user or client certificate with the roles needed for volume and metrics access.",
    "Ensure TLS settings match your security requirements (for example, whether self-signed certs are allowed).",
    "In this form, enter the cluster management URL, choose your TLS verification preference, and provide the ONTAP credentials or mTLS materials.",
  ],
};

export const FSXN_INSTRUCTIONS = {
  intro: "To connect an Amazon FSx for NetApp ONTAP file system:",
  steps: [
    "In the AWS console, open your FSx for NetApp ONTAP file system and note its ONTAP management endpoint (DNS name or IP).",
    "Ensure the fsxadmin user (or a vsadmin user scoped to your SVM) is enabled, and have its password ready — FSxN authenticates with NetApp ONTAP credentials.",
    "FSxN presents a self-signed certificate by default, so decide whether to disable TLS verification or supply a CA bundle in the credential.",
    "In this form, enter the management endpoint as the cluster URL, choose your TLS verification preference, and optionally scope to a default SVM.",
    "Provide or select the NetApp ONTAP (fsxadmin/vsadmin) credentials.",
  ],
};

export const AZURE_INSTRUCTIONS = {
  intro: "To connect a Microsoft Azure subscription:",
  steps: [
    "Sign in to the Azure portal and note the subscription ID containing your Azure NetApp Files resources.",
    "Create or identify a service principal (app registration) with Monitoring Reader access on the subscription.",
    "Generate a client secret for the service principal and note the tenant ID and client (application) ID.",
    "Identify the Azure region where your ANF volumes run (for example, eastus).",
    "In this form, enter the subscription ID and region, then provide or select the Microsoft Azure service principal credentials.",
  ],
};

// -- Object store source options --

export const OBJECT_STORE_SOURCE_OPTIONS = [
  {
    value: "AmazonS3",
    title: "Amazon S3",
    description: "Manage AWS S3 buckets and objects for datasets and workflows.",
  },
  {
    value: "GoogleCloudStorage",
    title: "Google Cloud Storage",
    description: "Manage GCS buckets and objects using a service account.",
  },
  {
    value: "S3Compatible",
    title: "S3-compatible buckets",
    description: "Manage S3-compatible object stores using a custom endpoint URL.",
  },
  {
    value: "CustomObjectStore",
    title: "Custom object store",
    description: "Manage flexible object storage by manually choosing provider, region, and endpoints.",
  },
] as const;

// -- Object store connection provider options (Object Store Connection form) --

export const OBJECT_STORE_PROVIDER_OPTIONS = [
  { key: "S3", value: "S3", label: "S3" },
  { key: "GCS", value: "GCS", label: "GCS" },
];

// -- Default provider per object store subtype --

export const OBJECT_STORE_PROVIDER_DEFAULT: Record<string, string> = {
  AmazonS3: "S3",
  GoogleCloudStorage: "GCS",
  S3Compatible: "S3",
  CustomObjectStore: "S3",
};

export const OBJECT_STORE_INSTRUCTIONS = {
  intro: "To connect an object store:",
  steps: [
    "Sign in to your object store provider's console (for example, AWS).",
    "Create or identify the bucket you want to connect.",
    "Create access credentials with read access to the bucket (for example, an access key ID and secret access key).",
    "Note the endpoint URL and region for your bucket.",
    "In this form, enter the endpoint, bucket, optional prefix, and region, then provide or upload your credentials.",
  ],
};

// -- Database engine options (Database tab) --

export const DATABASE_ENGINE_OPTIONS = [
  {
    value: "PostgreSQL",
    title: "PostgreSQL",
    description: "Manage PostgreSQL databases using host, port, database, schema, and credentials.",
  },
  {
    value: "PostgreSQLSSL",
    title: "PostgreSQL (SSL)",
    description: "Manage TLS-enforced PostgreSQL databases using secure endpoint, database, schema, and credentials.",
  },
  {
    value: "MySQL",
    title: "MySQL",
    description: "Manage MySQL databases using host, port, database name, and credentials.",
  },
  {
    value: "CustomDatabase",
    title: "Custom database",
    description: "Manage PostgreSQL or MySQL using custom engine, connection parameters, and credentials.",
  },
] as const;

// -- Database type options (Database Connection form) --

export const DATABASE_TYPE_OPTIONS = [
  { key: "PostgreSQL", value: "PostgreSQL", label: "PostgreSQL" },
  { key: "MySQL", value: "MySQL", label: "MySQL" },
];

// -- Default database type / port / SSL mode per database engine --

export const DATABASE_ENGINE_DEFAULTS: Record<
  string,
  { dbType: string; port: string; sslMode: string }
> = {
  PostgreSQL: { dbType: "PostgreSQL", port: "5432", sslMode: "prefer" },
  PostgreSQLSSL: { dbType: "PostgreSQL", port: "5432", sslMode: "require" },
  MySQL: { dbType: "MySQL", port: "3306", sslMode: "prefer" },
  CustomDatabase: { dbType: "PostgreSQL", port: "5432", sslMode: "prefer" },
};

// -- SSL mode options (Database connection details) --

export const SSL_MODE_OPTIONS = [
  { key: "disable", value: "disable", label: "disable" },
  { key: "allow", value: "allow", label: "allow" },
  { key: "prefer", value: "prefer", label: "prefer" },
  { key: "require", value: "require", label: "require" },
  { key: "verify-ca", value: "verify-ca", label: "verify-ca" },
  { key: "verify-full", value: "verify-full", label: "verify-full" },
];

export const DATABASE_INSTRUCTIONS = {
  intro: "To connect a database:",
  steps: [
    "Identify the database host and port you want to connect to.",
    "Create or identify a database user with read access to the relevant schemas.",
    "Note the database name and schema you want to browse (leave the database empty to browse all databases in the explorer).",
    "Choose the SSL mode that matches your server's security requirements.",
    "In this form, enter the host, port, database, schema, and SSL mode, then provide or upload your credentials.",
  ],
};

// -- Volume source options (Volume tab) --

export const VOLUME_SOURCE_OPTIONS = [
  {
    value: "NFSVolumes",
    title: "NFS volumes",
    description: "Manage POSIX-style shared storage using NFS exports",
  },
  // SMB volumes are temporarily hidden — only NFS volumes are shown for now.
  // {
  //   value: "SMBVolumes",
  //   title: "SMB volumes",
  //   description: "Manage Windows-compatible shared storage using SMB shares",
  // },
] as const;

// -- Credential provider per volume subtype --
// Volume isn't a connector, but its existing-credential picker still loads real
// saved credentials filtered by the provider that matches the chosen subtype.

export const VOLUME_PROVIDER_MAP: Record<string, string> = {
  NFSVolumes: "nfs",
  SMBVolumes: "smb",
};

export const VOLUME_INSTRUCTIONS = {
  intro: "To connect a volume:",
  steps: [
    "Identify the server hosting the NFS export or SMB share.",
    "Confirm the export path or share name you want to connect.",
    "If the share requires authentication, create or identify a user with read access.",
    "Note the server name and, if needed, the username and password for the share.",
    "In this form, enter the server name and optional credentials, then save the connection.",
  ],
};

// -- Volume provisioning (Volume tab) --
//
// The Volume tab lists subtypes (NFS/SMB) in the top SourceTypeTable like the
// other tabs, then offers an "Existing volume" vs "Create new volume" radio
// (mirroring the credential mode radios). These map to volume_info.provisioning_mode.

export const VOLUME_TYPE_OPTIONS = [
  { key: "NFS", value: "NFS", label: "NFS" },
  { key: "SMB", value: "SMB", label: "SMB" },
];

// -- API source options (API tab) --

export const API_SOURCE_OPTIONS = [
  {
    value: "Redash",
    title: "Redash",
    description: "Manage Redash BI metadata using a base URL and API key.",
  },
] as const;

// -- TLS certificate verification options (API details, with default label) --

export const API_TLS_VERIFICATION_OPTIONS = [
  { key: "Enabled", value: "Enabled", label: "Enabled (Default)" },
  { key: "Disabled", value: "Disabled", label: "Disabled" },
];

// -- Yes/No options used by the API "Include ..." selectors --

export const API_INCLUDE_OPTIONS = [
  { key: "Yes", value: "Yes", label: "Yes (Default)" },
  { key: "No", value: "No", label: "No" },
];

export const API_INSTRUCTIONS = {
  intro: "To connect an API:",
  steps: [
    "Sign in to your BI tool (for example, Redash) as an administrator.",
    "Note the base URL you use to access the application.",
    "Create or identify an API key with read access to the metadata you want to browse.",
    "Decide which resources to include (query results, dashboards, data sources) and a result row limit.",
    "In this form, enter the base URL and options, then provide or save your API key.",
  ],
};

export const DESCRIPTION_MAX_LENGTH = 500;

// -- Form shape --

export interface DataSourceFormValues {
  source_type: DataSourceProtocol | "";
  name: string;
  description: string;
  labels: (string | number)[];
  connection: {
    server: string;
    export_path: string;
    folder_boundary: string;
    auth_method: string;
    username: string;
    password: string;
    // Volume-only fields populated by the access-config dialog Volume tab.
    provisioning_mode?: "static" | "dynamic";
    /** User-supplied volume name; surfaced in the summary card (display only). */
    volume_name?: string;
    volume_type?: string;
    region?: string;
    mount_options?: string[];
    storage_class_name?: string;
    storage_size?: string;
    parameters?: Record<string, string>;
    auth_type?: string;
    metadata?: Record<string, string>;
  };
  // Populated by the access-config dialog for connector-backed sources
  // (Storage system, Object store, Database, API). Null for Volume sources.
  connector: ConnectorCreateInput | null;
  scan_enabled: boolean;
  scan_config: {
    scan_depth: ScanDepth;
    custom_depth: number | null;
  };
}

/**
 * Rebuilds the flat ConnectorCreateInput the access-config dialog/summary expect
 * from a fetched data source's backend connector_config. Returns null for volume
 * sources (no connector_config), so the form falls back to the Volume layout.
 *
 * The backend connector_config nests scope/provider/connector_type alongside the
 * provider-specific catalog fields (bucket, endpoint, host, project_id, …); we
 * split those catalog fields back out into `config`.
 */
function buildConnectorFromInitial(initialData: DataSourceDetail): ConnectorCreateInput | null {
  const cfg = initialData.connector_config;
  if (!cfg) return null;

  const { scope, provider, connector_type, ...rest } = cfg;
  return {
    provider: initialData.provider ?? provider ?? "",
    scope: (initialData.connector_scope ?? scope) as ConnectorScope,
    connector_type: (initialData.connector_type ?? connector_type) as ConnectorType,
    config: rest,
    credential_id: initialData.credential_id ?? "",
  };
}

export function buildDefaultValues(initialData?: DataSourceDetail): DataSourceFormValues {
  if (initialData) {
    return {
      source_type: initialData.source_type ?? "",
      name: initialData.name,
      description: initialData.description ?? "",
      labels: initialData.labels,
      connection: {
        server: initialData.connection.server,
        export_path: initialData.connection.export_path ?? "",
        folder_boundary: initialData.connection.folder_boundary ?? "",
        auth_method: initialData.connection.auth_method,
        username: initialData.connection.username,
        password: "",
        // Volume-only fields — let the access-config dialog's Volume tab rehydrate.
        region: initialData.connection.region ?? undefined,
        provisioning_mode: initialData.connection.provisioning_mode ?? undefined,
        volume_type: initialData.connection.volume_type ?? undefined,
        mount_options: initialData.connection.mount_options ?? undefined,
        storage_class_name: initialData.connection.storage_class_name ?? undefined,
        storage_size: initialData.connection.storage_size ?? undefined,
      },
      connector: buildConnectorFromInitial(initialData),
      scan_enabled: initialData.scan?.scan_depth != null && initialData.scan.scan_depth !== "none",
      scan_config: {
        scan_depth: initialData.scan?.scan_depth ?? "none",
        custom_depth: initialData.scan?.custom_depth ?? 1,
      },
    };
  }

  return {
    source_type: "",
    name: "",
    description: "",
    labels: [],
    connection: {
      server: "",
      export_path: "",
      folder_boundary: "",
      auth_method: "none",
      username: "",
      password: "",
    },
    connector: null,
    scan_enabled: false,
    scan_config: {
      scan_depth: "none",
      custom_depth: 1,
    },
  };
}

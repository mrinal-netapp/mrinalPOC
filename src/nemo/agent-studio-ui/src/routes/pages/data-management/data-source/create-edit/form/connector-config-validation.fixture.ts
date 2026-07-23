import type { ProviderCatalogEntry } from "@/api/provider-catalog.types";

/** Minimal catalog fixture aligned with provider-catalog.json connector schemas. */
export const MOCK_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "s3",
    label: "Amazon S3",
    scopes: ["resource"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      resource: {
        required: ["bucket"],
        optional: ["prefix", "region", "endpoint"],
        properties: {
          bucket: { type: "string" },
          prefix: { type: "string" },
          region: { type: "string" },
          endpoint: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "s3_compatible",
    label: "Compatible S3",
    scopes: ["resource"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      resource: {
        required: ["endpoint", "bucket"],
        optional: ["prefix", "region"],
        properties: {
          bucket: { type: "string" },
          prefix: { type: "string" },
          region: { type: "string" },
          endpoint: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "gcs",
    label: "Google Cloud Storage",
    scopes: ["resource"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      resource: {
        required: [],
        optional: ["bucket", "prefix", "project_id"],
        properties: {
          bucket: { type: "string" },
          prefix: { type: "string" },
          project_id: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "postgresql",
    label: "PostgreSQL",
    scopes: ["resource"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      resource: {
        required: ["host", "port"],
        optional: ["database", "schema", "ssl_mode"],
        properties: {
          host: { type: "string" },
          port: { type: "integer" },
          database: { type: "string" },
          schema: { type: "string" },
          ssl_mode: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "mysql",
    label: "MySQL",
    scopes: ["resource"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      resource: {
        required: ["host", "port"],
        optional: ["database", "schema", "ssl_mode"],
        properties: {
          host: { type: "string" },
          port: { type: "integer" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "gcp",
    label: "Google Cloud",
    scopes: ["account"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      account: {
        required: ["project_id"],
        optional: ["default_region"],
        properties: {
          project_id: { type: "string" },
          default_region: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "azure_cloud",
    label: "Microsoft Azure",
    scopes: ["account"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      account: {
        required: ["subscription_id", "default_region"],
        optional: ["resource_group"],
        properties: {
          subscription_id: { type: "string" },
          default_region: { type: "string" },
          resource_group: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "ontap",
    label: "NetApp ONTAP",
    scopes: ["account"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      account: {
        required: ["cluster_url"],
        optional: ["verify_tls", "default_svm"],
        properties: {
          cluster_url: { type: "string" },
          verify_tls: { type: "boolean" },
          default_svm: { type: "string" },
        },
      },
    },
    hasAcquisition: true,
  },
  {
    id: "redash",
    label: "Redash",
    scopes: ["account"],
    supportedActions: [],
    supportedNodeTypes: [],
    connectorConfigSchema: {
      account: {
        required: ["base_url"],
        optional: [],
        properties: {
          base_url: { type: "string" },
        },
      },
    },
    hasAcquisition: false,
  },
];

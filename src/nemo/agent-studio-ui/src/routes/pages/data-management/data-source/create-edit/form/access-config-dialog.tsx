import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useStore } from "react-redux";
import { IconChevronDown, IconChevronUp, IconInfoCircle, IconEye, IconEyeOff, IconPlugConnected, IconX, IconCircleCheck, IconCircleMinus, IconAlertCircle, IconLoader2 } from "@tabler/icons-react";

import {
  buildCredentialCreateBody,
  credentialSecretCacheKey,
  isCredentialSecretComplete,
} from "@/routes/pages/credentials/credential-create.helpers";
import { CredentialSecretFields } from "@/components/credential-secret-fields/credential-secret-fields";
import { useListCredentialsQuery, useCreateCredentialMutation, useRotateCredentialMutation } from "@/routes/pages/credentials/credential-api.slice";
import { useListStorageClassesQuery } from "@/api/data-source-api.slice";
import { startConnectorTest, getWorkflowStatus } from "@/api/workflow-api";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Input } from "@/ui-lib/base-components/input/input";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { TabGroup } from "@/ui-lib/base-components/tab/tab-group";
import {
  Dialog,
  DialogPopup,
} from "@/ui-lib/base-components/dialog/dialog";
import {
  CONNECTOR_PROVIDER_MAP,
  DATASOURCE_CATEGORY_TABS,
  DATABASE_SOURCE_OPTIONS,
  TLS_VERIFICATION_OPTIONS,
  GCP_INSTRUCTIONS,
  ONTAP_INSTRUCTIONS,
  FSXN_INSTRUCTIONS,
  AZURE_INSTRUCTIONS,
  OBJECT_STORE_SOURCE_OPTIONS,
  OBJECT_STORE_INSTRUCTIONS,
  OBJECT_STORE_PROVIDER_OPTIONS,
  OBJECT_STORE_PROVIDER_DEFAULT,
  DATABASE_ENGINE_OPTIONS,
  DATABASE_TYPE_OPTIONS,
  DATABASE_ENGINE_DEFAULTS,
  SSL_MODE_OPTIONS,
  DATABASE_INSTRUCTIONS,
  VOLUME_SOURCE_OPTIONS,
  API_SOURCE_OPTIONS,
  API_TLS_VERIFICATION_OPTIONS,
  API_INCLUDE_OPTIONS,
  API_INSTRUCTIONS,
  PROVIDER_CATALOG_STRINGS,
} from "./data-source-form.consts";
import { useListProviderCatalogQuery } from "@/api/provider-catalog-api.slice";
import type { ConnectorScope } from "@/api/provider-catalog.types";
import {
  compactConfig,
  getRequiredFieldSet,
  resolveObjectStoreCatalogProvider,
  isCatalogLoaded,
  isConnectorCategoryReady,
} from "./connector-config-validation";

// Drops empty/undefined entries so connector_config carries only fields the
// backend provider catalog accepts (empty optionals would be redundant; empty
// required fields are caught earlier by the per-category confirm gating).

function extractValidationConfig(
  connectorConfig: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...connectorConfig };
  delete rest.connector_type;
  delete rest.provider;
  delete rest.scope;
  return rest;
}

function extractApiErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const record = data as { error?: string; message?: string };
      if (record.error) return record.error;
      if (record.message) return record.message;
    }
  }
  if (err instanceof Error) return err.message;
  return "";
}

function isDuplicateCredentialError(err: unknown): boolean {
  const msg = extractApiErrorMessage(err).toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate");
}

type EnsureCredentialResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

// -- Types --

export type ConnectionTestStatus = "idle" | "loading" | "success" | "error";

interface AccessConfigDialogProps {
  form: AnyReactFormApi;
  isEdit: boolean;
  dsrcId?: string;
  open: boolean;
  onClose: () => void;
  onPasswordSet?: (hasPassword: boolean) => void;
  onTestResult?: (status: ConnectionTestStatus) => void;
}

// -- Sub-components --

interface SourceTypeOption {
  value: string;
  title: string;
  description: string;
}

interface SourceTypeTableProps {
  options: readonly SourceTypeOption[];
  ariaLabel: string;
  value: string;
  onChange: (val: string) => void;
}

function SourceTypeTable({ options, ariaLabel, value, onChange }: SourceTypeTableProps): ReactElement {
  // Roving tabindex: only one radio is tab-focusable — the selected one, or the
  // first when nothing is selected — matching the expected radiogroup pattern.
  const selectedIndex = options.findIndex((o) => o.value === value);
  return (
    <div className="ds-form__db-table" role="radiogroup" aria-label={ariaLabel}>
      <div className="ds-form__db-table-header">
        <div className="ds-form__db-table-cell ds-form__db-table-cell--name-head">
          <Typography Component="span" fontSize="fs14" boldness="semibold">
            Name
          </Typography>
        </div>
        <div className="ds-form__db-table-cell ds-form__db-table-cell--desc">
          <Typography Component="span" fontSize="fs14" boldness="semibold">
            Description
          </Typography>
        </div>
      </div>
      {options.map((opt, index) => {
        const isSelected = value === opt.value;
        const isTabbable = selectedIndex === -1 ? index === 0 : isSelected;
        return (
          <div
            key={opt.value}
            className={`ds-form__db-table-row${isSelected ? " ds-form__db-table-row--selected" : ""}`}
            onClick={() => onChange(opt.value)}
            role="radio"
            aria-checked={isSelected}
            tabIndex={isTabbable ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onChange(opt.value);
              }
            }}
          >
            <div
              className="ds-form__db-table-cell ds-form__db-table-cell--check"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onChange(opt.value)}
                ariaLabel={opt.title}
                className="ds-form__db-check"
              />
            </div>
            <div className="ds-form__db-table-cell ds-form__db-table-cell--name">
              <Typography Component="span" fontSize="fs14" boldness="regular">
                {opt.title}
              </Typography>
            </div>
            <div className="ds-form__db-table-cell ds-form__db-table-cell--desc">
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                {opt.description}
              </Typography>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface CredentialInstructionsProps {
  expanded: boolean;
  onToggle: () => void;
  intro: string;
  steps: readonly string[];
}

function CredentialInstructions({ expanded, onToggle, intro, steps }: CredentialInstructionsProps): ReactElement {
  return (
    <div className="ds-form__db-instructions">
      <button
        type="button"
        className="ds-form__db-instructions-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <Typography Component="span" fontSize="fs14" boldness="regular" className="ds-form__db-instructions-label">
          Instructions
        </Typography>
        {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
      </button>
      {expanded && (
        <div className="ds-form__db-instructions-body">
          <div className="ds-form__db-instructions-intro">
            <IconInfoCircle size={16} className="ds-form__db-instructions-intro-icon" />
            <Typography Component="span" fontSize="fs14" boldness="regular">
              {intro}
            </Typography>
          </div>
          <ol className="ds-form__db-instructions-list">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// -- Section header (Project details / Cluster details) --

interface DbSectionHeaderProps {
  title: string;
  subtitle: string;
}

function DbSectionHeader({ title, subtitle }: DbSectionHeaderProps): ReactElement {
  return (
    <div className="ds-form__db-section-header">
      <Typography Component="span" fontSize="fs14" boldness="semibold" className="ds-form__db-section-title">
        {title}
      </Typography>
      <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="ds-form__db-section-subtitle">
        {subtitle}
      </Typography>
    </div>
  );
}

// -- Field label with an optional required (*) indicator --

interface FieldLabelProps {
  htmlFor?: string;
  required?: boolean;
  children: string;
}

function FieldLabel({ htmlFor, required = false, children }: FieldLabelProps): ReactElement {
  return (
    <div className="ds-form__req-label">
      <Typography Component="label" htmlFor={htmlFor} fontSize="fs14" boldness="regular">
        {children}
      </Typography>
      {required && (
        <span className="ds-form__req-asterisk" aria-hidden="true">*</span>
      )}
    </div>
  );
}

// -- Google Cloud: project details --

interface GcpProjectDetailsProps {
  projectId: string;
  onProjectIdChange: (val: string) => void;
  region: string;
  onRegionChange: (val: string) => void;
  requiredFields: Set<string>;
}

function GcpProjectDetails({ projectId, onProjectIdChange, region, onRegionChange, requiredFields }: GcpProjectDetailsProps): ReactElement {
  return (
    <div className="ds-form__db-project-section">
      <DbSectionHeader title="Project details" subtitle="Configure your Google Cloud project details." />
      <div className="ds-form__db-fields">
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-gcp-project-id" required={requiredFields.has("project_id")}>Project ID</FieldLabel>
          <Input
            id="ds-gcp-project-id"
            placeholder="Enter your project ID"
            value={projectId}
            onChange={(e) => onProjectIdChange(e.target.value)}
          />
        </div>
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-gcp-region" required={requiredFields.has("default_region")}>Region</FieldLabel>
          <Input
            id="ds-gcp-region"
            placeholder='For example "us-east-1"'
            value={region}
            onChange={(e) => onRegionChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

// -- Microsoft Azure: subscription details --

interface AzureSubscriptionDetailsProps {
  subscriptionId: string;
  onSubscriptionIdChange: (val: string) => void;
  region: string;
  onRegionChange: (val: string) => void;
  resourceGroup: string;
  onResourceGroupChange: (val: string) => void;
  requiredFields: Set<string>;
}

function AzureSubscriptionDetails({
  subscriptionId,
  onSubscriptionIdChange,
  region,
  onRegionChange,
  resourceGroup,
  onResourceGroupChange,
  requiredFields,
}: AzureSubscriptionDetailsProps): ReactElement {
  return (
    <div className="ds-form__db-project-section">
      <DbSectionHeader title="Subscription details" subtitle="Configure your Azure subscription details." />
      <div className="ds-form__db-fields">
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-azure-subscription-id" required={requiredFields.has("subscription_id")}>Subscription ID</FieldLabel>
          <Input
            id="ds-azure-subscription-id"
            placeholder="Enter your Azure subscription ID"
            value={subscriptionId}
            onChange={(e) => onSubscriptionIdChange(e.target.value)}
          />
        </div>
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-azure-region" required={requiredFields.has("default_region")}>Region</FieldLabel>
          <Input
            id="ds-azure-region"
            placeholder='For example "eastus"'
            value={region}
            onChange={(e) => onRegionChange(e.target.value)}
          />
        </div>
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-azure-resource-group" required={requiredFields.has("resource_group")}>Resource group</FieldLabel>
          <Input
            id="ds-azure-resource-group"
            placeholder="Optional filter for metrics queries"
            value={resourceGroup}
            onChange={(e) => onResourceGroupChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

// -- NetApp ONTAP: cluster details --

interface OntapClusterDetailsProps {
  clusterUrl: string;
  onClusterUrlChange: (val: string) => void;
  tlsVerification: string;
  onTlsVerificationChange: (val: string) => void;
  storageVmScope: string;
  onStorageVmScopeChange: (val: string) => void;
  requiredFields: Set<string>;
}

function OntapClusterDetails({
  clusterUrl,
  onClusterUrlChange,
  tlsVerification,
  onTlsVerificationChange,
  storageVmScope,
  onStorageVmScopeChange,
  requiredFields,
}: OntapClusterDetailsProps): ReactElement {
  return (
    <div className="ds-form__db-project-section">
      <DbSectionHeader title="Cluster details" subtitle="Configure your NetApp ONTAP cluster details." />
      <div className="ds-form__db-fields">
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-ontap-cluster-url" required={requiredFields.has("cluster_url")}>NetApp ONTAP cluster URL</FieldLabel>
          <Input
            id="ds-ontap-cluster-url"
            placeholder="https://cluster.example.com"
            value={clusterUrl}
            onChange={(e) => onClusterUrlChange(e.target.value)}
          />
        </div>
        <SelectDropdown
          label="TLS certificate verification"
          placeholder="Select"
          items={TLS_VERIFICATION_OPTIONS}
          value={tlsVerification}
          onValueChange={(val) => onTlsVerificationChange(String(val ?? ""))}
          className="ds-form__db-field"
        />
        <Input
          label="Default storage VM browsing scope"
          isOptional
          placeholder="Set default browsing scope for storage VMs"
          value={storageVmScope}
          onChange={(e) => onStorageVmScopeChange(e.target.value)}
          className="ds-form__db-field"
        />
      </div>
    </div>
  );
}

// -- Object store: object store details --

interface ObjectStoreDetailsProps {
  provider: string;
  onProviderChange: (val: string) => void;
  endpoint: string;
  onEndpointChange: (val: string) => void;
  bucket: string;
  onBucketChange: (val: string) => void;
  prefix: string;
  onPrefixChange: (val: string) => void;
  region: string;
  onRegionChange: (val: string) => void;
  requiredFields: Set<string>;
}

function ObjectStoreDetails({
  provider,
  onProviderChange,
  endpoint,
  onEndpointChange,
  bucket,
  onBucketChange,
  prefix,
  onPrefixChange,
  region,
  onRegionChange,
  requiredFields,
}: ObjectStoreDetailsProps): ReactElement {
  return (
    <div className="ds-form__db-project-section">
      <DbSectionHeader title="Object Store Connection" subtitle="Configure your S3-compatible object store details." />
      <div className="ds-form__db-fields">
        <div className="ds-form__db-field">
          <FieldLabel required>Provider</FieldLabel>
          <SelectDropdown
            placeholder="Select provider"
            items={OBJECT_STORE_PROVIDER_OPTIONS}
            value={provider}
            onValueChange={(val) => onProviderChange(String(val ?? ""))}
          />
        </div>
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-os-endpoint" required={requiredFields.has("endpoint")}>Endpoint</FieldLabel>
          <Input
            id="ds-os-endpoint"
            placeholder="e.g. https://s3.amazonaws.com"
            value={endpoint}
            onChange={(e) => onEndpointChange(e.target.value)}
          />
        </div>
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-os-bucket" required={requiredFields.has("bucket")}>Bucket</FieldLabel>
          <Input
            id="ds-os-bucket"
            placeholder="my-data-bucket"
            value={bucket}
            onChange={(e) => onBucketChange(e.target.value)}
          />
        </div>
        <div className="ds-form__os-row">
          <div className="ds-form__os-grow">
            <FieldLabel htmlFor="ds-os-prefix">Prefix</FieldLabel>
            <Input
              id="ds-os-prefix"
              placeholder="data/incoming/"
              value={prefix}
              onChange={(e) => onPrefixChange(e.target.value)}
            />
          </div>
          <div className="ds-form__os-grow">
            <FieldLabel htmlFor="ds-os-region" required={requiredFields.has("region")}>Region</FieldLabel>
            <Input
              id="ds-os-region"
              placeholder="us-east-1"
              value={region}
              onChange={(e) => onRegionChange(e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Database: database details --

interface DatabaseDetailsProps {
  dbType: string;
  onDbTypeChange: (val: string) => void;
  host: string;
  onHostChange: (val: string) => void;
  port: string;
  onPortChange: (val: string) => void;
  database: string;
  onDatabaseChange: (val: string) => void;
  schema: string;
  onSchemaChange: (val: string) => void;
  sslMode: string;
  onSslModeChange: (val: string) => void;
  requiredFields: Set<string>;
}

function DatabaseDetails({
  dbType,
  onDbTypeChange,
  host,
  onHostChange,
  port,
  onPortChange,
  database,
  onDatabaseChange,
  schema,
  onSchemaChange,
  sslMode,
  onSslModeChange,
  requiredFields,
}: DatabaseDetailsProps): ReactElement {
  return (
    <div className="ds-form__db-project-section">
      <DbSectionHeader title="Database Connection" subtitle="Configure your database connection details." />
      <div className="ds-form__db-fields">
        <div className="ds-form__db-field">
          <FieldLabel required>Database Type</FieldLabel>
          <SelectDropdown
            placeholder="Select database type"
            items={DATABASE_TYPE_OPTIONS}
            value={dbType}
            onValueChange={(val) => onDbTypeChange(String(val ?? ""))}
          />
        </div>
        <div className="ds-form__os-row">
          <div className="ds-form__db-host">
            <FieldLabel htmlFor="ds-db-host" required={requiredFields.has("host")}>Host</FieldLabel>
            <Input
              id="ds-db-host"
              placeholder="e.g. db.example.com"
              value={host}
              onChange={(e) => onHostChange(e.target.value)}
            />
          </div>
          <div className="ds-form__db-port">
            <FieldLabel htmlFor="ds-db-port" required={requiredFields.has("port")}>Port</FieldLabel>
            <Input
              id="ds-db-port"
              placeholder="5432"
              value={port}
              onChange={(e) => onPortChange(e.target.value)}
            />
          </div>
        </div>
        <Input
          label="Database"
          isOptional={!requiredFields.has("database")}
          placeholder="Optional — when set, the explorer is limited to this database"
          value={database}
          onChange={(e) => onDatabaseChange(e.target.value)}
          className="ds-form__db-field"
        />
        <div className="ds-form__os-row">
          <Input
            label="Schema"
            placeholder="public"
            value={schema}
            onChange={(e) => onSchemaChange(e.target.value)}
            className="ds-form__os-grow"
          />
          <div className="ds-form__os-grow">
            <FieldLabel>SSL Mode</FieldLabel>
            <SelectDropdown
              placeholder="Select"
              items={SSL_MODE_OPTIONS}
              value={sslMode}
              onValueChange={(val) => onSslModeChange(String(val ?? ""))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Volume: metadata key/value editor --
//
// Optional free-form key/value tags persisted as the data source metadata.
// Kept deliberately simple to match the form's field styling.

interface MetadataEditorProps {
  pairs: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

function MetadataEditor({ pairs, onChange }: MetadataEditorProps): ReactElement {
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const entries = Object.entries(pairs);

  const addPair = useCallback(() => {
    const key = draftKey.trim();
    if (!key) return;
    onChange({ ...pairs, [key]: draftValue.trim() });
    setDraftKey("");
    setDraftValue("");
  }, [draftKey, draftValue, pairs, onChange]);

  const removePair = useCallback((key: string) => {
    const next = { ...pairs };
    delete next[key];
    onChange(next);
  }, [pairs, onChange]);

  return (
    <div className="ds-form__vol-kv">
      <div className="ds-form__vol-kv-header">
        <Typography Component="label" fontSize="fs14" boldness="regular">Metadata</Typography>
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">Optional</Typography>
      </div>
      <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
        Add key-value pairs as metadata tags.
      </Typography>
      <div className="ds-form__os-row">
        <div className="ds-form__os-grow">
          <Input
            aria-label="Metadata key"
            placeholder="Enter key"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addPair();
              }
            }}
          />
        </div>
        <div className="ds-form__os-grow">
          <Input
            aria-label="Metadata value"
            placeholder="Enter value"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addPair();
              }
            }}
          />
        </div>
        <div className="ds-form__vol-kv-add">
          <Button variant="outline" size="medium" label="Add" onClick={addPair} isDisabled={draftKey.trim() === ""} />
        </div>
      </div>
      {entries.length > 0 && (
        <div className="ds-form__vol-tags">
          {entries.map(([k, v]) => (
            <span key={k} className="ds-form__vol-tag">
              <Typography Component="span" fontSize="fs12" boldness="regular">{v ? `${k}: ${v}` : k}</Typography>
              <button
                type="button"
                className="ds-form__vol-tag-remove"
                onClick={() => removePair(k)}
                aria-label={`Remove ${k}`}
              >
                <IconX size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// -- Volume: configuration section --
//
// Mirrors AuthDetailsSection: a header + a radio-card group (the same
// SelectorWrapper pattern used for "Use existing / Add new credentials") that
// switches between registering an existing volume (static) and provisioning a
// new one (dynamic). The fields beneath change based on the selected option.
// The volume protocol (NFS/SMB) comes from the SourceTypeTable above.

interface VolumeConfigSectionProps {
  mode: "static" | "dynamic";
  onModeChange: (mode: "static" | "dynamic") => void;
  endpoint: string;
  onEndpointChange: (val: string) => void;
  storageClassItems: { key: string; value: string; label: string }[];
  storageClass: string;
  onStorageClassChange: (val: string) => void;
  storageClassEmpty: boolean;
  storageSize: string;
  onStorageSizeChange: (val: string) => void;
  volumeName: string;
  onVolumeNameChange: (val: string) => void;
  region: string;
  onRegionChange: (val: string) => void;
  mountOptions: string;
  onMountOptionsChange: (val: string) => void;
  username: string;
  onUsernameChange: (val: string) => void;
  password: string;
  onPasswordChange: (val: string) => void;
  metadata: Record<string, string>;
  onMetadataChange: (next: Record<string, string>) => void;
}

function VolumeConfigSection({
  mode,
  onModeChange,
  endpoint,
  onEndpointChange,
  storageClassItems,
  storageClass,
  onStorageClassChange,
  storageClassEmpty,
  storageSize,
  onStorageSizeChange,
  volumeName,
  onVolumeNameChange,
  region,
  onRegionChange,
  mountOptions,
  onMountOptionsChange,
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  metadata,
  onMetadataChange,
}: VolumeConfigSectionProps): ReactElement {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="ds-form__db-auth-section">
      <div className="ds-form__db-auth-header">
        <Typography Component="span" fontSize="fs14" boldness="semibold" className="ds-form__db-auth-title">
          Volume configuration
        </Typography>
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="ds-form__db-auth-subtitle">
          Register an existing volume or create a new one.
        </Typography>
      </div>

      <RadioGroup
        value={mode}
        onValueChange={(val) => onModeChange(val as "static" | "dynamic")}
        ariaLabel="Volume option"
        className="ds-form__auth-mode-radios"
      >
        <SelectorWrapper
          selectorType="radioButton"
          selectorProps={{ value: "static" }}
          label="Existing volume"
          labelBoldness="semibold"
          description="Register an existing NFS volume by its endpoint."
        />
        <SelectorWrapper
          selectorType="radioButton"
          selectorProps={{ value: "dynamic" }}
          label="Create new volume"
          labelBoldness="semibold"
          description="Provision a new volume dynamically from a storage class."
        />
      </RadioGroup>

      <div className="ds-form__db-auth-content">
        <div className="ds-form__db-fields">
          {mode === "static" ? (
            <div className="ds-form__db-field">
              <FieldLabel htmlFor="ds-vol-endpoint" required>Volume endpoint</FieldLabel>
              <Input
                id="ds-vol-endpoint"
                placeholder="nfs-server:/export or //smb-server/share"
                value={endpoint}
                onChange={(e) => onEndpointChange(e.target.value)}
              />
            </div>
          ) : (
            <div className="ds-form__os-row">
              <div className="ds-form__os-grow">
                <FieldLabel required>Storage class</FieldLabel>
                <SelectDropdown
                  size="fill"
                  placeholder="Select storage class"
                  items={storageClassItems}
                  value={storageClass}
                  onValueChange={(val) => onStorageClassChange(String(val ?? ""))}
                />
                {storageClassEmpty && (
                  <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                    No storage classes found
                  </Typography>
                )}
              </div>
              <div className="ds-form__os-grow">
                <FieldLabel htmlFor="ds-vol-size" required>Storage size</FieldLabel>
                <Input
                  id="ds-vol-size"
                  placeholder="e.g. 10Gi, 100Gi, 1Ti"
                  value={storageSize}
                  onChange={(e) => onStorageSizeChange(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="ds-form__os-row">
            <div className="ds-form__os-grow">
              <FieldLabel htmlFor="ds-vol-name" required>Volume name</FieldLabel>
              <Input
                id="ds-vol-name"
                placeholder="Enter a volume name"
                value={volumeName}
                onChange={(e) => onVolumeNameChange(e.target.value)}
              />
            </div>
            <div className="ds-form__os-grow">
              <FieldLabel htmlFor="ds-vol-region" required>Region</FieldLabel>
              <Input
                id="ds-vol-region"
                placeholder="e.g. us-east-1"
                value={region}
                onChange={(e) => onRegionChange(e.target.value)}
              />
            </div>
          </div>

          <Input
            label="Mount options"
            isOptional
            placeholder="Comma-separated, e.g. noac, rsize, wsize"
            value={mountOptions}
            onChange={(e) => onMountOptionsChange(e.target.value)}
            className="ds-form__db-field"
          />
          <Input
            label="Username"
            isOptional
            placeholder="Enter username"
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            className="ds-form__db-field"
          />
          <div className="ds-form__db-field ds-form__db-password-wrap">
            <Input
              label="Password"
              isOptional
              type={showPassword ? "text" : "password"}
              placeholder="Enter password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
            />
            <button
              type="button"
              className="ds-form__db-password-toggle"
              onClick={() => setShowPassword((p) => !p)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <IconEyeOff size={18} /> : <IconEye size={18} />}
            </button>
          </div>

          <MetadataEditor pairs={metadata} onChange={onMetadataChange} />
        </div>
      </div>
    </div>
  );
}

// -- API: API details --

interface ApiDetailsProps {
  baseUrl: string;
  onBaseUrlChange: (val: string) => void;
  tlsVerification: string;
  onTlsVerificationChange: (val: string) => void;
  includeQueryResults: string;
  onIncludeQueryResultsChange: (val: string) => void;
  includeDashboards: string;
  onIncludeDashboardsChange: (val: string) => void;
  includeDataSources: string;
  onIncludeDataSourcesChange: (val: string) => void;
  resultRowLimit: string;
  onResultRowLimitChange: (val: string) => void;
  requiredFields: Set<string>;
}

function ApiDetails({
  baseUrl,
  onBaseUrlChange,
  tlsVerification,
  onTlsVerificationChange,
  includeQueryResults,
  onIncludeQueryResultsChange,
  includeDashboards,
  onIncludeDashboardsChange,
  includeDataSources,
  onIncludeDataSourcesChange,
  resultRowLimit,
  onResultRowLimitChange,
  requiredFields,
}: ApiDetailsProps): ReactElement {
  return (
    <div className="ds-form__db-project-section">
      <DbSectionHeader title="API details" subtitle="Configure your API connection details." />
      <div className="ds-form__db-fields">
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-api-base-url" required={requiredFields.has("base_url")}>Base URL</FieldLabel>
          <Input
            id="ds-api-base-url"
            placeholder="https://redash.example.com"
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
          />
        </div>
        <SelectDropdown
          label="TLS certificate verification"
          placeholder="Select"
          items={API_TLS_VERIFICATION_OPTIONS}
          value={tlsVerification}
          onValueChange={(val) => onTlsVerificationChange(String(val ?? ""))}
          className="ds-form__db-field"
        />
        <SelectDropdown
          label="Include query results"
          placeholder="Select"
          items={API_INCLUDE_OPTIONS}
          value={includeQueryResults}
          onValueChange={(val) => onIncludeQueryResultsChange(String(val ?? ""))}
          className="ds-form__db-field"
        />
        <SelectDropdown
          label="Include dashboards"
          placeholder="Select"
          items={API_INCLUDE_OPTIONS}
          value={includeDashboards}
          onValueChange={(val) => onIncludeDashboardsChange(String(val ?? ""))}
          className="ds-form__db-field"
        />
        <SelectDropdown
          label="Include data sources"
          placeholder="Select"
          items={API_INCLUDE_OPTIONS}
          value={includeDataSources}
          onValueChange={(val) => onIncludeDataSourcesChange(String(val ?? ""))}
          className="ds-form__db-field"
        />
        <Input
          label="Result row limit"
          type="number"
          placeholder="1000"
          value={resultRowLimit}
          onChange={(e) => onResultRowLimitChange(e.target.value)}
          className="ds-form__db-field"
        />
      </div>
    </div>
  );
}

// -- Shared auth content: existing credential picker --

interface ExistingCredentialsProps {
  credentialItems: { key: string; value: string; label: string }[];
  credential: string;
  onCredentialChange: (val: string) => void;
  credentialRequired?: boolean;
  children: ReactElement;
}

function ExistingCredentials({
  credentialItems,
  credential,
  onCredentialChange,
  credentialRequired = true,
  children,
}: ExistingCredentialsProps): ReactElement {
  return (
    <div className="ds-form__db-auth-content">
      <div className="ds-form__db-field">
        <FieldLabel required={credentialRequired}>Credential</FieldLabel>
        <SelectDropdown
          placeholder="Select credential"
          items={credentialItems}
          value={credential}
          onValueChange={(val) => onCredentialChange(String(val ?? ""))}
        />
      </div>
      {children}
    </div>
  );
}

// -- Shared auth content: new credential (name + key + upload + instructions) --

interface NewCredentialsProps {
  credentialName: string;
  onCredentialNameChange: (val: string) => void;
  /** Provider key — renders the same secret fields as the Credentials tab. */
  provider?: string;
  secretData: Record<string, string>;
  onSecretDataChange: (data: Record<string, string>) => void;
  /** Comma-separated labels applied to the new credential (optional). */
  labels?: string;
  onLabelsChange?: (val: string) => void;
  instructionsIntro: string;
  instructionsSteps: readonly string[];
  instructionsExpanded: boolean;
  onToggleInstructions: () => void;
  credentialRequired?: boolean;
  children: ReactElement;
}

function NewCredentials({
  credentialName,
  onCredentialNameChange,
  provider,
  secretData,
  onSecretDataChange,
  labels,
  onLabelsChange,
  instructionsIntro,
  instructionsSteps,
  instructionsExpanded,
  onToggleInstructions,
  credentialRequired = true,
  children,
}: NewCredentialsProps): ReactElement {
  return (
    <div className="ds-form__db-auth-content">
      <div className="ds-form__db-field">
        <FieldLabel htmlFor="ds-credential-name" required={credentialRequired}>Credential name</FieldLabel>
        <Input
          id="ds-credential-name"
          placeholder="Enter a credential name to identify it when reusing"
          value={credentialName}
          onChange={(e) => onCredentialNameChange(e.target.value)}
        />
      </div>
      {provider ? (
        <CredentialSecretFields
          provider={provider}
          secretData={secretData}
          onChange={onSecretDataChange}
        />
      ) : null}
      {onLabelsChange && (
        <div className="ds-form__db-field">
          <FieldLabel htmlFor="ds-credential-labels">Labels (optional)</FieldLabel>
          <Input
            id="ds-credential-labels"
            placeholder="label1, label2"
            value={labels ?? ""}
            onChange={(e) => onLabelsChange(e.target.value)}
          />
        </div>
      )}
      <CredentialInstructions
        expanded={instructionsExpanded}
        onToggle={onToggleInstructions}
        intro={instructionsIntro}
        steps={instructionsSteps}
      />
      {children}
    </div>
  );
}

// -- Shared "Authentication details" section (header + mode radios + credential fields) --

interface AuthDetailsSectionProps {
  authMode: "existing" | "new";
  onAuthModeChange: (mode: "existing" | "new") => void;
  credentialItems: { key: string; value: string; label: string }[];
  credential: string;
  onCredentialChange: (val: string) => void;
  credentialName: string;
  onCredentialNameChange: (val: string) => void;
  provider?: string;
  secretData: Record<string, string>;
  onSecretDataChange: (data: Record<string, string>) => void;
  /** Comma-separated labels applied to a new credential (optional). */
  newCredentialLabels?: string;
  onNewCredentialLabelsChange?: (val: string) => void;
  instructionsIntro: string;
  instructionsSteps: readonly string[];
  instructionsExpanded: boolean;
  onToggleInstructions: () => void;
  credentialRequired?: boolean;
  detailsSection: ReactElement;
}

function AuthDetailsSection({
  authMode,
  onAuthModeChange,
  credentialItems,
  credential,
  onCredentialChange,
  credentialName,
  onCredentialNameChange,
  provider,
  secretData,
  onSecretDataChange,
  newCredentialLabels,
  onNewCredentialLabelsChange,
  instructionsIntro,
  instructionsSteps,
  instructionsExpanded,
  onToggleInstructions,
  credentialRequired = true,
  detailsSection,
}: AuthDetailsSectionProps): ReactElement {
  return (
    <div className="ds-form__db-auth-section">
      <div className="ds-form__db-auth-header">
        <Typography Component="span" fontSize="fs14" boldness="semibold" className="ds-form__db-auth-title">
          Authentication details
        </Typography>
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="ds-form__db-auth-subtitle">
          Select an existing or add new credentials.
        </Typography>
      </div>

      <RadioGroup
        value={authMode}
        onValueChange={(val) => onAuthModeChange(val as "existing" | "new")}
        ariaLabel="Authentication mode"
        className="ds-form__auth-mode-radios"
      >
        <SelectorWrapper
          selectorType="radioButton"
          selectorProps={{ value: "existing" }}
          label="Use existing credentials"
          labelBoldness="semibold"
          description="Reuse a saved credential for this connection."
        />
        <SelectorWrapper
          selectorType="radioButton"
          selectorProps={{ value: "new" }}
          label="Add new credentials"
          labelBoldness="semibold"
          description="Create and save a new credential for this connection."
        />
      </RadioGroup>

      {authMode === "existing" ? (
        <ExistingCredentials
          credentialItems={credentialItems}
          credential={credential}
          onCredentialChange={onCredentialChange}
          credentialRequired={credentialRequired}
        >
          {detailsSection}
        </ExistingCredentials>
      ) : (
        <NewCredentials
          credentialName={credentialName}
          onCredentialNameChange={onCredentialNameChange}
          provider={provider}
          secretData={secretData}
          onSecretDataChange={onSecretDataChange}
          labels={newCredentialLabels}
          onLabelsChange={onNewCredentialLabelsChange}
          instructionsIntro={instructionsIntro}
          instructionsSteps={instructionsSteps}
          instructionsExpanded={instructionsExpanded}
          onToggleInstructions={onToggleInstructions}
          credentialRequired={credentialRequired}
        >
          {detailsSection}
        </NewCredentials>
      )}
    </div>
  );
}

// -- Shared connection-test control --

// Rendered at the bottom of every connector category. The button stays disabled
// until that category's required fields + credential are provided (same gating
// as Add), then runs an interactive connector-test workflow and surfaces the
// live result inline (untested → testing → success/failure with reason).

const CONNECTOR_CATEGORIES_USING_CATALOG = new Set([
  "StorageSystem",
  "ObjectStore",
  "Database",
  "API",
]);

type ProviderCatalogStatusProps = {
  show: boolean;
  isLoading: boolean;
  isError: boolean;
  isReady: boolean;
  onRetry: () => void;
};

function ProviderCatalogStatus({
  show,
  isLoading,
  isError,
  isReady,
  onRetry,
}: ProviderCatalogStatusProps): ReactElement | null {
  if (!show || isReady) return null;

  if (isLoading) {
    return (
      <div className="ds-form__catalog-status" role="status">
        <IconLoader2 size={16} className="ds-form__catalog-status-spinner" />
        <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__catalog-status-text">
          {PROVIDER_CATALOG_STRINGS.LOADING_MESSAGE}
        </Typography>
      </div>
    );
  }

  const message = isError
    ? PROVIDER_CATALOG_STRINGS.ERROR_MESSAGE
    : PROVIDER_CATALOG_STRINGS.UNAVAILABLE_MESSAGE;

  return (
    <div className="ds-form__catalog-status ds-form__catalog-status--error" role="alert">
      <IconAlertCircle size={16} />
      <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__catalog-status-text">
        {message}
      </Typography>
      {isError && (
        <Button
          variant="outline"
          size="medium"
          label={PROVIDER_CATALOG_STRINGS.RETRY_LABEL}
          onClick={onRetry}
        />
      )}
    </div>
  );
}

function ConnectionTestControl({
  disabled,
  status,
  message,
  onTest,
}: {
  disabled: boolean;
  status: ConnectionTestStatus;
  message: string;
  onTest: () => void;
}): ReactElement {
  return (
    <div className="ds-form__os-test-row">
      <Button
        variant="outline"
        size="medium"
        label="Test Connection"
        icon={<IconPlugConnected size={16} />}
        isDisabled={disabled || status === "loading"}
        onClick={onTest}
      />
      {!disabled && status === "idle" && (
        <span className="ds-form__conn-test ds-form__conn-test--untested">
          <IconCircleMinus size={16} />
          <Typography Component="span" fontSize="fs14" boldness="regular" isNowrap color="var(--text-disabled)">
            Untested
          </Typography>
        </span>
      )}
      {status === "loading" && (
        <span className="ds-form__conn-test ds-form__conn-test--loading">
          <IconLoader2 size={16} className="ds-form__conn-test-spinner" />
          <Typography Component="span" fontSize="fs14" boldness="regular" isNowrap color="var(--color-text-secondary, #6b7280)">
            Testing connection…
          </Typography>
        </span>
      )}
      {status === "success" && (
        <span className="ds-form__conn-test ds-form__conn-test--success">
          <IconCircleCheck size={16} />
          <Typography Component="span" fontSize="fs14" boldness="regular" isNowrap color="var(--color-status-success, #15803d)">
            Connection successful
          </Typography>
        </span>
      )}
      {status === "error" && (
        <span className="ds-form__conn-test ds-form__conn-test--error">
          <IconAlertCircle size={16} />
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--color-status-error, #b91c1c)">
            {message || "Connection failed"}
          </Typography>
        </span>
      )}
    </div>
  );
}

// -- Main dialog --

function AccessConfigDialog({
  form,
  isEdit,
  open,
  onClose,
  onPasswordSet,
  onTestResult,
}: AccessConfigDialogProps): ReactElement {
  // Category tab
  const [activeCategory, setActiveCategory] = useState<string>("StorageSystem");

  // Connection-test state. `signature` pins the result to the exact connector
  // config + credential it was run against, so editing any field after a
  // pass/fail visually clears the stale result (see shownTestStatus below).
  const [connTest, setConnTest] = useState<{ status: ConnectionTestStatus; message: string; signature: string }>(
    { status: "idle", message: "", signature: "" },
  );
  // Inline ("new" mode) credentials are created on the first Test/Add and cached
  // here keyed by provider+name+secret, so repeated actions on the same inputs
  // reuse the saved credential instead of creating duplicates — without leaving
  // the "Add new credentials" view.
  const [createdCredentials, setCreatedCredentials] = useState<Record<string, string>>({});
  // Inline credential secrets — same shape/fields as the Credentials tab (provider presets).
  const [newCredentialSecretData, setNewCredentialSecretData] = useState<Record<string, string>>({});
  // Optional comma-separated labels for a newly created inline credential.
  const [newCredentialLabels, setNewCredentialLabels] = useState("");
  // Monotonic id; bumping it abandons any in-flight poll loop (tab switch / close).
  const testRunRef = useRef(0);

  // Storage system — subtype & auth (Google Cloud / NetApp ONTAP)
  const [localDatabaseSubType, setLocalDatabaseSubType] = useState<string>("GoogleCloud");
  const [authMode, setAuthMode] = useState<"existing" | "new">("existing");

  // Storage system — existing credentials (real credential id; "" until picked)
  const [localCredential, setLocalCredential] = useState("");

  // Storage system — new credentials (name only; secrets in newCredentialSecretData)
  const [localCredentialName, setLocalCredentialName] = useState("");
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  // Storage system — Google Cloud project details (shared between existing/new)
  const [localProjectId, setLocalProjectId] = useState("");
  const [localRegion, setLocalRegion] = useState("");

  // Storage system — Microsoft Azure subscription details (shared between existing/new)
  const [localSubscriptionId, setLocalSubscriptionId] = useState("");
  const [localResourceGroup, setLocalResourceGroup] = useState("");

  // Storage system — NetApp ONTAP cluster details (shared between existing/new)
  const [localClusterUrl, setLocalClusterUrl] = useState("");
  const [localTlsVerification, setLocalTlsVerification] = useState("Enabled");
  const [localStorageVmScope, setLocalStorageVmScope] = useState("");

  // Object store — subtype & auth
  const [osSubType, setOsSubType] = useState<string>("AmazonS3");
  const [osAuthMode, setOsAuthMode] = useState<"existing" | "new">("existing");
  const [osCredential, setOsCredential] = useState("");
  const [osCredentialName, setOsCredentialName] = useState("");
  const [osInstructionsExpanded, setOsInstructionsExpanded] = useState(false);

  // Object store — object store details (shared between existing/new)
  const [osProvider, setOsProvider] = useState(OBJECT_STORE_PROVIDER_DEFAULT.AmazonS3);
  const [osEndpoint, setOsEndpoint] = useState("");
  const [osBucket, setOsBucket] = useState("");
  const [osPrefix, setOsPrefix] = useState("");
  const [osRegion, setOsRegion] = useState("");

  // Database — engine & auth
  const [dbSubType, setDbSubType] = useState<string>("MySQL");
  const [dbAuthMode, setDbAuthMode] = useState<"existing" | "new">("existing");
  const [dbCredential, setDbCredential] = useState("");
  const [dbCredentialName, setDbCredentialName] = useState("");
  const [dbInstructionsExpanded, setDbInstructionsExpanded] = useState(false);

  // Database — database details (shared between existing/new)
  const [dbType, setDbType] = useState(DATABASE_ENGINE_DEFAULTS.MySQL.dbType);
  const [dbHost, setDbHost] = useState("");
  const [dbPort, setDbPort] = useState(DATABASE_ENGINE_DEFAULTS.MySQL.port);
  const [dbDatabase, setDbDatabase] = useState("");
  const [dbSchema, setDbSchema] = useState("public");
  const [dbSslMode, setDbSslMode] = useState(DATABASE_ENGINE_DEFAULTS.MySQL.sslMode);

  // Volume — subtype (NFS/SMB, from the top table) + provisioning mode + fields
  const [volSubType, setVolSubType] = useState<string>("NFSVolumes");
  const [volMode, setVolMode] = useState<"static" | "dynamic">("static");
  const [volEndpoint, setVolEndpoint] = useState("");
  // Dynamic provisioning
  const [volStorageClass, setVolStorageClass] = useState("");
  const [volStorageSize, setVolStorageSize] = useState("");
  // Shared volume details
  const [volName, setVolName] = useState("");
  const [volRegion, setVolRegion] = useState("");
  const [volMountOptions, setVolMountOptions] = useState("");
  // Optional authentication
  const [volUsername, setVolUsername] = useState("");
  const [volPassword, setVolPassword] = useState("");
  // Optional metadata tags
  const [volMetadata, setVolMetadata] = useState<Record<string, string>>({});

  // API — subtype & auth
  const [apiSubType, setApiSubType] = useState<string>("Redash");
  const [apiAuthMode, setApiAuthMode] = useState<"existing" | "new">("existing");
  const [apiCredential, setApiCredential] = useState("");
  const [apiCredentialName, setApiCredentialName] = useState("");
  const [apiInstructionsExpanded, setApiInstructionsExpanded] = useState(false);

  // API — API details (shared between existing/new)
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiTlsVerification, setApiTlsVerification] = useState("Enabled");
  const [apiIncludeQueryResults, setApiIncludeQueryResults] = useState("Yes");
  const [apiIncludeDashboards, setApiIncludeDashboards] = useState("Yes");
  const [apiIncludeDataSources, setApiIncludeDataSources] = useState("Yes");
  const [apiResultRowLimit, setApiResultRowLimit] = useState("1000");

  // Reset all per-category form state whenever the dialog (re)opens. These are
  // intentional synchronous resets keyed off `open`, not derived state.
  useEffect(() => {
    if (!open) return;
    setActiveCategory("StorageSystem");
    setCreatedCredentials({});
    setLocalDatabaseSubType("GoogleCloud");
    setAuthMode("existing");
    setLocalCredential("");
    setLocalCredentialName("");
    setNewCredentialSecretData({});
    setNewCredentialLabels("");
    setLocalProjectId("");
    setLocalRegion("");
    setLocalSubscriptionId("");
    setLocalResourceGroup("");
    setLocalClusterUrl("");
    setLocalTlsVerification("Enabled");
    setLocalStorageVmScope("");
    setInstructionsExpanded(false);
    setOsSubType("AmazonS3");
    setOsAuthMode("existing");
    setOsCredential("");
    setOsCredentialName("");
    setOsInstructionsExpanded(false);
    setOsProvider(OBJECT_STORE_PROVIDER_DEFAULT.AmazonS3);
    setOsEndpoint("");
    setOsBucket("");
    setOsPrefix("");
    setOsRegion("");
    setDbSubType("MySQL");
    setDbAuthMode("existing");
    setDbCredential("");
    setDbCredentialName("");
    setDbInstructionsExpanded(false);
    setDbType(DATABASE_ENGINE_DEFAULTS.MySQL.dbType);
    setDbHost("");
    setDbPort(DATABASE_ENGINE_DEFAULTS.MySQL.port);
    setDbDatabase("");
    setDbSchema("public");
    setDbSslMode(DATABASE_ENGINE_DEFAULTS.MySQL.sslMode);
    setVolSubType("NFSVolumes");
    setVolMode("static");
    setVolEndpoint("");
    setVolStorageClass("");
    setVolStorageSize("");
    setVolName("");
    setVolRegion("");
    setVolMountOptions("");
    setVolUsername("");
    setVolPassword("");
    setVolMetadata({});
    setApiSubType("Redash");
    setApiAuthMode("existing");
    setApiCredential("");
    setApiCredentialName("");
    setApiInstructionsExpanded(false);
    setApiBaseUrl("");
    setApiTlsVerification("Enabled");
    setApiIncludeQueryResults("Yes");
    setApiIncludeDashboards("Yes");
    setApiIncludeDataSources("Yes");
    setApiResultRowLimit("1000");

    // Edit mode: repopulate the dialog from the saved connector so reopening it
    // surfaces the persisted configuration (provider, endpoint/host, credential,
    // …) instead of blank defaults. On save we send connector_config +
    // credential_id, which the update endpoint merges, so edits made here are
    // persisted (not just review-only).
    const savedConnector = form.state.values.connector;
    if (isEdit && savedConnector) {
      const cfg = (savedConnector.config ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
      const credId = savedConnector.credential_id ?? "";
      const ct = savedConnector.connector_type;

      if (ct === "cloud" || ct === "storage") {
        setActiveCategory("StorageSystem");
        setAuthMode("existing");
        setLocalCredential(credId);
        if (ct === "storage" || savedConnector.provider === "ontap") {
          setLocalDatabaseSubType("NetAppONTAP");
          setLocalClusterUrl(str(cfg.cluster_url));
          setLocalTlsVerification(cfg.verify_tls === false ? "Disabled" : "Enabled");
          setLocalStorageVmScope(str(cfg.default_svm));
        } else if (savedConnector.provider === "azure_cloud") {
          setLocalDatabaseSubType("MicrosoftAzure");
          setLocalSubscriptionId(str(cfg.subscription_id));
          setLocalRegion(str(cfg.default_region));
          setLocalResourceGroup(str(cfg.resource_group));
        } else {
          setLocalDatabaseSubType("GoogleCloud");
          setLocalProjectId(str(cfg.project_id));
          setLocalRegion(str(cfg.default_region));
        }
      } else if (ct === "objectstore") {
        setActiveCategory("ObjectStore");
        setOsAuthMode("existing");
        setOsCredential(credId);
        const isGcs = savedConnector.provider === "gcs";
        setOsSubType(isGcs ? "GoogleCloudStorage" : cfg.endpoint ? "S3Compatible" : "AmazonS3");
        setOsProvider(isGcs ? "GCS" : "S3");
        setOsBucket(str(cfg.bucket));
        setOsPrefix(str(cfg.prefix));
        setOsRegion(str(cfg.region));
        setOsEndpoint(str(cfg.endpoint));
      } else if (ct === "database") {
        setActiveCategory("Database");
        setDbAuthMode("existing");
        setDbCredential(credId);
        const isMysql = savedConnector.provider === "mysql";
        const sslMode = str(cfg.ssl_mode);
        const sslEnforced = sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
        setDbSubType(isMysql ? "MySQL" : sslEnforced ? "PostgreSQLSSL" : "PostgreSQL");
        setDbType(isMysql ? "MySQL" : "PostgreSQL");
        setDbHost(str(cfg.host));
        setDbPort(cfg.port != null ? String(cfg.port) : isMysql ? "3306" : "5432");
        setDbDatabase(str(cfg.database));
        setDbSchema(str(cfg.schema) || "public");
        if (sslMode) setDbSslMode(sslMode);
      } else if (ct === "api") {
        setActiveCategory("API");
        setApiAuthMode("existing");
        setApiCredential(credId);
        setApiSubType("Redash");
        setApiBaseUrl(str(cfg.base_url));
        setApiTlsVerification(cfg.verify_tls === false ? "Disabled" : "Enabled");
        setApiIncludeQueryResults(cfg.include_query_results === false ? "No" : "Yes");
        setApiIncludeDashboards(cfg.include_dashboards === false ? "No" : "Yes");
        setApiIncludeDataSources(cfg.include_data_sources === false ? "No" : "Yes");
        if (cfg.max_result_rows != null) setApiResultRowLimit(String(cfg.max_result_rows));
      }
    } else if (isEdit) {
      // Volume sources are not connector-backed (savedConnector is null), so they
      // rehydrate from form.state.values.connection, populated by buildDefaultValues
      // from volume_config. volume_name is display-only and not persisted, so it
      // can't be restored — the user re-enters it before saving.
      const conn = form.state.values.connection;
      setActiveCategory("Volume");
      const volType = (conn.volume_type ?? "NFS").toUpperCase();
      setVolSubType(volType === "SMB" ? "SMBVolumes" : "NFSVolumes");
      const mode = conn.provisioning_mode === "dynamic" ? "dynamic" : "static";
      setVolMode(mode);
      // Reconstruct the "host:/export" endpoint the user originally entered; the
      // mapper splits it back into server + export_path on load.
      const endpoint = conn.export_path ? `${conn.server}:${conn.export_path}` : conn.server;
      setVolEndpoint(mode === "static" ? endpoint : "");
      setVolStorageClass(conn.storage_class_name ?? "");
      setVolStorageSize(conn.storage_size ?? "");
      setVolRegion(conn.region ?? "");
      setVolMountOptions((conn.mount_options ?? []).join(", "));
      setVolUsername(conn.username ?? "");
    }

    testRunRef.current++;
    setConnTest({ status: "idle", message: "", signature: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Switching connector category abandons any in-flight test and clears the
  // previous category's result so the new tab starts from a clean slate.
  useEffect(() => {
    testRunRef.current++;
    setConnTest({ status: "idle", message: "", signature: "" });
  }, [activeCategory]);

  // Changing the subtype (and, for Custom*, the provider dropdown) changes
  // which provider's credentials are listed, so the selected credential is
  // cleared to force a fresh pick from the new provider's saved credentials.

  const handleDatabaseSubTypeChange = useCallback((subType: string) => {
    setLocalDatabaseSubType(subType);
    setLocalCredential("");
  }, []);

  const handleObjectStoreSubTypeChange = useCallback((subType: string) => {
    setOsSubType(subType);
    setOsCredential("");
    setOsProvider(OBJECT_STORE_PROVIDER_DEFAULT[subType] ?? "S3");
  }, []);

  // Custom object store lets the user switch provider (S3 ↔ GCS) directly,
  // which also re-scopes the credential list.
  const handleObjectStoreProviderChange = useCallback((provider: string) => {
    setOsProvider(provider);
    setOsCredential("");
  }, []);

  const handleDatabaseEngineChange = useCallback((subType: string) => {
    setDbSubType(subType);
    setDbCredential("");
    const defaults = DATABASE_ENGINE_DEFAULTS[subType];
    if (defaults) {
      setDbType(defaults.dbType);
      setDbPort(defaults.port);
      setDbSslMode(defaults.sslMode);
    }
  }, []);

  // Custom database lets the user switch the engine (PostgreSQL ↔ MySQL),
  // which also re-scopes the credential list.
  const handleDatabaseTypeChange = useCallback((type: string) => {
    setDbType(type);
    setDbCredential("");
  }, []);

  const handleApiSubTypeChange = useCallback((subType: string) => {
    setApiSubType(subType);
    setApiCredential("");
  }, []);

  // Amazon FSxN is an ONTAP-backed storage system (same connector/provider,
  // creds, and cluster-details form as NetApp ONTAP), so it shares every
  // ONTAP branch below; only the setup instructions differ.
  const isFsxn = localDatabaseSubType === "AmazonFSxN";
  const isOntap = localDatabaseSubType === "NetAppONTAP" || isFsxn;
  const isAzure = localDatabaseSubType === "MicrosoftAzure";

  // Object store / Database "Custom" subtypes pick the concrete provider from a
  // dropdown; the others are fixed. This resolved provider drives both the
  // credential list and the connector_config the backend validates.
  const osResolvedProvider = osProvider === "GCS" ? "gcs" : "s3";
  const dbResolvedProvider = dbType === "MySQL" ? "mysql" : "postgresql";

  // Which provider's saved credentials to load for the active category. Volume
  // sources are not credential-backed, so they don't load a credential list.
  const activeProvider = useMemo<string | undefined>(() => {
    switch (activeCategory) {
      case "StorageSystem":
        if (isOntap) return "ontap";
        if (isAzure) return "azure_cloud";
        return "gcp";
      case "ObjectStore":
        return osResolvedProvider;
      case "Database":
        return dbResolvedProvider;
      case "API":
        return "redash";
      default:
        return undefined;
    }
  }, [activeCategory, isOntap, isAzure, osResolvedProvider, dbResolvedProvider]);

  // Catalog lookup for required-field markers. Object-store S3-compatible
  // subtypes use `s3_compatible`; runtime provider/credentials still use `s3`.
  const activeCatalogProvider = useMemo<string | undefined>(() => {
    switch (activeCategory) {
      case "ObjectStore":
        return resolveObjectStoreCatalogProvider(osSubType, osProvider, osResolvedProvider);
      case "StorageSystem":
      case "Database":
      case "API":
        return activeProvider;
      default:
        return undefined;
    }
  }, [activeCategory, activeProvider, osSubType, osProvider, osResolvedProvider]);

  // Clear inline secrets when the resolved provider changes (same as switching provider on Credentials tab).
  useEffect(() => {
    if (!open) return;
    setNewCredentialSecretData({});
  }, [open, activeProvider]);

  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const reduxStore = useStore();
  const {
    data: providerCatalog,
    isLoading: catalogLoading,
    isError: catalogError,
    refetch: refetchProviderCatalog,
  } = useListProviderCatalogQuery(undefined, { skip: !open });
  const catalogReady = isCatalogLoaded(providerCatalog, catalogLoading, catalogError);
  const [createCredential] = useCreateCredentialMutation();
  const [rotateCredential] = useRotateCredentialMutation();
  const { data: credentials = [] } = useListCredentialsQuery(
    { projectId, provider: activeProvider },
    { skip: !open || !activeProvider || !projectId },
  );

  // Map saved credentials to dropdown items — the value IS the credential id,
  // which becomes connector_config's credential_id on confirm.
  const credentialItems = useMemo(
    () => credentials.map((c) => ({ key: c.id, value: c.id, label: c.name })),
    [credentials],
  );

  // Cluster StorageClasses for dynamically provisioned volumes. Only fetched
  // while the dialog is open and the Volume tab in dynamic mode is active.
  const { data: storageClasses = [] } = useListStorageClassesQuery(
    { projectId },
    // The deployments registry is NOT project-scoped, so we intentionally do
    // not gate on `projectId` here — doing so suppressed the call whenever the
    // active project id was empty, leaving the storage-class dropdown blank.
    { skip: !open || activeCategory !== "Volume" || volMode !== "dynamic" },
  );
  const storageClassItems = useMemo(
    () => storageClasses.map((sc) => ({ key: sc.name, value: sc.name, label: sc.name })),
    [storageClasses],
  );

  // Resolves the credential id to use for the active category's Test/Add action.
  // In "existing" mode it returns the selected id. In "new" mode it persists the
  // inline credential via the create API (connectors can only reference a saved
  // credential id) and caches it by provider+name+secret so repeated actions on
  // the same inputs reuse it — the user stays on the "Add new credentials" view.
  // Returns a structured result — callers show the message on failure.
  const ensureCredentialId = useCallback(async (): Promise<EnsureCredentialResult> => {
    let mode: "existing" | "new" = "existing";
    let existingId = "";
    let name = "";
    switch (activeCategory) {
      case "StorageSystem":
        mode = authMode; existingId = localCredential; name = localCredentialName;
        break;
      case "ObjectStore":
        mode = osAuthMode; existingId = osCredential; name = osCredentialName;
        break;
      case "Database":
        mode = dbAuthMode; existingId = dbCredential; name = dbCredentialName;
        break;
      case "API":
        mode = apiAuthMode; existingId = apiCredential; name = apiCredentialName;
        break;
      default:
        return { ok: false, message: "This data source type does not use credentials." };
    }

    if (mode === "existing") {
      const id = existingId.trim();
      if (!id) {
        return {
          ok: false,
          message:
            "Select a saved credential from the dropdown, or switch to Add new credentials to create one here.",
        };
      }
      return { ok: true, id };
    }

    if (!activeProvider) {
      return { ok: false, message: "Select a data source type before testing the connection." };
    }

    const prepared = buildCredentialCreateBody(activeProvider, name, newCredentialSecretData, {
      labels: newCredentialLabels,
    });
    if (!prepared.ok) {
      return { ok: false, message: prepared.message };
    }

    const cacheKey = credentialSecretCacheKey(
      activeProvider,
      name,
      newCredentialSecretData,
      newCredentialLabels,
    );
    const cached = createdCredentials[cacheKey];
    if (cached) return { ok: true, id: cached };

    if (!projectId) {
      return { ok: false, message: "No active project selected — pick a project first." };
    }

    try {
      const created = await createCredential({ projectId, body: prepared.body }).unwrap();
      if (!created?.id) {
        return { ok: false, message: "Credential was saved but no id was returned — try again." };
      }
      setCreatedCredentials((prev) => ({ ...prev, [cacheKey]: created.id }));
      return { ok: true, id: created.id };
    } catch (err) {
      if (isDuplicateCredentialError(err)) {
        const dup = credentials.find(
          (c) => c.name === name.trim() && c.provider === activeProvider,
        );
        if (dup) {
          try {
            await rotateCredential({
              projectId,
              id: dup.id,
              body: { secretData: prepared.body.secretData },
            }).unwrap();
            setCreatedCredentials((prev) => ({ ...prev, [cacheKey]: dup.id }));
            return { ok: true, id: dup.id };
          } catch (rotateErr) {
            const message = extractApiErrorMessage(rotateErr);
            return {
              ok: false,
              message: message
                ? `Could not update existing credential "${name.trim()}" — ${message}`
                : `Could not update existing credential "${name.trim()}". Use another name or rotate it on the Credentials page.`,
            };
          }
        }
      }
      const message = extractApiErrorMessage(err);
      return {
        ok: false,
        message: message
          ? `Could not save credential — ${message}`
          : "Could not save credential — check the credential details and try again.",
      };
    }
  }, [
    activeCategory, activeProvider, projectId, createCredential, rotateCredential, createdCredentials,
    credentials, newCredentialLabels, newCredentialSecretData,
    authMode, localCredential, localCredentialName,
    osAuthMode, osCredential, osCredentialName,
    dbAuthMode, dbCredential, dbCredentialName,
    apiAuthMode, apiCredential, apiCredentialName,
  ]);

  const effectiveCredentialId = useMemo(() => {
    let mode: "existing" | "new" = "existing";
    let existingId = "";
    let name = "";
    switch (activeCategory) {
      case "StorageSystem":
        mode = authMode; existingId = localCredential; name = localCredentialName;
        break;
      case "ObjectStore":
        mode = osAuthMode; existingId = osCredential; name = osCredentialName;
        break;
      case "Database":
        mode = dbAuthMode; existingId = dbCredential; name = dbCredentialName;
        break;
      case "API":
        mode = apiAuthMode; existingId = apiCredential; name = apiCredentialName;
        break;
      default:
        return "";
    }
    if (mode === "existing") return existingId;
    if (!activeProvider) return "";
    return createdCredentials[
      credentialSecretCacheKey(activeProvider, name, newCredentialSecretData, newCredentialLabels)
    ] ?? "";
  }, [
    activeCategory, activeProvider, createdCredentials, newCredentialLabels, newCredentialSecretData,
    authMode, localCredential, localCredentialName,
    osAuthMode, osCredential, osCredentialName,
    dbAuthMode, dbCredential, dbCredentialName,
    apiAuthMode, apiCredential, apiCredentialName,
  ]);

  const handleConfirmStorageSystem = useCallback((credentialId: string) => {
    const map = CONNECTOR_PROVIDER_MAP[localDatabaseSubType];
    const config = isOntap
      ? compactConfig({
        cluster_url: localClusterUrl,
        verify_tls: localTlsVerification === "Enabled",
        default_svm: localStorageVmScope,
      })
      : isAzure
        ? compactConfig({
          subscription_id: localSubscriptionId,
          default_region: localRegion,
          resource_group: localResourceGroup,
        })
        : compactConfig({
          project_id: localProjectId,
          default_region: localRegion,
        });
    form.setFieldValue("source_type", localDatabaseSubType as never);
    // ONTAP keys its connection off the cluster URL; Azure off subscription ID; GCP off the project ID
    form.setFieldValue(
      "connection.server",
      isOntap ? localClusterUrl : isAzure ? localSubscriptionId : localProjectId,
    );
    form.setFieldValue("connection.auth_method", "credential_ref");
    form.setFieldValue("connection.username", credentialId);
    form.setFieldValue("connector", {
      provider: map.provider,
      scope: map.scope,
      connector_type: map.connectorType,
      config,
      credential_id: credentialId,
    });
    onPasswordSet?.(true);
    onClose();
  }, [
    form, localDatabaseSubType, isOntap, isAzure, localClusterUrl, localProjectId, localRegion,
    localSubscriptionId, localResourceGroup, localTlsVerification, localStorageVmScope, onPasswordSet, onClose,
  ]);

  const handleConfirmObjectStore = useCallback((credentialId: string) => {
    // Endpoint, bucket, region, and prefix are optional; compactConfig drops any
    // that are left empty so edit can still rehydrate provided values.
    const config = compactConfig({ bucket: osBucket, prefix: osPrefix, region: osRegion, endpoint: osEndpoint });
    form.setFieldValue("source_type", osSubType as never);
    form.setFieldValue("connection.server", osEndpoint || osBucket);
    form.setFieldValue("connection.auth_method", "credential_ref");
    form.setFieldValue("connection.username", credentialId);
    form.setFieldValue("connector", {
      provider: osResolvedProvider,
      scope: "resource",
      connector_type: "objectstore",
      config,
      credential_id: credentialId,
    });
    onPasswordSet?.(true);
    onClose();
  }, [form, osResolvedProvider, osSubType, osEndpoint, osBucket, osPrefix, osRegion, onPasswordSet, onClose]);

  const handleConfirmDatabase = useCallback((credentialId: string) => {
    const config = compactConfig({
      host: dbHost,
      port: dbPort ? Number(dbPort) : undefined,
      database: dbDatabase,
      schema: dbSchema,
      ssl_mode: dbSslMode,
    });
    form.setFieldValue("source_type", dbSubType as never);
    form.setFieldValue("connection.server", dbHost);
    form.setFieldValue("connection.auth_method", "credential_ref");
    form.setFieldValue("connection.username", credentialId);
    form.setFieldValue("connector", {
      provider: dbResolvedProvider,
      scope: "resource",
      connector_type: "database",
      config,
      credential_id: credentialId,
    });
    onPasswordSet?.(true);
    onClose();
  }, [form, dbResolvedProvider, dbSubType, dbHost, dbPort, dbDatabase, dbSchema, dbSslMode, onPasswordSet, onClose]);

  const handleConfirmVolume = useCallback(() => {
    // The top table selects the volume subtype (e.g. "NFSVolumes"); volume_type
    // carries the bare protocol ("NFS"/"SMB") and source_type stays the subtype
    // so the create slice routes through the volume_config mapping.
    const volumeType = volSubType.replace(/Volumes$/i, "");
    const mountOptions = volMountOptions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hasAuth = volUsername !== "" || volPassword !== "";
    form.setFieldValue("source_type", volSubType as never);
    form.setFieldValue("connection.provisioning_mode", volMode);
    form.setFieldValue("connection.volume_type", volumeType);
    form.setFieldValue("connection.volume_name", volName);
    // Static volumes register an endpoint; dynamic volumes provision a PVC.
    form.setFieldValue("connection.server", volMode === "static" ? volEndpoint : "");
    form.setFieldValue("connection.export_path", "");
    form.setFieldValue("connection.region", volRegion);
    form.setFieldValue("connection.mount_options", mountOptions);
    form.setFieldValue("connection.storage_class_name", volMode === "dynamic" ? volStorageClass : "");
    form.setFieldValue("connection.storage_size", volMode === "dynamic" ? volStorageSize : "");
    // Optional authentication.
    form.setFieldValue("connection.auth_method", hasAuth ? "basic" : "none");
    form.setFieldValue("connection.username", volUsername);
    form.setFieldValue("connection.password", volPassword);
    form.setFieldValue("connection.metadata", volMetadata);
    // Volume is a volume_config source, not a connector — clear any connector
    // payload a previous connector selection may have left on the form.
    form.setFieldValue("connector", null);
    onPasswordSet?.(volPassword !== "");
    onClose();
  }, [
    form, volSubType, volMode, volEndpoint, volRegion, volMountOptions,
    volStorageClass, volStorageSize, volUsername, volPassword, volMetadata, onPasswordSet, onClose,
  ]);

  const handleConfirmApi = useCallback((credentialId: string) => {
    const config = compactConfig({
      base_url: apiBaseUrl,
      verify_tls: apiTlsVerification === "Enabled",
      include_query_results: apiIncludeQueryResults === "Yes",
      include_dashboards: apiIncludeDashboards === "Yes",
      include_data_sources: apiIncludeDataSources === "Yes",
      max_result_rows: apiResultRowLimit ? Number(apiResultRowLimit) : undefined,
    });
    form.setFieldValue("source_type", apiSubType as never);
    form.setFieldValue("connection.server", apiBaseUrl);
    form.setFieldValue("connection.auth_method", "credential_ref");
    form.setFieldValue("connection.username", credentialId);
    form.setFieldValue("connector", {
      provider: "redash",
      scope: "account",
      connector_type: "api",
      config,
      credential_id: credentialId,
    });
    onPasswordSet?.(true);
    onClose();
  }, [form, apiSubType, apiBaseUrl, apiTlsVerification, apiIncludeQueryResults, apiIncludeDashboards, apiIncludeDataSources, apiResultRowLimit, onPasswordSet, onClose]);

  // Connector categories accept either an existing saved credential or an inline
  // "new" credential. A "new" credential is complete once it has a name + secret
  // (service account key / token); on Test/Add it is persisted via the create
  // API and then referenced by id (see ensureCredentialId).
  const inlineNewCredentialReady = (
    mode: "existing" | "new",
    existingId: string,
    name: string,
  ): boolean =>
    mode === "existing"
      ? existingId.trim() !== ""
      : name.trim() !== "" &&
        Boolean(activeProvider) &&
        isCredentialSecretComplete(activeProvider ?? "", newCredentialSecretData);

  const osCredsComplete = inlineNewCredentialReady(osAuthMode, osCredential, osCredentialName);

  const dbCredsComplete = inlineNewCredentialReady(dbAuthMode, dbCredential, dbCredentialName);

  const apiCredsComplete = inlineNewCredentialReady(apiAuthMode, apiCredential, apiCredentialName);

  const activeConnectorScope = useMemo<ConnectorScope | undefined>(() => {
    switch (activeCategory) {
      case "StorageSystem":
        return CONNECTOR_PROVIDER_MAP[localDatabaseSubType]?.scope;
      case "ObjectStore":
        return "resource";
      case "Database":
        return "resource";
      case "API":
        return "account";
      default:
        return undefined;
    }
  }, [activeCategory, localDatabaseSubType]);

  const requiredFields = useMemo(
    () => getRequiredFieldSet(providerCatalog, activeCatalogProvider, activeConnectorScope),
    [providerCatalog, activeCatalogProvider, activeConnectorScope],
  );

  const storageCredsComplete = inlineNewCredentialReady(authMode, localCredential, localCredentialName);

  const activeCredsComplete = useMemo(() => {
    switch (activeCategory) {
      case "StorageSystem":
        return storageCredsComplete;
      case "ObjectStore":
        return osCredsComplete;
      case "Database":
        return dbCredsComplete;
      case "API":
        return apiCredsComplete;
      default:
        return false;
    }
  }, [
    activeCategory, storageCredsComplete, osCredsComplete, dbCredsComplete, apiCredsComplete,
  ]);

  const connectorSubtypeSelected = useMemo(() => {
    switch (activeCategory) {
      case "StorageSystem":
        return localDatabaseSubType !== "";
      case "ObjectStore":
        return osSubType !== "" && osProvider.trim() !== "";
      case "Database":
        return dbSubType !== "";
      case "API":
        return apiSubType !== "";
      default:
        return false;
    }
  }, [activeCategory, localDatabaseSubType, osSubType, osProvider, dbSubType, apiSubType]);

  // Volume name + region are always required. Static needs an endpoint;
  // dynamic needs a storage class and storage size.
  const volSharedProvided =
    volSubType !== "" && volName.trim() !== "" && volRegion.trim() !== "";
  const canConfirmVolume = volMode === "static"
    ? volSharedProvided && volEndpoint.trim() !== ""
    : volSharedProvided && volStorageClass.trim() !== "" && volStorageSize.trim() !== "";

  // -- Connection test --

  // The exact { connectorConfig, credentialId } the workflow-engine test expects
  // for the active connector category. Mirrors the per-category confirm handlers
  // (provider/scope/connector_type + compacted provider config). Volume sources
  // are not connectors, so they have no test payload.
  const testPayload = useMemo<{ connectorConfig: Record<string, unknown>; credentialId: string } | null>(() => {
    switch (activeCategory) {
      case "StorageSystem": {
        const map = CONNECTOR_PROVIDER_MAP[localDatabaseSubType];
        if (!map) return null;
        const config = isOntap
          ? compactConfig({
            cluster_url: localClusterUrl,
            verify_tls: localTlsVerification === "Enabled",
            default_svm: localStorageVmScope,
          })
          : isAzure
            ? compactConfig({
              subscription_id: localSubscriptionId,
              default_region: localRegion,
              resource_group: localResourceGroup,
            })
            : compactConfig({ project_id: localProjectId, default_region: localRegion });
        return {
          connectorConfig: { connector_type: map.connectorType, provider: map.provider, scope: map.scope, ...config },
          credentialId: effectiveCredentialId,
        };
      }
      case "ObjectStore": {
        const config = compactConfig({ bucket: osBucket, prefix: osPrefix, region: osRegion, endpoint: osEndpoint });
        return {
          connectorConfig: { connector_type: "objectstore", provider: osResolvedProvider, scope: "resource", ...config },
          credentialId: effectiveCredentialId,
        };
      }
      case "Database": {
        const config = compactConfig({
          host: dbHost,
          port: dbPort ? Number(dbPort) : undefined,
          database: dbDatabase,
          schema: dbSchema,
          ssl_mode: dbSslMode,
        });
        return {
          connectorConfig: { connector_type: "database", provider: dbResolvedProvider, scope: "resource", ...config },
          credentialId: effectiveCredentialId,
        };
      }
      case "API": {
        const config = compactConfig({
          base_url: apiBaseUrl,
          verify_tls: apiTlsVerification === "Enabled",
          include_query_results: apiIncludeQueryResults === "Yes",
          include_dashboards: apiIncludeDashboards === "Yes",
          include_data_sources: apiIncludeDataSources === "Yes",
          max_result_rows: apiResultRowLimit ? Number(apiResultRowLimit) : undefined,
        });
        return {
          connectorConfig: { connector_type: "api", provider: "redash", scope: "account", ...config },
          credentialId: effectiveCredentialId,
        };
      }
      default:
        return null;
    }
  }, [
    activeCategory, localDatabaseSubType, isOntap, isAzure, localClusterUrl, localTlsVerification, localStorageVmScope,
    localProjectId, localRegion, localSubscriptionId, localResourceGroup, osResolvedProvider, osBucket, osPrefix, osRegion, osEndpoint,
    dbHost, dbPort, dbDatabase, dbSchema, dbSslMode, dbResolvedProvider, apiBaseUrl,
    apiTlsVerification, apiIncludeQueryResults, apiIncludeDashboards, apiIncludeDataSources, apiResultRowLimit,
    effectiveCredentialId,
  ]);

  const validationConfig = useMemo(
    () => (testPayload ? extractValidationConfig(testPayload.connectorConfig) : {}),
    [testPayload],
  );

  const canConfirmConnectorCategory =
    catalogReady &&
    connectorSubtypeSelected &&
    isConnectorCategoryReady(
      providerCatalog,
      activeCatalogProvider,
      activeConnectorScope,
      validationConfig,
      activeCredsComplete,
    );

  const fieldsReadyForConfirm =
    (activeCategory === "Volume" && canConfirmVolume) ||
    (["StorageSystem", "ObjectStore", "Database", "API"].includes(activeCategory) &&
      canConfirmConnectorCategory) ||
    !["StorageSystem", "ObjectStore", "Database", "Volume", "API"].includes(activeCategory);

  const testSignature = useMemo(() => (testPayload ? JSON.stringify(testPayload) : ""), [testPayload]);

  // Test button is enabled by the same gating as Add for that category (all
  // required fields + a selected credential present).
  const canTest =
    ["StorageSystem", "ObjectStore", "Database", "API"].includes(activeCategory) &&
    canConfirmConnectorCategory;

  // Keep "loading" pinned for the whole in-flight test: the new-credential path
  // re-pins connTest.signature to the freshly-created credential id before
  // effectiveCredentialId (and thus testSignature) catches up, so a signature
  // comparison would otherwise briefly flip a running test back to idle and
  // re-enable the button. Only the terminal pass/fail result is gated by the
  // signature, so editing fields after a test invalidates the displayed result.
  const shownTestStatus: ConnectionTestStatus =
    connTest.status === "loading"
      ? "loading"
      : connTest.signature === testSignature
        ? connTest.status
        : "idle";

  // Add/Save is enabled once all required fields are provided. Connector
  // categories also surface Test Connection at the same gate; testing is
  // optional and the status stays "Untested" until a test is run. Confirm stays
  // disabled while a test is in-flight to avoid overlapping ensureCredentialId()
  // calls (especially in "new credential" mode).
  const canConfirm =
    fieldsReadyForConfirm && (!canTest || shownTestStatus !== "loading");

  const handleConfirm = useCallback(async () => {
    // Volume sources are not credential-backed.
    if (activeCategory === "Volume") {
      handleConfirmVolume();
      return;
    }
    // Object store requires provider, bucket, and a credential (existing or inline-new).
    if (activeCategory === "ObjectStore") {
      const credentialResult = await ensureCredentialId();
      if (!credentialResult.ok) {
        toast.error(credentialResult.message);
        return;
      }
      onTestResult?.(shownTestStatus);
      handleConfirmObjectStore(credentialResult.id);
      return;
    }
    // Connectors need a real credential id; create the inline one first when in
    // "new" mode. Bail (keep the dialog open) if it could not be resolved.
    const credentialResult = await ensureCredentialId();
    if (!credentialResult.ok) {
      toast.error(credentialResult.message);
      return;
    }
    const credentialId = credentialResult.id;
    onTestResult?.(shownTestStatus);
    if (activeCategory === "StorageSystem") {
      handleConfirmStorageSystem(credentialId);
    } else if (activeCategory === "Database") {
      handleConfirmDatabase(credentialId);
    } else if (activeCategory === "API") {
      handleConfirmApi(credentialId);
    } else {
      onClose();
    }
  }, [
    activeCategory, ensureCredentialId, shownTestStatus, onTestResult,
    handleConfirmStorageSystem, handleConfirmObjectStore, handleConfirmDatabase,
    handleConfirmVolume, handleConfirmApi, onClose,
  ]);

  const runConnectionTest = useCallback(async () => {
    if (!testPayload) return;
    const runId = ++testRunRef.current;
    // Show loading immediately so the button disables while we resolve creds.
    let signature = JSON.stringify(testPayload);
    setConnTest({ status: "loading", message: "", signature });
    onTestResult?.("loading");

    // Resolve (creating, when in "new" mode) the credential to test against,
    // then re-pin the signature to the resolved id — inline credential creation
    // updates testPayload, so the displayed result must track the tested id.
    const credentialResult = await ensureCredentialId();
    if (testRunRef.current !== runId) return;
    if (!credentialResult.ok) {
      const finishEarly = (status: ConnectionTestStatus, message: string) => {
        if (testRunRef.current !== runId) return;
        setConnTest({ status, message, signature });
        onTestResult?.(status);
      };
      finishEarly("error", credentialResult.message);
      return;
    }
    const credentialId = credentialResult.id;
    signature = JSON.stringify({ connectorConfig: testPayload.connectorConfig, credentialId });
    setConnTest({ status: "loading", message: "", signature });

    const finish = (status: ConnectionTestStatus, message: string) => {
      if (testRunRef.current !== runId) return; // superseded by a newer run/close
      setConnTest({ status, message, signature });
      onTestResult?.(status);
    };

    if (!projectId) {
      finish("error", "No active project selected — pick a project first.");
      return;
    }

    try {
      const { workflowId } = await startConnectorTest(projectId, {
        connectorConfig: testPayload.connectorConfig,
        credentialId,
      }, reduxStore.getState);
      // Poll the workflow lifecycle: it completes on success and fails (with a
      // reason) when the connection is refused/unreachable.
      const deadline = Date.now() + 90_000;
      for (;;) {
        if (testRunRef.current !== runId) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (testRunRef.current !== runId) return;

        let st;
        try {
          st = await getWorkflowStatus(workflowId, reduxStore.getState);
        } catch (pollErr) {
          if (Date.now() > deadline) {
            throw pollErr instanceof Error ? pollErr : new Error("Connection test failed.");
          }
          continue; // transient poll error — keep trying until the deadline
        }

        if (st.isRunning || st.status === "running") {
          if (Date.now() > deadline) {
            finish("error", "The connection test timed out.");
            return;
          }
          continue;
        }
        if (st.status === "completed") {
          finish("success", "Connection successful.");
        } else {
          finish("error", st.failureMessage || "Connection failed.");
        }
        return;
      }
    } catch (err) {
      finish("error", err instanceof Error ? err.message : "Connection test failed.");
    }
  }, [testPayload, projectId, ensureCredentialId, onTestResult, reduxStore]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        /* v8 ignore start -- controlled dialog: nextOpen is always false from external triggers */
        if (!nextOpen) onClose();
        /* v8 ignore stop */
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="ds-form__access-dialog">
        <Card>
          <CardHeader
            title={isEdit ? "Edit data source access configuration" : "Add data source access configuration"}
            hasSeparator
          />
          {/* Dialog body — plain div, fully owns spacing to avoid CardBlock cascade issues */}
          <div className="ds-form__access-body">
            {/* Subtitle row */}
            <div className="ds-form__access-subtitle">
              <Typography Component="span" fontSize="fs14" boldness="regular">
                Select a data source type and access details to it.
              </Typography>
            </div>

            {/* Category tabs — tab list carries its own border-bottom separator */}
            <div className="ds-form__category-tabs">
              <TabGroup
                tabs={DATASOURCE_CATEGORY_TABS}
                activeTabId={activeCategory}
                onTabChange={setActiveCategory}
              />
            </div>

            <ProviderCatalogStatus
              show={CONNECTOR_CATEGORIES_USING_CATALOG.has(activeCategory)}
              isLoading={catalogLoading}
              isError={catalogError}
              isReady={catalogReady}
              onRetry={() => {
                void refetchProviderCatalog();
              }}
            />

            {/* Storage system tab content */}
            {activeCategory === "StorageSystem" && (
              <>
                {/* Storage system type selection table — zero top padding, flush after tab separator */}
                <div className="ds-form__db-type-section">
                  <SourceTypeTable
                    options={DATABASE_SOURCE_OPTIONS}
                    ariaLabel="Storage system type"
                    value={localDatabaseSubType}
                    onChange={handleDatabaseSubTypeChange}
                  />
                </div>

                {/* Authentication details */}
                {localDatabaseSubType !== "" && (
                  <>
                  <AuthDetailsSection
                    authMode={authMode}
                    onAuthModeChange={setAuthMode}
                    credentialItems={credentialItems}
                    credential={localCredential}
                    onCredentialChange={setLocalCredential}
                    credentialName={localCredentialName}
                    onCredentialNameChange={setLocalCredentialName}
                    provider={activeProvider}
                    secretData={newCredentialSecretData}
                    onSecretDataChange={setNewCredentialSecretData}
                    instructionsIntro={
                      isFsxn ? FSXN_INSTRUCTIONS.intro : isOntap ? ONTAP_INSTRUCTIONS.intro : isAzure ? AZURE_INSTRUCTIONS.intro : GCP_INSTRUCTIONS.intro
                    }
                    instructionsSteps={
                      isFsxn ? FSXN_INSTRUCTIONS.steps : isOntap ? ONTAP_INSTRUCTIONS.steps : isAzure ? AZURE_INSTRUCTIONS.steps : GCP_INSTRUCTIONS.steps
                    }
                    instructionsExpanded={instructionsExpanded}
                    onToggleInstructions={() => setInstructionsExpanded((p) => !p)}
                    newCredentialLabels={newCredentialLabels}
                    onNewCredentialLabelsChange={setNewCredentialLabels}
                    detailsSection={
                      isOntap ? (
                        <OntapClusterDetails
                          clusterUrl={localClusterUrl}
                          onClusterUrlChange={setLocalClusterUrl}
                          tlsVerification={localTlsVerification}
                          onTlsVerificationChange={setLocalTlsVerification}
                          storageVmScope={localStorageVmScope}
                          onStorageVmScopeChange={setLocalStorageVmScope}
                          requiredFields={requiredFields}
                        />
                      ) : isAzure ? (
                        <AzureSubscriptionDetails
                          subscriptionId={localSubscriptionId}
                          onSubscriptionIdChange={setLocalSubscriptionId}
                          region={localRegion}
                          onRegionChange={setLocalRegion}
                          resourceGroup={localResourceGroup}
                          onResourceGroupChange={setLocalResourceGroup}
                          requiredFields={requiredFields}
                        />
                      ) : (
                        <GcpProjectDetails
                          projectId={localProjectId}
                          onProjectIdChange={setLocalProjectId}
                          region={localRegion}
                          onRegionChange={setLocalRegion}
                          requiredFields={requiredFields}
                        />
                      )
                    }
                  />
                  <ConnectionTestControl
                    disabled={!canTest}
                    status={shownTestStatus}
                    message={connTest.message}
                    onTest={runConnectionTest}
                  />
                  </>
                )}
              </>
            )}

            {/* Object store tab content */}
            {activeCategory === "ObjectStore" && (
              <>
                {/* Object store type selection table */}
                <div className="ds-form__db-type-section">
                  <SourceTypeTable
                    options={OBJECT_STORE_SOURCE_OPTIONS}
                    ariaLabel="Object store type"
                    value={osSubType}
                    onChange={handleObjectStoreSubTypeChange}
                />
              </div>

                {/* Authentication details */}
                {osSubType !== "" && (
                  <>
                  <AuthDetailsSection
                    authMode={osAuthMode}
                    onAuthModeChange={setOsAuthMode}
                    credentialItems={credentialItems}
                    credential={osCredential}
                    onCredentialChange={setOsCredential}
                    credentialName={osCredentialName}
                    onCredentialNameChange={setOsCredentialName}
                    provider={activeProvider}
                    secretData={newCredentialSecretData}
                    onSecretDataChange={setNewCredentialSecretData}
                    instructionsIntro={OBJECT_STORE_INSTRUCTIONS.intro}
                    instructionsSteps={OBJECT_STORE_INSTRUCTIONS.steps}
                    instructionsExpanded={osInstructionsExpanded}
                    onToggleInstructions={() => setOsInstructionsExpanded((p) => !p)}
                    newCredentialLabels={newCredentialLabels}
                    onNewCredentialLabelsChange={setNewCredentialLabels}
                    credentialRequired
                    detailsSection={
                      <ObjectStoreDetails
                        provider={osProvider}
                        onProviderChange={handleObjectStoreProviderChange}
                        endpoint={osEndpoint}
                        onEndpointChange={setOsEndpoint}
                        bucket={osBucket}
                        onBucketChange={setOsBucket}
                        prefix={osPrefix}
                        onPrefixChange={setOsPrefix}
                        region={osRegion}
                        onRegionChange={setOsRegion}
                        requiredFields={requiredFields}
                      />
                    }
                  />
                  <ConnectionTestControl
                    disabled={!canTest}
                    status={shownTestStatus}
                    message={connTest.message}
                    onTest={runConnectionTest}
                  />
                  </>
                )}
              </>
            )}

            {/* Database tab content */}
            {activeCategory === "Database" && (
              <>
                {/* Database engine selection table */}
                <div className="ds-form__db-type-section">
                  <SourceTypeTable
                    options={DATABASE_ENGINE_OPTIONS}
                    ariaLabel="Database engine"
                    value={dbSubType}
                    onChange={handleDatabaseEngineChange}
                  />
                </div>

                {/* Authentication details */}
                {dbSubType !== "" && (
                  <>
                  <AuthDetailsSection
                    authMode={dbAuthMode}
                    onAuthModeChange={setDbAuthMode}
                    credentialItems={credentialItems}
                    credential={dbCredential}
                    onCredentialChange={setDbCredential}
                    credentialName={dbCredentialName}
                    onCredentialNameChange={setDbCredentialName}
                    provider={activeProvider}
                    secretData={newCredentialSecretData}
                    onSecretDataChange={setNewCredentialSecretData}
                    instructionsIntro={DATABASE_INSTRUCTIONS.intro}
                    instructionsSteps={DATABASE_INSTRUCTIONS.steps}
                    instructionsExpanded={dbInstructionsExpanded}
                    onToggleInstructions={() => setDbInstructionsExpanded((p) => !p)}
                    newCredentialLabels={newCredentialLabels}
                    onNewCredentialLabelsChange={setNewCredentialLabels}
                    detailsSection={
                      <DatabaseDetails
                        dbType={dbType}
                        onDbTypeChange={handleDatabaseTypeChange}
                        host={dbHost}
                        onHostChange={setDbHost}
                        port={dbPort}
                        onPortChange={setDbPort}
                        database={dbDatabase}
                        onDatabaseChange={setDbDatabase}
                        schema={dbSchema}
                        onSchemaChange={setDbSchema}
                        sslMode={dbSslMode}
                        onSslModeChange={setDbSslMode}
                        requiredFields={requiredFields}
                      />
                    }
                  />
                  <ConnectionTestControl
                    disabled={!canTest}
                    status={shownTestStatus}
                    message={connTest.message}
                    onTest={runConnectionTest}
                  />
                  </>
                )}
              </>
            )}

            {/* Volume tab content */}
            {activeCategory === "Volume" && (
              <>
                {/* Volume type selection table (same template as the other tabs) */}
                <div className="ds-form__db-type-section">
                  <SourceTypeTable
                    options={VOLUME_SOURCE_OPTIONS}
                    ariaLabel="Volume type"
                    value={volSubType}
                    onChange={setVolSubType}
                  />
                </div>

                {/* Volume configuration — existing vs new volume + details */}
                {volSubType !== "" && (
                  <VolumeConfigSection
                    mode={volMode}
                    onModeChange={setVolMode}
                    endpoint={volEndpoint}
                    onEndpointChange={setVolEndpoint}
                    storageClassItems={storageClassItems}
                    storageClass={volStorageClass}
                    onStorageClassChange={setVolStorageClass}
                    storageClassEmpty={storageClassItems.length === 0}
                    storageSize={volStorageSize}
                    onStorageSizeChange={setVolStorageSize}
                    volumeName={volName}
                    onVolumeNameChange={setVolName}
                    region={volRegion}
                    onRegionChange={setVolRegion}
                    mountOptions={volMountOptions}
                    onMountOptionsChange={setVolMountOptions}
                    username={volUsername}
                    onUsernameChange={setVolUsername}
                    password={volPassword}
                    onPasswordChange={setVolPassword}
                    metadata={volMetadata}
                    onMetadataChange={setVolMetadata}
                  />
                )}
              </>
            )}

            {/* API tab content */}
            {activeCategory === "API" && (
              <>
                {/* API type selection table */}
                <div className="ds-form__db-type-section">
                  <SourceTypeTable
                    options={API_SOURCE_OPTIONS}
                    ariaLabel="API type"
                    value={apiSubType}
                    onChange={handleApiSubTypeChange}
                />
              </div>

                {/* Authentication details */}
                {apiSubType !== "" && (
                  <>
                  <AuthDetailsSection
                    authMode={apiAuthMode}
                    onAuthModeChange={setApiAuthMode}
                    credentialItems={credentialItems}
                    credential={apiCredential}
                    onCredentialChange={setApiCredential}
                    credentialName={apiCredentialName}
                    onCredentialNameChange={setApiCredentialName}
                    provider={activeProvider}
                    secretData={newCredentialSecretData}
                    onSecretDataChange={setNewCredentialSecretData}
                    instructionsIntro={API_INSTRUCTIONS.intro}
                    instructionsSteps={API_INSTRUCTIONS.steps}
                    instructionsExpanded={apiInstructionsExpanded}
                    onToggleInstructions={() => setApiInstructionsExpanded((p) => !p)}
                    newCredentialLabels={newCredentialLabels}
                    onNewCredentialLabelsChange={setNewCredentialLabels}
                    detailsSection={
                      <ApiDetails
                        baseUrl={apiBaseUrl}
                        onBaseUrlChange={setApiBaseUrl}
                        tlsVerification={apiTlsVerification}
                        onTlsVerificationChange={setApiTlsVerification}
                        includeQueryResults={apiIncludeQueryResults}
                        onIncludeQueryResultsChange={setApiIncludeQueryResults}
                        includeDashboards={apiIncludeDashboards}
                        onIncludeDashboardsChange={setApiIncludeDashboards}
                        includeDataSources={apiIncludeDataSources}
                        onIncludeDataSourcesChange={setApiIncludeDataSources}
                        resultRowLimit={apiResultRowLimit}
                        onResultRowLimitChange={setApiResultRowLimit}
                        requiredFields={requiredFields}
                      />
                    }
                  />
                  <ConnectionTestControl
                    disabled={!canTest}
                    status={shownTestStatus}
                    message={connTest.message}
                    onTest={runConnectionTest}
                  />
                  </>
                )}
              </>
            )}
          </div>
          <CardFooter
            hasSeparator
            alignment="end"
            className="ds-form__access-dialog-footer"
            actions={[
              {
                variant: "solid",
                size: "medium",
                label: isEdit ? "Save" : "Add",
                onClick: handleConfirm,
                isDisabled: !canConfirm,
              },
              { variant: "outline", size: "medium", label: "Cancel", onClick: onClose },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

export { AccessConfigDialog };
export type { AccessConfigDialogProps };

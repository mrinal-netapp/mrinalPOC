import type { ReactElement } from "react";
import { IconCircleMinus } from "@tabler/icons-react";

import type { ConnectorCreateInput, DataSourceStatus } from "@/api/data-source.types";
import {
  connectorTypeToDataSourceCategory,
  formatDataSourceCategoryLabel,
} from "@/api/data-source-category.utils";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { STATUS_ICON_MAP } from "@/components/data-source/utils/data-source.utils";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import type { ConnectionTestStatus } from "./access-config-dialog";
import { SOURCE_TYPE_LABELS, VOLUME_SOURCE_OPTIONS } from "./data-source-form.consts";

// -- Connector summary mapping --
// A connector-backed source (Storage system / Object store / Database / API)
// shows its resolved category as "Type", the saved credential name, and a small
// curated set of the most relevant config fields. Volume sources (not connectors)
// use the volume-type / volume-name layout below.

// Friendly display names for connector providers (object-store "Provider" and
// database "Database Type" surface these in the summary).
const PROVIDER_DISPLAY_LABELS: Record<string, string> = {
  s3: "Amazon S3",
  gcs: "Google Cloud Storage",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  gcp: "Google Cloud",
  ontap: "NetApp ONTAP",
  redash: "Redash",
};

const VOLUME_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  VOLUME_SOURCE_OPTIONS.map((o) => [o.value, o.title]),
);

interface DetailRow {
  label: string;
  value: string;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

function providerLabel(provider: string): string {
  return PROVIDER_DISPLAY_LABELS[provider] ?? provider;
}

// Curated per-category summary rows (after Connection status + Type). Each
// category surfaces its credential plus the two most identifying config fields.
function buildConnectorRows(connector: ConnectorCreateInput, credentialName?: string): DetailRow[] {
  const config = connector.config ?? {};
  const credential: DetailRow = {
    label: "Credential",
    value: credentialName || connector.credential_id || "—",
  };

  switch (connector.connector_type) {
    case "cloud": // Storage system — Google Cloud
      return [
        credential,
        { label: "Project ID", value: displayValue(config.project_id) },
        { label: "Region", value: displayValue(config.default_region ?? config.region) },
      ];
    case "storage": // Storage system — NetApp ONTAP (no project ID / region)
      return [
        credential,
        { label: "Cluster URL", value: displayValue(config.cluster_url) },
      ];
    case "objectstore":
      // Endpoint is absent for providers like GCS; fall back to the bucket so
      // the summary still surfaces a meaningful identifier.
      return [
        credential,
        { label: "Provider", value: providerLabel(connector.provider) },
        config.endpoint
          ? { label: "Endpoint", value: displayValue(config.endpoint) }
          : { label: "Bucket", value: displayValue(config.bucket) },
      ];
    case "database":
      return [
        credential,
        { label: "Database Type", value: providerLabel(connector.provider) },
        { label: "Host", value: displayValue(config.host) },
      ];
    case "api":
      return [
        credential,
        { label: "Base URL", value: displayValue(config.base_url) },
      ];
    default:
      return [credential];
  }
}

// -- Helper components --

function VolumeIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 7h16v2H4V7Zm0 4h16v2H4v-2Zm0 4h16v2H4v-2Z" fill="currentColor" />
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function ConnectionStatusIndicator({ status }: { status: DataSourceStatus }): ReactElement {
  const visual = STATUS_ICON_MAP[status];

  return (
    <span className="ds-form__access-info-status">
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {status}
      </Typography>
    </span>
  );
}

// -- Section --

interface AccessConfigSectionProps {
  configured: boolean;
  onOpenDialog: () => void;
  sourceType: string;
  server: string;
  /** User-supplied volume name (Volume sources only). */
  volumeName?: string;
  username: string;
  passwordConfigured: boolean;
  connectionStatus: DataSourceStatus;
  testStatus?: ConnectionTestStatus;
  /** Present for connector-backed sources; drives the connector summary layout. */
  connector?: ConnectorCreateInput | null;
  /** Resolved name of the saved credential referenced by the connector. */
  credentialName?: string;
}

function AccessConfigSection({
  configured,
  onOpenDialog,
  sourceType,
  volumeName,
  testStatus = "idle",
  connector,
  credentialName,
}: AccessConfigSectionProps): ReactElement {
  const isConnector = !!connector;
  // Volume is the only non-connector category.
  const typeLabel = isConnector
    ? formatDataSourceCategoryLabel(connectorTypeToDataSourceCategory(connector.connector_type))
      ?? connector.connector_type
    : "Volume";

  // Volume sources have no credential (no auth handle is persisted), so the
  // summary only surfaces the volume type and the user-supplied volume name.
  const detailRows: DetailRow[] = isConnector
    ? buildConnectorRows(connector, credentialName)
    : [
      { label: "Volume type", value: VOLUME_TYPE_LABELS[sourceType] ?? SOURCE_TYPE_LABELS[sourceType] ?? sourceType },
      { label: "Volume name", value: volumeName || "—" },
    ];

  // Connection status mirrors the Test Connection lifecycle rather than the
  // backend health: not yet run → Untested, in progress → Testing…, pass →
  // Success, fail → Failed.
  function renderConnectionStatus(): ReactElement {
    if (testStatus === "loading") {
      return (
        <span className="ds-form__access-info-status">
          <Spinner size="cell" />
          <Typography Component="span" fontSize="fs14" boldness="regular">
            Testing…
          </Typography>
        </span>
      );
    }

    const visual =
      testStatus === "success"
        ? STATUS_ICON_MAP.Healthy
        : testStatus === "error"
          ? STATUS_ICON_MAP.Failed
          : { type: "icon" as const, Icon: IconCircleMinus, color: "var(--text-disabled)" };
    const label = testStatus === "success" ? "Success" : testStatus === "error" ? "Failed" : "Untested";

    return (
      <span className="ds-form__access-info-status">
        <StatusIcon visual={visual} />
        <Typography Component="span" fontSize="fs14" boldness="regular">{label}</Typography>
      </span>
    );
  }

  return (
    <section className="ds-form__section">
      <div className="ds-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-form__section-title">
          Access configuration
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__section-subtitle">
          Connect the data source by specifying configuration details to access it.
        </Typography>
      </div>

      <Card className="ds-form__source-card">
        <CardHeader
          icon={<VolumeIcon />}
          title="Data source"
          hasSeparator
          actions={[
            <Button
              key="access-action"
              variant="flat"
              label={configured ? "Edit" : "Add"}
              onClick={onOpenDialog}
            />,
          ]}
        />
        {configured && (
          <CardContent>
            <CardBlock type="key-value">
              <div className="ds-form__access-info">
                <div className="ds-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Connection status
                  </Typography>
                  {renderConnectionStatus()}
                </div>
                <div className="ds-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">Type</Typography>
                  <Typography Component="span" fontSize="fs14" boldness="regular">{typeLabel}</Typography>
                </div>
                {detailRows.map((row) => (
                  <div key={row.label} className="ds-form__access-info-row">
                    <Typography Component="span" fontSize="fs14" boldness="regular">{row.label}</Typography>
                    <Typography Component="span" fontSize="fs14" boldness="regular">{row.value}</Typography>
                  </div>
                ))}
              </div>
            </CardBlock>
          </CardContent>
        )}
      </Card>
    </section>
  );
}

export { AccessConfigSection, VolumeIcon, ConnectionStatusIndicator };
export type { AccessConfigSectionProps };

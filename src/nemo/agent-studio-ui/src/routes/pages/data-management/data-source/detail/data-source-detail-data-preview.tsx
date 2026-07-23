import { useCallback, useMemo, useState, type ReactElement } from "react";

import type { DataSourceDetail } from "@/api/data-source.types";
import type { FilterCriteria } from "@/api/analytics-api";
import { IconFilter, IconChevronDown } from "@tabler/icons-react";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { BrowseFilterBuilder } from "@/components/data-source/preview/browse-filter-builder";
import { ConnectorBrowser } from "@/components/data-source/connector-browser/connector-browser-dialog";
import { VolumeBrowser } from "@/components/data-source/volume-browser/VolumeBrowserDialog";
import {
  CONNECTOR_BROWSE_FILTER_COLUMNS,
  CONNECTOR_BROWSE_FILTER_COLUMN_TYPES,
  formatBrowseFilterLabel,
  VOLUME_BROWSE_FILTER_COLUMNS,
  VOLUME_BROWSE_FILTER_COLUMN_TYPES,
} from "@/components/data-source/preview/browse-filter.utils";

export interface DataSourceDetailDataPreviewProps {
  data: DataSourceDetail;
  projectId: string;
}

function isConnectorDataSource(data: DataSourceDetail): boolean {
  return data.connector_config != null || (data.category != null && data.category !== "Volume");
}

function DataSourceDetailDataPreview({
  data,
  projectId,
}: DataSourceDetailDataPreviewProps): ReactElement {
  const isConnector = isConnectorDataSource(data);
  const [filters, setFilters] = useState<FilterCriteria[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedPanelId = `ds-preview-advanced-${data.dsrc_id}`;

  const filterColumns = useMemo(
    () => (isConnector ? [...CONNECTOR_BROWSE_FILTER_COLUMNS] : [...VOLUME_BROWSE_FILTER_COLUMNS]),
    [isConnector],
  );

  const filterColumnTypes = useMemo(
    () => (isConnector ? [...CONNECTOR_BROWSE_FILTER_COLUMN_TYPES] : [...VOLUME_BROWSE_FILTER_COLUMN_TYPES]),
    [isConnector],
  );

  const handleApplyFilters = useCallback((next: FilterCriteria[]) => {
    setFilters(next);
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters([]);
  }, []);

  const handleRemoveFilter = useCallback((index: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const filterSummary = filters.length === 0
    ? "None selected"
    : `${filters.length} selected`;

  const filterBadges = filters.length > 0 ? (
    <div className="ds-preview__filter-badges">
      {filters.map((f, i) => {
        const label = formatBrowseFilterLabel(f, filterColumns, filterColumnTypes);
        const truncated = label.length > 40 ? `${label.slice(0, 40)}…` : label;
        return (
          <button
            key={`${f.column}-${f.op}-${f.value ?? ""}-${i}`}
            type="button"
            className="ds-preview__filter-badge"
            onClick={() => handleRemoveFilter(i)}
            title="Click to remove"
            aria-label={`Remove filter: ${label}`}
          >
            {truncated} ×
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div className="ds-preview">
      <button
        type="button"
        className="ds-preview__advanced-row"
        onClick={() => setAdvancedOpen((open) => !open)}
        aria-expanded={advancedOpen}
        aria-controls={advancedPanelId}
      >
        <div className="ds-preview__advanced-left">
          <IconFilter size={16} aria-hidden className="ds-preview__filter-icon" />
          <Typography Component="span" fontSize="fs14" boldness="semibold">
            Advanced search and filtering
          </Typography>
        </div>
        <Typography
          Component="span"
          fontSize="fs14"
          boldness="regular"
          color="var(--text-secondary)"
          className="ds-preview__advanced-center"
        >
          {filterSummary}
        </Typography>
        <div className="ds-preview__advanced-right">
          <IconChevronDown
            size={16}
            aria-hidden
            className={`ds-preview__advanced-chevron${advancedOpen ? " ds-preview__advanced-chevron--open" : ""}`}
          />
        </div>
      </button>

      <div id={advancedPanelId} className="ds-preview__advanced-content" hidden={!advancedOpen}>
        <div className="ds-preview__top-filter">
          <BrowseFilterBuilder
            columns={filterColumns}
            columnTypes={filterColumnTypes}
            onApply={handleApplyFilters}
            onClear={handleClearFilters}
          />
          {filterBadges}
        </div>
      </div>

      {isConnector ? (
        <ConnectorBrowser
          embedded
          readOnly
          projectId={projectId}
          connectorId={data.dsrc_id}
          provider={data.provider ?? data.connector_config?.provider}
          connectorScope={data.connector_scope ?? data.connector_config?.scope ?? null}
          configuredDatabase={
            typeof data.connector_config?.database === "string"
              ? data.connector_config.database
              : null
          }
          clientFilters={filters}
        />
      ) : (
        <VolumeBrowser
          embedded
          projectId={projectId}
          volumeId={data.dsrc_id}
          clientFilters={filters}
        />
      )}
    </div>
  );
}

export { DataSourceDetailDataPreview };

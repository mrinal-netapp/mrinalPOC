import { useState, useEffect, useMemo, useCallback, useRef, type ReactElement } from "react";
import { IconChevronRight, IconRefresh, IconSearch } from "@tabler/icons-react";

import { explorerList, type ExplorerNode } from "@/api/explorer-api";
import type { FilterCriteria } from "@/api/analytics-api";
import type { ResourceSelectorEntry } from "@/api/dataset.types";
import { resolveDataAccessModel, resolveEffectiveSelectionMode } from "@/consts/explorer-catalog";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { formatBytes } from "@/components/data-source/utils/data-source.utils";
import { applyBrowseFilters } from "@/components/data-source/preview/browse-filter.utils";
import {
  createConnectorBrowserColumns,
  createConnectorBrowserTableOptions,
  formatConnectorBrowseType,
  type ConnectorBrowserRow,
} from "./connector-browser.columns";
import "./connector-browser-dialog.scss";

// -- Props --

export interface ConnectorBrowserDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  connectorId: string;
  /** Connector provider id (s3, gcs, postgresql, gcp, ontap, …). */
  provider: string | null | undefined;
  /** Connector scope ('account' | 'resource'); selects the root listing. */
  connectorScope?: "account" | "resource" | null;
  /** Dialog heading. */
  title?: string;
  /** Returns the chosen nodes' `resource` payloads as resource-selector entries. */
  onAdd?: (entries: ResourceSelectorEntry[]) => void;
  /**
   * Read-only browse mode: hides selection + the Add action and shows only a
   * Close button. Used to inspect an already-added scope entry.
   */
  readOnly?: boolean;
  /**
   * When set, the browser opens pre-navigated *inside* this resource (one level
   * below the root), best-effort by the resource shape. Pairs with `readOnly`
   * for "view contents of this entry".
   */
  initialResource?: ResourceSelectorEntry | null;
  /** Breadcrumb label for the pre-navigated `initialResource` level. */
  initialResourceLabel?: string;
  /**
   * When set on a database connector, the explorer skips the database picker and
   * opens directly at schemas for this database.
   */
  configuredDatabase?: string | null;
}

interface ConnectorBrowserCommonProps {
  projectId: string;
  connectorId: string;
  provider: string | null | undefined;
  connectorScope?: "account" | "resource" | null;
  title?: string;
  onAdd?: (entries: ResourceSelectorEntry[]) => void;
  readOnly?: boolean;
  initialResource?: ResourceSelectorEntry | null;
  initialResourceLabel?: string;
  configuredDatabase?: string | null;
  /** Client-side filters applied to the current listing. */
  clientFilters?: FilterCriteria[];
}

export type ConnectorBrowserProps =
  | (ConnectorBrowserCommonProps & { embedded?: false; onClose: () => void })
  | (ConnectorBrowserCommonProps & { embedded: true; onClose?: () => void });

// -- Navigation helpers --

interface ExplorerLevel {
  action: string;
  payload: Record<string, unknown>;
  label: string;
}

function getConnectorBrowseCellValue(row: ConnectorBrowserRow, column: string): string | number | null {
  switch (column) {
    case "Name": return row.name;
    case "Type": return formatConnectorBrowseType(row);
    case "Details": return row.detail || null;
    default: return null;
  }
}

function getDefaultAction(node: ExplorerNode): string | null {
  if (node.actions && node.actions.length > 0) return node.actions[0];
  switch (node.type) {
    case "database": return "listSchemas";
    case "folder": return "listPath";
    case "schema": return "listTables";
    case "table":
    case "view": return "describeTable";
    case "service": return "listResources";
    case "resource": return "listPath";
    case "storagePool": return "listVolumes";
    case "cluster": return "listInstances";
    case "instance": return "listDatabases";
    case "volume": return "listSnapshots";
    case "svm": return "listVolumes";
    case "snapshot": return null;
    default: return null;
  }
}

function isNavigable(node: ExplorerNode): boolean {
  return node.childrenHint !== "leaf" && getDefaultAction(node) !== null;
}

function inferResourceLevel(
  resource: Record<string, unknown>,
): { action: string; payload: Record<string, unknown> } | null {
  if (typeof resource.table === "string" && resource.table) return { action: "describeTable", payload: resource };
  if (typeof resource.schema === "string" && resource.schema) return { action: "listTables", payload: resource };
  if (typeof resource.database === "string" && resource.database) return { action: "listSchemas", payload: resource };
  if (
    (typeof resource.bucket === "string" && resource.bucket) ||
    typeof resource.prefix === "string" ||
    typeof resource.path === "string"
  ) {
    return { action: "listPath", payload: resource };
  }
  return null;
}

function buildInitialLevels(
  rootAction: string,
  initialResource: ResourceSelectorEntry | null | undefined,
  initialResourceLabel: string | undefined,
  rootPayload: Record<string, unknown> = {},
  rootLabel = "/",
): ExplorerLevel[] {
  const root: ExplorerLevel = { action: rootAction, payload: rootPayload, label: rootLabel };
  if (!initialResource) return [root];
  const level = inferResourceLevel(initialResource as Record<string, unknown>);
  if (!level) return [root];
  return [root, { action: level.action, payload: level.payload, label: initialResourceLabel || "Selected" }];
}

function resolveExplorerRoot(
  model: ReturnType<typeof resolveDataAccessModel>,
  configuredDatabase: string | null | undefined,
): { action: string; payload: Record<string, unknown>; label: string } {
  const scopedDatabase = configuredDatabase?.trim();
  if (model.queryEditor && scopedDatabase) {
    return { action: "listSchemas", payload: { database: scopedDatabase }, label: scopedDatabase };
  }
  return { action: model.rootAction, payload: {}, label: "/" };
}

function nodeDetail(node: ExplorerNode): string {
  const size = node.metadata?.size;
  if (typeof size === "number" && size > 0) return formatBytes(size);
  const junction = node.metadata?.junction_path;
  if (typeof junction === "string" && junction) return junction;
  return "";
}

const TABLE_OPTIONS_EMBEDDED: BaseTableOptions = {
  enableColumnSorting: true,
  enablePagination: true,
};

function ConnectorBrowser(props: ConnectorBrowserProps): ReactElement {
  const {
    projectId,
    connectorId,
    provider,
    connectorScope,
    title = "Add datasource scope",
    onAdd,
    readOnly = false,
    initialResource,
    initialResourceLabel,
    configuredDatabase,
    clientFilters = [],
  } = props;
  const embedded = props.embedded === true;

  const closeBrowser = useCallback((): void => {
    if (props.embedded === true) {
      props.onClose?.();
    } else {
      props.onClose();
    }
  }, [props]);
  const model = useMemo(
    () => resolveDataAccessModel(provider, connectorScope),
    [provider, connectorScope],
  );
  const explorerRoot = useMemo(
    () => resolveExplorerRoot(model, configuredDatabase),
    [model, configuredDatabase],
  );

  const sessionId = useMemo(() => `direct-${connectorId}`, [connectorId]);

  const [regions, setRegions] = useState<{ id: string; label: string }[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<string>("");
  const [regionsResolved, setRegionsResolved] = useState(!model.hasRegionSelector);
  const regionCtx = useMemo<Record<string, unknown>>(
    () => (model.hasRegionSelector && selectedRegion ? { region: selectedRegion } : {}),
    [model.hasRegionSelector, selectedRegion],
  );

  const [levels, setLevels] = useState<ExplorerLevel[]>(
    () => buildInitialLevels(
      explorerRoot.action,
      initialResource,
      initialResourceLabel,
      explorerRoot.payload,
      explorerRoot.label,
    ),
  );
  const [nodes, setNodes] = useState<ExplorerNode[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const nodesByIdRef = useRef<Record<string, ExplorerNode>>({});

  const initialResourceKey = useMemo(
    () => JSON.stringify(initialResource ?? null),
    [initialResource],
  );

  const browseTargetKey = useMemo(
    () => JSON.stringify({
      projectId,
      connectorId,
      provider: provider ?? null,
      connectorScope: connectorScope ?? null,
      configuredDatabase: configuredDatabase ?? null,
      initialResourceLabel: initialResourceLabel ?? null,
      initialResourceKey,
      rootAction: explorerRoot.action,
      rootPayload: explorerRoot.payload,
    }),
    [
      projectId,
      connectorId,
      provider,
      connectorScope,
      configuredDatabase,
      initialResourceLabel,
      initialResourceKey,
      explorerRoot.action,
      explorerRoot.payload,
    ],
  );

  const browseTargetRef = useRef(browseTargetKey);

  useEffect(() => {
    if (browseTargetRef.current === browseTargetKey) return;
    browseTargetRef.current = browseTargetKey;
    setLevels(buildInitialLevels(
      explorerRoot.action,
      initialResource,
      initialResourceLabel,
      explorerRoot.payload,
      explorerRoot.label,
    ));
    setNodes([]);
    setErrorMessage(null);
    setSelectedIds({});
    setSearchOpen(false);
    setSearchQuery("");
    nodesByIdRef.current = {};
  }, [browseTargetKey, explorerRoot.action, explorerRoot.label, explorerRoot.payload, initialResource, initialResourceLabel]);

  const fetchNodes = useCallback(
    async (action: string, payload: Record<string, unknown>) => {
      setIsFetching(true);
      setErrorMessage(null);
      try {
        const resp = await explorerList(
          sessionId,
          action,
          { ...regionCtx, ...payload },
          { projectId, connectorId },
        );
        if (resp.error) {
          setNodes([]);
          setErrorMessage(`${resp.error.code}: ${resp.error.message}`);
          return;
        }
        const next = resp.nodes ?? [];
        for (const n of next) nodesByIdRef.current[n.id] = n;
        setNodes(next);
      } catch (err) {
        setNodes([]);
        setErrorMessage(err instanceof Error ? err.message : "Failed to list connector resources");
      } finally {
        setIsFetching(false);
      }
    },
    [sessionId, regionCtx, projectId, connectorId],
  );

  useEffect(() => {
    let cancelled = false;
    if (!model.hasRegionSelector) {
      setRegionsResolved(true);
      return;
    }

    setRegionsResolved(false);
    setRegions([]);
    setSelectedRegion("");

    (async () => {
      try {
        const resp = await explorerList(sessionId, "listRegions", {}, { projectId, connectorId });
        if (cancelled) return;
        if (!resp.error) {
          const list = (resp.nodes ?? []).map((n) => ({
            id: (n.resource?.region as string) || n.label,
            label: n.label,
          }));
          setRegions(list);
          setSelectedRegion(list[0]?.id ?? "");
        }
      } catch {
        /* region load is best-effort; root listing still attempts below */
      } finally {
        if (!cancelled) {
          setRegionsResolved(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [model.hasRegionSelector, sessionId, projectId, connectorId]);

  const currentLevel = levels[levels.length - 1];
  useEffect(() => {
    if (model.hasRegionSelector && !regionsResolved) return;
    if (levels[0]?.action !== explorerRoot.action) return;
    void fetchNodes(currentLevel.action, currentLevel.payload);
  }, [currentLevel, explorerRoot.action, fetchNodes, levels, model.hasRegionSelector, regionsResolved]);

  const handleNavigate = useCallback((row: ConnectorBrowserRow) => {
    const action = getDefaultAction(row.node);
    if (!action) return;
    setLevels((prev) => [
      ...prev,
      { action, payload: { ...(row.node.resource ?? {}) }, label: row.name },
    ]);
  }, []);

  const handleBreadcrumbClick = useCallback((index: number) => {
    setLevels((prev) => prev.slice(0, index + 1));
  }, []);

  const columns = useMemo(() => createConnectorBrowserColumns(handleNavigate), [handleNavigate]);
  const effectiveSelectionMode = useMemo(
    () => resolveEffectiveSelectionMode(model, currentLevel.action),
    [model, currentLevel.action],
  );
  const tableOptions = useMemo(() => {
    if (embedded) {
      return { ...TABLE_OPTIONS_EMBEDDED, enableRowSelection: false };
    }
    const base = createConnectorBrowserTableOptions(effectiveSelectionMode);
    return readOnly ? { ...base, enableRowSelection: false } : base;
  }, [embedded, effectiveSelectionMode, readOnly]);

  const selectableTypes = useMemo(() => new Set(model.selectableTypes), [model.selectableTypes]);

  const tableData: ConnectorBrowserRow[] = useMemo(
    () => nodes.map((node) => ({
      id: node.id,
      name: node.label,
      nodeType: node.type,
      kind: node.kind ?? "",
      navigable: isNavigable(node),
      selectable: selectableTypes.has(node.type) && Boolean(node.resource),
      detail: nodeDetail(node),
      node,
    })),
    [nodes, selectableTypes],
  );

  const filteredTableData = useMemo(
    () => applyBrowseFilters(tableData, clientFilters, getConnectorBrowseCellValue),
    [tableData, clientFilters],
  );

  const displayedTableData = useMemo(() => {
    if (!embedded || !searchOpen || !searchQuery.trim()) return filteredTableData;
    const query = searchQuery.trim().toLowerCase();
    return filteredTableData.filter((row) => row.name.toLowerCase().includes(query));
  }, [embedded, filteredTableData, searchOpen, searchQuery]);

  const tableDataForRender = embedded ? displayedTableData : filteredTableData;

  const handleRowSelectionChange = useCallback((selection: Record<string, boolean>) => {
    setSelectedIds(selection);
  }, []);

  const dialogBreadcrumbs = (
    <nav className="connector-browser-dialog__breadcrumbs" aria-label="Connector path">
      {levels.map((level, idx) => {
        const isLast = idx === levels.length - 1;
        return (
          <span key={idx} className="connector-browser-dialog__breadcrumb-item">
            {idx > 0 && (
              <IconChevronRight size={14} className="connector-browser-dialog__breadcrumb-separator" aria-hidden focusable={false} />
            )}
            <button
              type="button"
              className="connector-browser-dialog__breadcrumb-segment"
              onClick={() => handleBreadcrumbClick(idx)}
              disabled={isLast}
            >
              <Typography
                Component="span"
                fontSize="fs14"
                boldness={isLast ? "semibold" : "regular"}
                color={isLast ? undefined : "var(--text-button-primary)"}
              >
                {level.label}
              </Typography>
            </button>
          </span>
        );
      })}
    </nav>
  );

  const embeddedBreadcrumbs = (
    <nav className="ds-preview-browser__breadcrumbs" aria-label="Connector path">
      {levels.map((level, idx) => {
        const isLast = idx === levels.length - 1;
        return (
          <span key={idx} className="ds-preview-browser__breadcrumb-item">
            {idx > 0 && (
              <span className="ds-preview-browser__breadcrumb-sep" aria-hidden="true">&gt;</span>
            )}
            <button
              type="button"
              className="ds-preview-browser__breadcrumb-segment"
              onClick={() => handleBreadcrumbClick(idx)}
              disabled={isLast}
            >
              <Typography
                Component="span"
                fontSize="fs13"
                boldness={isLast ? "semibold" : "regular"}
                color={isLast ? "var(--text-primary)" : "var(--text-button-primary)"}
              >
                {level.label}
              </Typography>
            </button>
          </span>
        );
      })}
    </nav>
  );

  const selectedEntries = useMemo<ResourceSelectorEntry[]>(() => {
    return Object.keys(selectedIds)
      .filter((id) => selectedIds[id])
      .map((id) => nodesByIdRef.current[id]?.resource)
      .filter((r): r is ResourceSelectorEntry => Boolean(r));
  }, [selectedIds]);

  const selectedCount = selectedEntries.length;

  const handleAdd = useCallback(() => {
    onAdd?.(selectedEntries);
    closeBrowser();
  }, [selectedEntries, onAdd, closeBrowser]);

  const footerActions = readOnly
    ? [{ variant: "outline" as const, size: "medium" as const, label: "Close", onClick: closeBrowser }]
    : [
        {
          variant: "solid" as const,
          size: "medium" as const,
          label: selectedCount > 0 ? `Add (${selectedCount})` : "Add",
          onClick: handleAdd,
          isDisabled: selectedCount === 0,
        },
        { variant: "outline" as const, size: "medium" as const, label: "Cancel", onClick: closeBrowser },
      ];

  const tableElement = (
    <BaseTable<ConnectorBrowserRow>
      options={tableOptions}
      data={tableDataForRender}
      columns={columns}
      isLoading={isFetching}
      isError={Boolean(errorMessage)}
      onRowSelectionChange={embedded || readOnly ? undefined : handleRowSelectionChange}
    />
  );

  const regionSelector = model.hasRegionSelector ? (
    <div className="ds-preview-browser__region">
      <label className="connector-browser-dialog__region">
        <Typography Component="span" fontSize="fs14" boldness="semibold">Region</Typography>
        <select
          className="connector-browser-dialog__region-select"
          value={selectedRegion}
          onChange={(e) => {
            setSelectedRegion(e.target.value);
            setLevels([{ action: model.rootAction, payload: {}, label: "/" }]);
          }}
        >
          {regions.length === 0 && (
            <option value="">
              {regionsResolved ? "No regions available" : "Loading regions…"}
            </option>
          )}
          {regions.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </label>
    </div>
  ) : null;

  if (embedded) {
    return (
      <div className="ds-preview-browser">
        {regionSelector}
        <div className="ds-preview-browser__toolbar">
          {embeddedBreadcrumbs}
          <div className="ds-preview-browser__toolbar-actions">
            <button
              type="button"
              className="ds-preview-browser__toolbar-btn"
              onClick={() => setSearchOpen((open) => !open)}
              title="Search"
              aria-label="Search"
              aria-pressed={searchOpen}
            >
              <IconSearch size={16} />
            </button>
            <button
              type="button"
              className="ds-preview-browser__toolbar-btn"
              onClick={() => fetchNodes(currentLevel.action, currentLevel.payload)}
              disabled={isFetching || (model.hasRegionSelector && !regionsResolved)}
              title="Refresh"
              aria-label="Refresh"
            >
              <IconRefresh size={16} />
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="ds-preview-browser__search-row">
            <input
              className="ds-preview-browser__search-input"
              type="search"
              placeholder="Search by name"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search connector resources"
            />
          </div>
        )}

        {errorMessage && (
          <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--notification-error)" className="ds-preview-browser__message">
            {errorMessage}
          </Typography>
        )}

        <div className="ds-preview-browser__table">
          {tableElement}
        </div>
      </div>
    );
  }

  const browseContent = (
    <>
      <CardBlock type="description">
        <Typography Component="p" fontSize="fs14" boldness="regular">
          {readOnly
            ? "Browsing the contents of this scope entry."
            : "Browse the connector and choose resources to add to this dataset."}
        </Typography>
      </CardBlock>

      {model.hasRegionSelector && (
        <CardBlock type="description">
          <label className="connector-browser-dialog__region">
            <Typography Component="span" fontSize="fs14" boldness="semibold">Region</Typography>
            <select
              className="connector-browser-dialog__region-select"
              value={selectedRegion}
              onChange={(e) => {
                setSelectedRegion(e.target.value);
                setLevels([{ action: model.rootAction, payload: {}, label: "/" }]);
              }}
            >
              {regions.length === 0 && (
                <option value="">
                  {regionsResolved ? "No regions available" : "Loading regions…"}
                </option>
              )}
              {regions.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </label>
        </CardBlock>
      )}

      <CardBlock type="list">
        {dialogBreadcrumbs}
        {tableElement}
        {errorMessage && (
          <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--notification-error)">
            {errorMessage}
          </Typography>
        )}
      </CardBlock>
    </>
  );

  return (
    <Card>
      <CardHeader title={title} hasSeparator />
      <CardContent>{browseContent}</CardContent>
      <CardFooter hasSeparator alignment="end" actions={footerActions} />
    </Card>
  );
}

function ConnectorBrowserDialog({
  open,
  onClose,
  projectId,
  connectorId,
  provider,
  connectorScope,
  title = "Add datasource scope",
  onAdd,
  readOnly,
  initialResource,
  initialResourceLabel,
  configuredDatabase,
}: ConnectorBrowserDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="connector-browser-dialog">
        {open && (
          <ConnectorBrowser
            onClose={onClose}
            projectId={projectId}
            connectorId={connectorId}
            provider={provider}
            connectorScope={connectorScope}
            title={title}
            onAdd={onAdd}
            readOnly={readOnly}
            initialResource={initialResource}
            initialResourceLabel={initialResourceLabel}
            configuredDatabase={configuredDatabase}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

export { ConnectorBrowser, ConnectorBrowserDialog };

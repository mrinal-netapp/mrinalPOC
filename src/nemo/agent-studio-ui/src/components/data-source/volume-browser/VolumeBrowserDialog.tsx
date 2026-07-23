import { useState, useCallback, useEffect, useMemo, type ReactElement } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { IconChevronRight, IconRefresh, IconSearch } from '@tabler/icons-react';

import {
  Dialog,
  DialogPopup,
} from '@/ui-lib/base-components/dialog/dialog';
import type { FilterCriteria } from '@/api/analytics-api';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardHeader } from '@/ui-lib/base-components/card/card.header';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlock } from '@/ui-lib/base-components/card/card.block';
import { CardFooter } from '@/ui-lib/base-components/card/card.footer';
import { BaseTable } from '@/ui-lib/base-components/baseTableMcpBxp';
import type { BaseElement, BaseTableOptions } from '@/ui-lib/base-components/baseTableMcpBxp';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { volumeBrowse, type VolumeDirEntry, type VolumeBrowseResult } from '@/api/workflow-api';
import { formatBytes } from '@/components/data-source/utils/data-source.utils';
import { applyBrowseFilters } from '@/components/data-source/preview/browse-filter.utils';
import './VolumeBrowserDialog.scss';

// -- Row type --

interface VolumeBrowserRow extends BaseElement {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  lastModified: string;
}

function getVolumeBrowseCellValue(row: VolumeBrowserRow, column: string): string | number | null {
  switch (column) {
    case 'Name': return row.name;
    case 'Type': return row.type === 'directory' ? 'Folder' : 'File';
    case 'Size': return row.type === 'file' ? row.size : null;
    case 'Last modified': return row.lastModified || null;
    default: return null;
  }
}

// -- Columns --

function createVolumeBrowserColumns(
  onFolderClick: (row: VolumeBrowserRow) => void,
): ColumnDef<VolumeBrowserRow>[] {
  return [
    {
      accessorKey: 'name',
      header: 'Name',
      size: 300,
      minSize: 200,
      cell: ({ row }) => {
        const { type, name } = row.original;
        if (type === 'directory') {
          return (
            <button
              type="button"
              className="ds-name-link"
              onClick={() => onFolderClick(row.original)}
            >
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                {name}
              </Typography>
            </button>
          );
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {name}
          </Typography>
        );
      },
    },
    {
      accessorKey: 'type',
      header: 'Type',
      size: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.type === 'directory' ? 'Folder' : 'File'}
        </Typography>
      ),
    },
    {
      accessorKey: 'size',
      header: 'Size',
      size: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.type === 'file'
            ? formatBytes(row.original.size)
            : '–'}
        </Typography>
      ),
    },
    {
      accessorKey: 'lastModified',
      header: 'Last modified',
      size: 200,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.lastModified
            ? new Date(row.original.lastModified).toLocaleString()
            : '–'}
        </Typography>
      ),
    },
  ];
}

const TABLE_OPTIONS_READONLY: BaseTableOptions = {
  enableColumnSorting: true,
};

const TABLE_OPTIONS_SELECT: BaseTableOptions = {
  enableColumnSorting: true,
  enableRowSelection: (row) => 'type' in row && (row as VolumeBrowserRow).type === 'directory',
  enableRowMultiSelection: true,
};

const TABLE_OPTIONS_EMBEDDED: BaseTableOptions = {
  enableColumnSorting: true,
  enablePagination: true,
};

// -- Types --

interface VolumeBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Data-source ID of the volume. */
  volumeId: string;
  /** Human-readable name of the volume. Currently not displayed in the header. */
  volumeName: string;
  /** Initial sub-path to open (default: root). */
  initialPath?: string;
  /**
   * Dialog heading. Defaults to "Add datasource scope" in add mode (when
   * `onAdd` is set) and "Data Source Overview" in read-only mode.
   */
  title?: string;
  /**
   * When provided, enables multi-selection of directories and shows an Add
   * button. The callback receives the selected folder paths.
   */
  onAdd?: (selectedPaths: string[]) => void;
}

interface VolumeBrowserCommonProps {
  projectId: string;
  volumeId: string;
  initialPath?: string;
  title?: string;
  onAdd?: (selectedPaths: string[]) => void;
  /** Client-side filters applied to the current directory listing. */
  clientFilters?: FilterCriteria[];
}

export type VolumeBrowserProps =
  | (VolumeBrowserCommonProps & { embedded?: false; onClose: () => void })
  | (VolumeBrowserCommonProps & { embedded: true; onClose?: () => void });

function VolumeBrowser(props: VolumeBrowserProps): ReactElement {
  const {
    projectId,
    volumeId,
    initialPath = '',
    title,
    onAdd,
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
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<VolumeDirEntry[]>([]);
  const [browseResult, setBrowseResult] = useState<VolumeBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [selectedRowIds, setSelectedRowIds] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadDirectory = useCallback(async (subPath: string) => {
    const normalizedPath = subPath === "/" ? "" : subPath;
    setLoading(true);
    setIsError(false);
    setBrowseResult(null);
    try {
      const result = await volumeBrowse(projectId, volumeId, normalizedPath);
      setEntries(result.entries ?? []);
      setCurrentPath(normalizedPath);
      setBrowseResult(result);
    } catch {
      setIsError(true);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, volumeId]);

  useEffect(() => {
    const normalizedInitialPath = initialPath === "/" ? "" : initialPath;
    setEntries([]);
    setBrowseResult(null);
    setIsError(false);
    setSelectedRowIds({});
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentPath(normalizedInitialPath);
    void loadDirectory(initialPath);
  }, [projectId, volumeId, initialPath, loadDirectory]);

  const pathSegments = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const navigateTo = useCallback((subPath: string) => loadDirectory(subPath), [loadDirectory]);

  const handleBreadcrumbClick = useCallback((index: number) => {
    const segs = pathSegments.slice(0, index);
    navigateTo(segs.join('/'));
    setSelectedRowIds({});
  }, [pathSegments, navigateTo]);

  const handleFolderClick = useCallback((row: VolumeBrowserRow) => {
    navigateTo(row.path);
    setSelectedRowIds({});
  }, [navigateTo]);

  const handleRowSelectionChange = useCallback((selection: Record<string, boolean>) => {
    const dirPaths = new Set(entries.filter((e) => e.type === 'directory').map((e) => e.path));
    const filtered: Record<string, boolean> = {};
    for (const [id, selected] of Object.entries(selection)) {
      if (selected && dirPaths.has(id)) filtered[id] = true;
    }
    setSelectedRowIds(filtered);
  }, [entries]);

  const handleAdd = useCallback(() => {
    const selected = Object.keys(selectedRowIds).filter((id) => selectedRowIds[id]);
    onAdd?.(selected);
    closeBrowser();
  }, [selectedRowIds, onAdd, closeBrowser]);

  const tableData: VolumeBrowserRow[] = useMemo(
    () => entries.map((e) => ({ ...e, id: e.path || e.name })),
    [entries],
  );

  const filteredTableData = useMemo(
    () => applyBrowseFilters(tableData, clientFilters, getVolumeBrowseCellValue),
    [tableData, clientFilters],
  );

  const displayedTableData = useMemo(() => {
    if (!embedded || !searchOpen || !searchQuery.trim()) return filteredTableData;
    const query = searchQuery.trim().toLowerCase();
    return filteredTableData.filter((row) => row.name.toLowerCase().includes(query));
  }, [embedded, filteredTableData, searchOpen, searchQuery]);

  const columns = useMemo(
    () => createVolumeBrowserColumns(handleFolderClick),
    [handleFolderClick],
  );

  const tableOptions = useMemo((): BaseTableOptions => {
    if (embedded) {
      return TABLE_OPTIONS_EMBEDDED;
    }
    return onAdd ? TABLE_OPTIONS_SELECT : TABLE_OPTIONS_READONLY;
  }, [embedded, onAdd]);

  const truncText = browseResult?.truncated
    ? `Too many items — showing first ${entries.length.toLocaleString()} entries. Navigate into a subfolder for a full listing.`
    : undefined;

  const browseMessage = browseResult?.error
    ? "This directory isn't available yet."
    : undefined;

  const dialogBreadcrumbs = (
    <nav className="vol-browser__breadcrumbs" aria-label="Folder path">
      <button
        type="button"
        className="vol-browser__breadcrumb-segment"
        onClick={() => handleBreadcrumbClick(0)}
        disabled={pathSegments.length === 0}
      >
        <Typography
          Component="span"
          fontSize="fs14"
          boldness={pathSegments.length === 0 ? 'semibold' : 'regular'}
          color={pathSegments.length === 0 ? undefined : 'var(--text-button-primary)'}
        >
          /
        </Typography>
      </button>

      {pathSegments.map((seg, idx) => {
        const isLast = idx === pathSegments.length - 1;
        return (
          <span key={idx} className="vol-browser__breadcrumb-item">
            <IconChevronRight size={14} className="vol-browser__breadcrumb-sep" aria-hidden focusable={false} />
            <button
              type="button"
              className="vol-browser__breadcrumb-segment"
              onClick={() => handleBreadcrumbClick(idx + 1)}
              disabled={isLast}
            >
              <Typography
                Component="span"
                fontSize="fs14"
                boldness={isLast ? 'semibold' : 'regular'}
                color={isLast ? undefined : 'var(--text-button-primary)'}
              >
                {seg}
              </Typography>
            </button>
          </span>
        );
      })}
    </nav>
  );

  const embeddedBreadcrumbs = (
    <nav className="ds-preview-browser__breadcrumbs" aria-label="Folder path">
      <button
        type="button"
        className="ds-preview-browser__breadcrumb-segment"
        onClick={() => handleBreadcrumbClick(0)}
        disabled={pathSegments.length === 0}
      >
        <Typography
          Component="span"
          fontSize="fs13"
          boldness={pathSegments.length === 0 ? 'semibold' : 'regular'}
          color={pathSegments.length === 0 ? 'var(--text-primary)' : 'var(--text-button-primary)'}
        >
          /
        </Typography>
      </button>

      {pathSegments.map((seg, idx) => {
        const isLast = idx === pathSegments.length - 1;
        return (
          <span key={idx} className="ds-preview-browser__breadcrumb-item">
            <span className="ds-preview-browser__breadcrumb-sep" aria-hidden="true">&gt;</span>
            <button
              type="button"
              className="ds-preview-browser__breadcrumb-segment"
              onClick={() => handleBreadcrumbClick(idx + 1)}
              disabled={isLast}
            >
              <Typography
                Component="span"
                fontSize="fs13"
                boldness={isLast ? 'semibold' : 'regular'}
                color={isLast ? 'var(--text-primary)' : 'var(--text-button-primary)'}
              >
                {seg}
              </Typography>
            </button>
          </span>
        );
      })}
    </nav>
  );

  const tableDataForRender = embedded ? displayedTableData : filteredTableData;

  const embeddedWarnings = (
    <>
      {browseMessage && (
        <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--notification-warning)" className="ds-preview-browser__message">
          {browseMessage}
        </Typography>
      )}
      {truncText && (
        <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--notification-warning)" className="ds-preview-browser__message">
          {truncText}
        </Typography>
      )}
    </>
  );

  const tableElement = (
    <BaseTable<VolumeBrowserRow>
      options={tableOptions}
      data={tableDataForRender}
      columns={columns}
      isLoading={loading}
      isError={isError}
      onRowSelectionChange={onAdd ? handleRowSelectionChange : undefined}
    />
  );

  if (embedded) {
    return (
      <div className="ds-preview-browser">
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
              onClick={() => loadDirectory(currentPath)}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh"
            >
              <IconRefresh size={16} />
            </button>
          </div>
        </div>

        {embeddedWarnings}

        {searchOpen && (
          <div className="ds-preview-browser__search-row">
            <input
              className="ds-preview-browser__search-input"
              type="search"
              placeholder="Search by name"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search files and folders"
            />
          </div>
        )}

        <div className="ds-preview-browser__table">
          {tableElement}
        </div>
      </div>
    );
  }

  const tableBlock = (
    <>
      {browseMessage && (
        <CardBlock type="description">
          <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--notification-warning)">
            {browseMessage}
          </Typography>
        </CardBlock>
      )}

      {truncText && (
        <CardBlock type="description">
          <Typography Component="p" fontSize="fs13" boldness="regular" color="var(--notification-warning)">
            {truncText}
          </Typography>
        </CardBlock>
      )}

      <CardBlock type="list">
        {dialogBreadcrumbs}
        {tableElement}
      </CardBlock>
    </>
  );

  return (
    <Card>
      <CardHeader
        title={title ?? (onAdd ? "Add datasource scope" : "Data Source Overview")}
        hasSeparator
        actions={[
          <button
            key="refresh"
            type="button"
            className="vol-browser__refresh-btn"
            onClick={() => loadDirectory(currentPath)}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
          >
            <IconRefresh size={16} />
          </button>,
        ]}
      />
      <CardContent>{tableBlock}</CardContent>
      <CardFooter
        hasSeparator
        alignment="end"
        actions={
          onAdd
            ? [
                { variant: 'solid', size: 'medium', label: 'Add', onClick: handleAdd },
                { variant: 'outline', size: 'medium', label: 'Cancel', onClick: closeBrowser },
              ]
            : [{ variant: 'outline', size: 'medium', label: 'Close', onClick: closeBrowser }]
        }
      />
    </Card>
  );
}

function VolumeBrowserDialog({
  open,
  onOpenChange,
  projectId,
  volumeId,
  initialPath = '',
  title,
  onAdd,
}: VolumeBrowserDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onOpenChange(false); }}
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="vol-browser__popup">
        {open && (
          <VolumeBrowser
            onClose={() => onOpenChange(false)}
            projectId={projectId}
            volumeId={volumeId}
            initialPath={initialPath}
            title={title}
            onAdd={onAdd}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

export { VolumeBrowser, VolumeBrowserDialog };
export type { VolumeBrowserDialogProps };

import { useState, useEffect, useMemo, useCallback, type ReactElement } from "react";
import { IconChevronRight } from "@tabler/icons-react";

import { useLazyBrowseQuery } from "@/api/utilities-api.slice";
import type { BrowseItem } from "@/api/utilities.types";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { formatNumber, formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import {
  createFolderBrowserColumns,
  FOLDER_BROWSER_TABLE_OPTIONS,
  FOLDER_BROWSER_TABLE_OPTIONS_READONLY,
} from "./folder-browser.columns";
import type { FolderBrowserRow } from "./folder-browser.columns";
import "./folder-browser-dialog.scss";

// -- Props --

interface FolderBrowserDialogProps {
  open: boolean;
  onClose: () => void;
  datasourceId: string;
  rootPath?: string;
  isReadOnly: boolean;
  totalFiles?: number | null;
  lastCompletedAt?: string | null;
  onAdd?: (selectedPaths: string[]) => void;
}

// -- Helpers --

function buildSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function buildPath(segments: string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

// -- Inner component: mounted fresh each time the dialog opens --

interface FolderBrowserContentProps {
  onClose: () => void;
  datasourceId: string;
  rootPath: string;
  isReadOnly: boolean;
  totalFiles?: number | null;
  lastCompletedAt?: string | null;
  onAdd?: (selectedPaths: string[]) => void;
}

function FolderBrowserContent({
  onClose,
  datasourceId,
  rootPath,
  isReadOnly,
  totalFiles,
  lastCompletedAt,
  onAdd,
}: FolderBrowserContentProps): ReactElement {
  const [breadcrumbSegments, setBreadcrumbSegments] = useState<string[]>(() => buildSegments(rootPath));
  const [selectedRowIds, setSelectedRowIds] = useState<Record<string, boolean>>({});
  const [allItems, setAllItems] = useState<BrowseItem[]>([]);
  const [browseError, setBrowseError] = useState(false);

  const currentPath = useMemo(() => buildPath(breadcrumbSegments), [breadcrumbSegments]);

  const [triggerBrowse, { isFetching }] = useLazyBrowseQuery();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let accumulated: BrowseItem[] = [];
      let continuationToken: string | undefined;

      try {
        do {
          const result = await triggerBrowse({ datasourceId, path: currentPath, continuationToken }).unwrap();
          accumulated = [...accumulated, ...result.items];
          continuationToken = result.nextContinuationToken;
        } while (continuationToken && !cancelled);

        if (!cancelled) {
          setAllItems(accumulated);
          setBrowseError(false);
        }
      } catch {
        /* v8 ignore next 4 -- @preserve cancelled=true inside catch requires unmount mid-rejection; both error states tested */
        if (!cancelled) {
          setAllItems([]);
          setBrowseError(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [currentPath, datasourceId, triggerBrowse]);

  // -- Breadcrumb navigation --

  const handleBreadcrumbClick = useCallback((index: number) => {
    setBreadcrumbSegments((prev) => prev.slice(0, index));
    setSelectedRowIds({});
  }, []);

  // -- Folder click (navigate deeper) --

  const handleFolderClick = useCallback((row: FolderBrowserRow) => {
    setBreadcrumbSegments((prev) => [...prev, row.name]);
    setSelectedRowIds({});
  }, []);

  // -- Table data --

  const columns = useMemo(() => createFolderBrowserColumns(handleFolderClick), [handleFolderClick]);

  const tableData: FolderBrowserRow[] = useMemo(
    () => allItems.map((item) => ({ ...item, id: item.path })),
    [allItems],
  );

  const tableOptions = isReadOnly ? FOLDER_BROWSER_TABLE_OPTIONS_READONLY : FOLDER_BROWSER_TABLE_OPTIONS;

  const handleRowSelectionChange = useCallback(
    (selection: Record<string, boolean>) => {
      const folderPaths = new Set(allItems.filter((i) => i.type === "directory").map((i) => i.path));
      const filtered: Record<string, boolean> = {};
      for (const [id, selected] of Object.entries(selection)) {
        if (selected && folderPaths.has(id)) {
          filtered[id] = true;
        }
      }
      setSelectedRowIds(filtered);
    },
    [allItems],
  );

  // -- Footer actions --

  const handleAdd = useCallback(() => {
    const selectedPaths = Object.keys(selectedRowIds).filter((id) => selectedRowIds[id]);
    onAdd?.(selectedPaths);
    onClose();
  }, [selectedRowIds, onAdd, onClose]);

  const footerActions = isReadOnly
    ? [{ variant: "outline" as const, size: "medium" as const, label: "Close", onClick: onClose }]
    : [
        { variant: "solid" as const, size: "medium" as const, label: "Add", onClick: handleAdd },
        { variant: "outline" as const, size: "medium" as const, label: "Cancel", onClick: onClose },
      ];

  // -- Info line --

  const infoText = isReadOnly
    ? `${formatNumber(totalFiles ?? null)} files are identified based on the scan on ${lastCompletedAt ? formatDateTimeFull(lastCompletedAt) : "-"}.`
    : "Browse the file tree and choose folders to add to this dataset.";

  const title = isReadOnly ? "Folder overview" : "Add datasource scope";

  return (
    <Card>
      <CardHeader title={title} hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <Typography Component="p" fontSize="fs14" boldness="regular">
            {infoText}
          </Typography>
        </CardBlock>

        <CardBlock type="list">
          <nav className="folder-browser-dialog__breadcrumbs" aria-label="Folder path">
            <button
              type="button"
              className="folder-browser-dialog__breadcrumb-segment"
              onClick={() => handleBreadcrumbClick(0)}
              disabled={breadcrumbSegments.length === 0}
            >
              <Typography
                Component="span"
                fontSize="fs14"
                boldness={breadcrumbSegments.length === 0 ? "semibold" : "regular"}
                color={breadcrumbSegments.length === 0 ? undefined : "var(--text-button-primary)"}
              >
                /
              </Typography>
            </button>
            {breadcrumbSegments.map((segment, idx) => {
              const isLast = idx === breadcrumbSegments.length - 1;
              return (
                <span key={idx} className="folder-browser-dialog__breadcrumb-item">
                  <IconChevronRight size={14} className="folder-browser-dialog__breadcrumb-separator" />
                  <button
                    type="button"
                    className="folder-browser-dialog__breadcrumb-segment"
                    onClick={() => handleBreadcrumbClick(idx + 1)}
                    disabled={isLast}
                  >
                    <Typography
                      Component="span"
                      fontSize="fs14"
                      boldness={isLast ? "semibold" : "regular"}
                      color={isLast ? undefined : "var(--text-button-primary)"}
                    >
                      {segment}
                    </Typography>
                  </button>
                </span>
              );
            })}
          </nav>

          <BaseTable<FolderBrowserRow>
            options={tableOptions}
            data={tableData}
            columns={columns}
            isLoading={isFetching}
            isError={browseError}
            onRowSelectionChange={isReadOnly ? undefined : handleRowSelectionChange}
          />
        </CardBlock>
      </CardContent>
      <CardFooter hasSeparator alignment="end" actions={footerActions} />
    </Card>
  );
}

// -- Outer shell: controls Dialog open/close, remounts content on each open --

function FolderBrowserDialog({
  open,
  onClose,
  datasourceId,
  rootPath = "/",
  isReadOnly,
  totalFiles,
  lastCompletedAt,
  onAdd,
}: FolderBrowserDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      /* v8 ignore start -- Base UI only fires onOpenChange to close (nextOpen=false); the true branch is unreachable */
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      /* v8 ignore stop */
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="folder-browser-dialog">
        {open && (
          <FolderBrowserContent
            onClose={onClose}
            datasourceId={datasourceId}
            rootPath={rootPath}
            isReadOnly={isReadOnly}
            totalFiles={totalFiles}
            lastCompletedAt={lastCompletedAt}
            onAdd={onAdd}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

export { FolderBrowserDialog };
export type { FolderBrowserDialogProps };

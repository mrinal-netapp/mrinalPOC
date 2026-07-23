import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExplorerList = vi.fn();

vi.mock("@/api/explorer-api", () => ({
  explorerList: (...args: unknown[]) => mockExplorerList(...args),
}));

vi.mock("@/components/data-source/utils/data-source.utils", () => ({
  formatBytes: (value: number) => `${value} bytes`,
}));

vi.mock("@/ui-lib/base-components/dialog/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <div data-testid="dialog" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>dismiss-dialog</button>
      {children}
    </div>
  ),
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card.header", () => ({
  CardHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/ui-lib/base-components/card/card.content", () => ({
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card.block", () => ({
  CardBlock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/ui-lib/base-components/card/card.footer", () => ({
  CardFooter: ({
    actions,
  }: {
    actions: Array<{ label: string; onClick: () => void; isDisabled?: boolean }>;
  }) => (
    <div>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={Boolean(action.isDisabled)}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@/ui-lib/base-components/typography/typography", () => ({
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    columns,
    isLoading,
    isError,
    onRowSelectionChange,
    options,
  }: {
    data: Array<{ id: string }>;
    columns: Array<{ cell?: (arg: unknown) => ReactNode }>;
    isLoading: boolean;
    isError: boolean;
    onRowSelectionChange?: (selection: Record<string, boolean>) => void;
    options?: { enableRowMultiSelection?: boolean; enablePagination?: boolean; enableTableTopBar?: boolean };
  }) => (
    <div
      data-testid="base-table"
      data-loading={String(isLoading)}
      data-error={String(isError)}
      data-multi={String(Boolean(options?.enableRowMultiSelection))}
      data-pagination={String(Boolean(options?.enablePagination))}
      data-topbar={String(Boolean(options?.enableTableTopBar))}
    >
      <button
        type="button"
        onClick={() => onRowSelectionChange?.(Object.fromEntries(data.map((row) => [row.id, true])))}
      >
        select-all
      </button>
      {data.map((row) => (
        <div key={row.id} data-testid={`row-${row.id}`}>
          {columns.map((column, index) => (
            <div key={`${row.id}-${index}`}>
              {typeof column.cell === "function"
                ? column.cell({ row: { original: row } } as never)
                : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import { ConnectorBrowser, ConnectorBrowserDialog } from "./connector-browser-dialog";

function renderDialog(
  props: Partial<ComponentProps<typeof ConnectorBrowserDialog>> = {},
): void {
  render(
    <ConnectorBrowserDialog
      open
      onClose={vi.fn()}
      projectId="proj-1"
      connectorId="connector-1"
      provider="s3"
      {...props}
    />,
  );
}

describe("ConnectorBrowserDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:connector-browser] navigates using connector-supplied actions first", async () => {
    mockExplorerList
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "node-service",
            label: "Node Service",
            type: "service",
            resource: { service: "svc-1" },
            actions: ["customList"],
          },
        ],
      })
      .mockResolvedValueOnce({ nodes: [] });

    renderDialog();

    await userEvent.click(await screen.findByRole("button", { name: "Node Service" }));

    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenLastCalledWith(
        "direct-connector-1",
        "customList",
        { service: "svc-1" },
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
  });

  it.each([
    ["database", "listSchemas"],
    ["folder", "listPath"],
    ["schema", "listTables"],
    ["table", "describeTable"],
    ["view", "describeTable"],
    ["service", "listResources"],
    ["resource", "listPath"],
    ["storagePool", "listVolumes"],
    ["cluster", "listInstances"],
    ["instance", "listDatabases"],
    ["volume", "listSnapshots"],
    ["svm", "listVolumes"],
  ])(
    "[tag:connector-browser] navigates %s nodes with the default %s action",
    async (nodeType, expectedAction) => {
      mockExplorerList
        .mockResolvedValueOnce({
          nodes: [
            {
              id: `${nodeType}-1`,
              label: `${nodeType}-label`,
              type: nodeType,
              resource: { key: nodeType },
            },
          ],
        })
        .mockResolvedValueOnce({ nodes: [] });

      renderDialog({ provider: "unknown-provider" });

      await userEvent.click(await screen.findByRole("button", { name: `${nodeType}-label` }));

      await waitFor(() => {
        expect(mockExplorerList).toHaveBeenLastCalledWith(
          "direct-connector-1",
          expectedAction,
          { key: nodeType },
          { projectId: "proj-1", connectorId: "connector-1" },
        );
      });
    },
  );

  it("[tag:connector-browser] leaves non-navigable nodes as plain text", async () => {
    mockExplorerList.mockResolvedValueOnce({
      nodes: [
        { id: "snapshot-1", label: "Snapshot", type: "snapshot", resource: { id: "snapshot-1" } },
        { id: "leaf-1", label: "Leaf", type: "folder", childrenHint: "leaf", resource: { id: "leaf-1" } },
      ],
    });

    renderDialog();

    expect((await screen.findAllByText("Snapshot")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Leaf").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Snapshot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leaf" })).not.toBeInTheDocument();
  });

  it.each([
    [{ table: "table_1" }, "Selected", "describeTable"],
    [{ schema: "schema_1" }, "Schema", "listTables"],
    [{ database: "db_1" }, "Database", "listSchemas"],
    [{ bucket: "bucket-1" }, "Bucket", "listPath"],
  ])(
    "[tag:connector-browser] infers initial-resource navigation for %o",
    async (initialResource, label, expectedAction) => {
      mockExplorerList.mockResolvedValueOnce({ nodes: [] });

      renderDialog({
        provider: "unknown-provider",
        initialResource: initialResource as never,
        initialResourceLabel: label,
      });

      await waitFor(() => {
        expect(mockExplorerList).toHaveBeenCalledWith(
          "direct-connector-1",
          expectedAction,
          initialResource,
          { projectId: "proj-1", connectorId: "connector-1" },
        );
      });
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    },
  );

  it("[tag:connector-browser] falls back to the root when the initial resource shape is not navigable", async () => {
    mockExplorerList.mockResolvedValueOnce({ nodes: [] });

    renderDialog({
      provider: "unknown-provider",
      initialResource: { id: "metrics-only" } as never,
    });

    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenCalledWith(
        "direct-connector-1",
        "listPath",
        {},
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
  });

  it("[tag:connector-browser] skips the database picker when a configured database is set", async () => {
    mockExplorerList.mockResolvedValueOnce({ nodes: [] });

    renderDialog({
      provider: "postgresql",
      configuredDatabase: "appdb",
    });

    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenCalledWith(
        "direct-connector-1",
        "listSchemas",
        { database: "appdb" },
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
    expect(screen.getByRole("button", { name: "appdb" })).toBeDisabled();
  });

  it("[tag:connector-browser] supports region-aware providers and reloads the root after region selection", async () => {
    mockExplorerList
      .mockResolvedValueOnce({
        nodes: [
          { id: "us-east-1", label: "US East", type: "region", resource: { region: "us-east-1" } },
        ],
      })
      .mockResolvedValueOnce({ nodes: [] })
      .mockResolvedValueOnce({ nodes: [] });

    renderDialog({ provider: "gcp", connectorScope: "account" });

    expect(await screen.findByText("Region")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenNthCalledWith(
        1,
        "direct-connector-1",
        "listRegions",
        {},
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenNthCalledWith(
        2,
        "direct-connector-1",
        "listServices",
        { region: "us-east-1" },
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });

    await userEvent.selectOptions(screen.getByRole("combobox"), "us-east-1");
    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenNthCalledWith(
        3,
        "direct-connector-1",
        "listServices",
        { region: "us-east-1" },
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
  });

  it("[tag:connector-browser] still fetches the root listing when listRegions fails", async () => {
    mockExplorerList
      .mockRejectedValueOnce(new Error("region load failed"))
      .mockResolvedValueOnce({ nodes: [] });

    renderDialog({ provider: "gcp", connectorScope: "account" });

    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenNthCalledWith(
        1,
        "direct-connector-1",
        "listRegions",
        {},
        { projectId: "proj-1", connectorId: "connector-1" },
      );
      expect(mockExplorerList).toHaveBeenNthCalledWith(
        2,
        "direct-connector-1",
        "listServices",
        {},
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
    expect(screen.getByRole("option", { name: "No regions available" })).toBeInTheDocument();
  });

  it("[tag:connector-browser] still fetches the root listing when listRegions returns empty", async () => {
    mockExplorerList
      .mockResolvedValueOnce({ nodes: [] })
      .mockResolvedValueOnce({ nodes: [] });

    renderDialog({ provider: "gcp", connectorScope: "account" });

    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenNthCalledWith(
        2,
        "direct-connector-1",
        "listServices",
        {},
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });
    expect(screen.getByRole("option", { name: "No regions available" })).toBeInTheDocument();
  });

  it("[tag:connector-browser] adds selected resources in editable mode and closes the dialog", async () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    mockExplorerList.mockResolvedValueOnce({
      nodes: [
        {
          id: "folder-1",
          label: "Folder 1",
          type: "folder",
          resource: { bucket: "bucket-1", prefix: "folder-1" },
          metadata: { size: 1024 },
        },
        {
          id: "file-1",
          label: "File 1",
          type: "file",
          resource: { bucket: "bucket-1", path: "file-1.txt" },
          metadata: { junction_path: "/junction" },
        },
      ],
    });

    render(
      <ConnectorBrowserDialog
        open
        onClose={onClose}
        projectId="proj-1"
        connectorId="connector-1"
        provider="gcs"
        onAdd={onAdd}
      />,
    );

    expect(await screen.findByText("Browse the connector and choose resources to add to this dataset.")).toBeInTheDocument();
    expect(screen.getByText("1024 bytes")).toBeInTheDocument();
    expect(screen.getByText("/junction")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "select-all" }));
    expect(screen.getByRole("button", { name: "Add (2)" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Add (2)" }));

    expect(onAdd).toHaveBeenCalledWith([
      { bucket: "bucket-1", prefix: "folder-1" },
      { bucket: "bucket-1", path: "file-1.txt" },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("[tag:connector-browser] shows read-only copy and closes without selection", async () => {
    const onClose = vi.fn();
    mockExplorerList.mockResolvedValueOnce({ nodes: [] });

    render(
      <ConnectorBrowserDialog
        open
        onClose={onClose}
        projectId="proj-1"
        connectorId="connector-1"
        provider="ontap"
        readOnly
      />,
    );

    expect(await screen.findByText("Browsing the contents of this scope entry.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.getByTestId("base-table")).toHaveAttribute("data-multi", "true");
  });

  it("[tag:connector-browser] surfaces API and thrown errors", async () => {
    const onClose = vi.fn();
    mockExplorerList.mockResolvedValueOnce({
      nodes: [],
      error: { code: "NOT_READY", message: "Wait for sync" },
    });

    render(
      <ConnectorBrowserDialog
        open
        onClose={onClose}
        projectId="proj-1"
        connectorId="connector-1"
        provider="s3"
      />,
    );

    expect(await screen.findByText("NOT_READY: Wait for sync")).toBeInTheDocument();

    vi.clearAllMocks();
    mockExplorerList.mockRejectedValueOnce(new Error("Failed to list connector resources"));

    render(
      <ConnectorBrowserDialog
        open
        onClose={onClose}
        projectId="proj-1"
        connectorId="connector-2"
        provider="s3"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("base-table")[1]).toHaveAttribute("data-error", "true");
    });
    expect(await screen.findByText("Failed to list connector resources")).toBeInTheDocument();
  });

  it("[tag:connector-browser] lets users navigate back with breadcrumbs and closes on dialog dismissal", async () => {
    const onClose = vi.fn();
    mockExplorerList
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "folder-1",
            label: "Folder 1",
            type: "folder",
            resource: { bucket: "bucket-1", prefix: "folder-1" },
          },
        ],
      })
      .mockResolvedValueOnce({ nodes: [] })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "folder-1",
            label: "Folder 1",
            type: "folder",
            resource: { bucket: "bucket-1", prefix: "folder-1" },
          },
        ],
      });

    render(
      <ConnectorBrowserDialog
        open
        onClose={onClose}
        projectId="proj-1"
        connectorId="connector-1"
        provider="s3"
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Folder 1" }));
    await userEvent.click(screen.getByRole("button", { name: "/" }));

    await waitFor(() => {
      expect(mockExplorerList).toHaveBeenLastCalledWith(
        "direct-connector-1",
        "listBuckets",
        {},
        { projectId: "proj-1", connectorId: "connector-1" },
      );
    });

    await userEvent.click(screen.getByText("dismiss-dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("[tag:connector-browser] enables multi-select on GCP metric category lists", async () => {
    mockExplorerList
      .mockResolvedValueOnce({
        nodes: [
          { id: "us-east-1", label: "US East", type: "region", resource: { region: "us-east-1" } },
        ],
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "gcp:svc/metrics",
            label: "Performance Metrics",
            type: "service",
            kind: "metrics",
            resource: { service: "metrics" },
            actions: ["listMetricCategories"],
          },
        ],
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "cat:volume_metrics",
            label: "Volume Performance Metrics",
            type: "metric_category",
            resource: { category: "volume_metrics" },
            childrenHint: "leaf",
          },
          {
            id: "cat:pool_metrics",
            label: "Pool Metrics",
            type: "metric_category",
            resource: { category: "pool_metrics" },
            childrenHint: "leaf",
          },
        ],
      });

    renderDialog({ provider: "gcp", connectorScope: "account" });

    await userEvent.click(await screen.findByRole("button", { name: "Performance Metrics" }));

    await waitFor(() => {
      expect(screen.getByTestId("base-table")).toHaveAttribute("data-multi", "true");
    });
  });

  it("[tag:connector-browser] keeps single-select for GCP non-metric levels", async () => {
    mockExplorerList
      .mockResolvedValueOnce({
        nodes: [
          { id: "us-east-1", label: "US East", type: "region", resource: { region: "us-east-1" } },
        ],
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "gcp:svc/gcs",
            label: "Cloud Storage",
            type: "service",
            resource: { service: "gcs", region: "us-east-1" },
            actions: ["listResources"],
          },
        ],
      });

    renderDialog({ provider: "gcp", connectorScope: "account" });

    await waitFor(() => {
      expect(screen.getByTestId("base-table")).toHaveAttribute("data-multi", "false");
    });
  });

  it("[tag:connector-browser] embedded read-only mode hides footer and enables pagination", async () => {
    mockExplorerList.mockResolvedValueOnce({
      nodes: [
        { id: "bucket-a", label: "bucket-a", type: "folder", resource: { bucket: "bucket-a" } },
      ],
    });

    render(
      <ConnectorBrowser
        embedded
        readOnly
        projectId="proj-1"
        connectorId="connector-1"
        provider="s3"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("base-table")).toHaveAttribute("data-pagination", "true");
    });
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByText("Browsing the contents of this scope entry.")).not.toBeInTheDocument();
  });

  it("[tag:connector-browser] embedded mode applies client filters to loaded rows", async () => {
    mockExplorerList.mockResolvedValueOnce({
      nodes: [
        { id: "bucket-a", label: "bucket-a", type: "folder", resource: { bucket: "bucket-a" } },
        { id: "bucket-b", label: "other-bucket", type: "folder", resource: { bucket: "bucket-b" } },
      ],
    });

    render(
      <ConnectorBrowser
        embedded
        readOnly
        projectId="proj-1"
        connectorId="connector-1"
        provider="s3"
        clientFilters={[{ column: "Name", op: "=", value: "bucket-a" }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("row-bucket-a")).toBeInTheDocument();
      expect(screen.queryByTestId("row-bucket-b")).not.toBeInTheDocument();
    });
  });
});

import { useCallback, useMemo, useState, type ReactElement } from "react";

import { useListProvidersQuery } from "@/routes/pages/models/models.api";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";

import { createProvidersTableColumns, type ProvidersTableRow } from "./providers-table.columns";
import { ProviderProxyModal, type ProviderProxyTarget } from "./provider-proxy-modal";
import { useRefreshProviderHealth } from "./use-refresh-provider-health";

function ProvidersTablePanel(): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError, isFetching } = useListProvidersQuery(
    { projectId },
    { skip: !projectId },
  );
  const { refresh, isRefreshing } = useRefreshProviderHealth();
  const [editingProvider, setEditingProvider] = useState<ProviderProxyTarget | null>(null);

  const handleEditProxy = useCallback((row: ProvidersTableRow): void => {
    setEditingProvider({
      provider_id: row.provider_id,
      name: row.name,
      concurrent_requests: row.concurrent_requests,
      buffer_size: row.buffer_size,
    });
  }, []);

  const columns = useMemo(
    () => createProvidersTableColumns({ onEditProxy: handleEditProxy }),
    [handleEditProxy],
  );

  // BaseTable rows must carry an `id`; map the provider_id onto it.
  const rows = useMemo<ProvidersTableRow[]>(
    () => (data?.data ?? []).map((p) => ({ ...p, id: p.provider_id })),
    [data],
  );

  // "Refresh" pulls live health from Bifrost via the config-service refresh
  // route, surfaces a success/error toast, then the LIST tag invalidation
  // refetches the table. Guard against overlapping clicks while in flight.
  const tableOptions = useMemo<BaseTableOptions>(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableStickyHeaders: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: "Providers",
        showSearch: true,
        primaryActionLabel: isRefreshing ? "Refreshing…" : "Refresh",
        onPrimaryAction: projectId
          ? () => {
              if (isRefreshing || isFetching) return;
              refresh(projectId);
            }
          : undefined,
      },
    }),
    [projectId, isRefreshing, isFetching, refresh],
  );

  return (
    <div className="models-overview__panel">
      <BaseTable<ProvidersTableRow>
        options={tableOptions}
        data={rows}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />
      <ProviderProxyModal
        open={editingProvider != null}
        onOpenChange={(open) => {
          if (!open) setEditingProvider(null);
        }}
        projectId={projectId}
        provider={editingProvider}
      />
    </div>
  );
}

export { ProvidersTablePanel };

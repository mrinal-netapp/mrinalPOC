import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import {
  useDeleteModelMutation,
  useListModelsQuery,
  useListProvidersQuery,
} from "@/routes/pages/models/models.api";
import { ROUTES } from "@/routes/routes.consts";
import { useAppDispatch, useAppSelector, modelSelector, setSelectedModel } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";

import { createModelsTableColumns, type ModelsTableRow } from "./models-table.columns";
import type { ProviderHealth } from "./models-overview.types";
import { useRefreshProviderHealth } from "./use-refresh-provider-health";

function ModelsTablePanel(): ReactElement {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const listFilters = useAppSelector(modelSelector.listFilters);

  const { data, isLoading, isError } = useListModelsQuery(
    { projectId, ...listFilters },
    { skip: !projectId },
  );

  // A model's connection health mirrors its provider's live Bifrost status, so
  // we read the providers list and index it by provider_id. "Refresh" below
  // re-pulls this health from Bifrost via the provider refresh route.
  const { data: providersData, isFetching: isProvidersFetching } = useListProvidersQuery(
    { projectId },
    { skip: !projectId },
  );
  const { refresh, isRefreshing } = useRefreshProviderHealth();
  const [deleteModel, { isLoading: isDeleting }] = useDeleteModelMutation();
  const [deleteState, setDeleteState] = useState<{ modelId: string; modelName: string } | null>(null);

  const providerHealthById = useMemo(() => {
    const map = new Map<string, { status: ProviderHealth; statusMessage?: string }>();
    for (const p of providersData?.data ?? []) {
      map.set(p.provider_id, { status: p.status, statusMessage: p.statusMessage });
    }
    return map;
  }, [providersData]);

  const handleNavigateDetail = useCallback(
    (modelId: string): void => {
      dispatch(setSelectedModel(modelId));
      navigate(`/${ROUTES.MODELS}/${modelId}`);
    },
    [dispatch, navigate],
  );

  // User-registered LLMs are the primary reason people open this tab; surface
  // them before the many built-in embedding rows so a model like gpt-5.4 is not
  // pushed to page 2 by a recent builtin seed refresh.
  const rows = useMemo<ModelsTableRow[]>(
    () =>
      (data?.data ?? [])
        .map((m) => {
          const health = providerHealthById.get(m.provider_id);
          return {
            ...m,
            id: m.model_id,
            connectionStatus: health?.status ?? "Disconnected",
            connectionMessage: health?.statusMessage,
          };
        })
        .sort((a, b) => {
          const typeRank = (type: string): number => (type === "LLM" ? 0 : 1);
          const byType = typeRank(a.type) - typeRank(b.type);
          if (byType !== 0) return byType;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        }),
    [data, providerHealthById],
  );

  const columns = useMemo(
    () =>
      createModelsTableColumns({
        onNavigateDetail: handleNavigateDetail,
        onEdit: (modelId) => navigate(`/${ROUTES.MODELS}/${modelId}/${ROUTES.EDIT}`),
        onDelete: (modelId, modelName) => setDeleteState({ modelId, modelName }),
      }),
    [handleNavigateDetail, navigate],
  );

  const closeDeleteDialog = useCallback(() => {
    setDeleteState(null);
  }, []);

  const confirmDeleteModel = useCallback(() => {
    if (!projectId || !deleteState || isDeleting) return;
    void deleteModel({ projectId, modelId: deleteState.modelId })
      .unwrap()
      .then(() => {
        toast.success(`Model "${deleteState.modelName}" deleted.`);
        closeDeleteDialog();
      })
      .catch(() => {
        toast.error(`Couldn't delete "${deleteState.modelName}". Please try again.`);
      });
  }, [closeDeleteDialog, deleteModel, deleteState, isDeleting, projectId]);

  // "Refresh" pulls live provider health from Bifrost (with a success/error
  // toast); the ModelProvider LIST invalidation refetches the providers query,
  // which re-derives each row's connection status. Guard overlapping clicks.
  const handleRefresh = useCallback((): void => {
    if (!projectId || isRefreshing || isProvidersFetching) return;
    refresh(projectId);
  }, [projectId, isRefreshing, isProvidersFetching, refresh]);

  // BaseTable's top bar exposes Search → Refresh → Primary action on the
  // right edge (left-to-right). Wiring Refresh through `onRefresh`
  // instead of the prior standalone button keeps all three controls on
  // a single row, the requested order: search · refresh · Add model.
  //
  // The button is rendered unconditionally (BaseTable hides it only when
  // `onRefresh` is undefined); `handleRefresh`'s internal guard
  // (`!projectId || isRefreshing || isProvidersFetching`) makes clicks a
  // no-op when the page is in a not-yet-actionable state, and the
  // `isRefreshing` flag drives the loading spinner.
  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableStickyHeaders: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: "Models",
        showSearch: true,
        onRefresh: handleRefresh,
        refreshLabel: "Refresh",
        isRefreshing,
        onPrimaryAction: () => navigate(`/${ROUTES.MODELS}/${ROUTES.MODELS_ADD}`),
        primaryActionLabel: "Add model",
      },
    }),
    [handleRefresh, isRefreshing, navigate],
  );

  return (
    <>
      <div className="models-overview__panel">
        <BaseTable<ModelsTableRow>
          options={tableOptions}
          data={rows}
          columns={columns}
          isLoading={isLoading}
          isError={isError}
        />
      </div>
      <ConfirmDialog
        open={Boolean(deleteState)}
        title="Delete model"
        description={
          deleteState
            ? `Are you sure you want to delete "${deleteState.modelName}"?`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDeleteModel}
        onCancel={closeDeleteDialog}
      />
    </>
  );
}

export { ModelsTablePanel };

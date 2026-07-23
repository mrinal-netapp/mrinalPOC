import { useEffect } from "react";
import { useStore } from "@tanstack/react-store";

import { useGetDataSourceQuery } from "@/api/data-source-api.slice";
import type { DataSourceCategory, DataSourceDetail } from "@/api/data-source.types";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";

export interface SelectedDataSourceContext {
  /** Resolved category — fetched data source wins over the form cache. */
  category: DataSourceCategory | null;
  dataSourceId: string;
  ds: DataSourceDetail | undefined;
  isConnectorSource: boolean;
  isLoading: boolean;
  isVolumeSource: boolean;
}

/**
 * Single source of truth for the picked data source's category and volume/connector
 * routing. Keeps `data_source_category` on the form in sync when the linked source
 * is fetched (create picker + edit hydrate).
 */
export function useSelectedDataSource(form: AnyReactFormApi): SelectedDataSourceContext {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const dataSourceId: string = useStore(form.store, (s) => s.values.data_source_id);
  const formCategory = useStore(form.store, (s) => s.values.data_source_category ?? null);

  const { data: ds, isLoading } = useGetDataSourceQuery(
    { projectId, dsrcId: dataSourceId ?? "" },
    { skip: !projectId || !dataSourceId },
  );

  useEffect(() => {
    if (ds?.category != null && ds.category !== formCategory) {
      form.setFieldValue("data_source_category", ds.category);
    }
  }, [ds?.category, formCategory, form]);

  const category = ds?.category ?? formCategory ?? null;
  const hasSelection = Boolean(dataSourceId);
  const isVolumeSource = category === "Volume" && hasSelection;
  const isConnectorSource = Boolean(category) && category !== "Volume" && hasSelection;

  return {
    category,
    dataSourceId,
    ds,
    isConnectorSource,
    isLoading,
    isVolumeSource,
  };
}

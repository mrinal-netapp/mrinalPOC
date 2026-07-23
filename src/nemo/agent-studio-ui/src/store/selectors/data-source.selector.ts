import type { RootState, DataSourceState } from "../store.types";
import type { DataSourceListParams } from "@/api/data-source.types";
import { dataSourceApi } from "@/api/data-source-api.slice";
import rootSelector from "./root.selector";

const getDataSourceSelector = rootSelector.dataSourceSelector;

export const dataSourceSelector = {
  state(state: RootState): DataSourceState {
    return getDataSourceSelector(state);
  },

  selectedDsrcId(state: RootState): string | null {
    return getDataSourceSelector(state).selectedDsrcId;
  },

  listFilters(state: RootState): DataSourceListParams {
    return getDataSourceSelector(state).listFilters;
  },

  getDataSourceListSelector(projectId: string, filters: DataSourceListParams): ReturnType<typeof dataSourceApi.endpoints.listDataSources.select> {
    return dataSourceApi.endpoints.listDataSources.select({ projectId, ...filters });
  },
};

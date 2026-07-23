import type { RootState, DatasetState } from '../store.types';
import type { DatasetListParams } from '@/api/dataset.types';
import { datasetApi } from '@/api/dataset-api.slice';
import rootSelector from './root.selector';

const getDatasetSelector = rootSelector.datasetSelector;

export const datasetSelector = {
  state(state: RootState): DatasetState {
    return getDatasetSelector(state);
  },

  selectedDsetId(state: RootState): string | null {
    return getDatasetSelector(state).selectedDsetId;
  },

  listFilters(state: RootState): DatasetListParams {
    return getDatasetSelector(state).listFilters;
  },

  getDatasetListSelector(projectId: string, filters: DatasetListParams): ReturnType<typeof datasetApi.endpoints.listDatasets.select> {
    return datasetApi.endpoints.listDatasets.select({ projectId, ...filters });
  },
};

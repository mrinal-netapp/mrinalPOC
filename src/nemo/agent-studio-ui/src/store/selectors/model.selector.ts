import type { RootState, ModelState } from '../store.types';
import type { ModelListParams } from '@/routes/pages/models/models.api.types';
import { modelsApi } from '@/routes/pages/models/models.api';
import rootSelector from './root.selector';

const getModelSelector = rootSelector.modelSelector;

export const modelSelector = {
  state(state: RootState): ModelState {
    return getModelSelector(state);
  },

  selectedModelId(state: RootState): string | null {
    return getModelSelector(state).selectedModelId;
  },

  listFilters(state: RootState): Partial<ModelListParams> {
    return getModelSelector(state).listFilters;
  },

  getModelListSelector(projectId: string, filters: ModelListParams): ReturnType<typeof modelsApi.endpoints.listModels.select> {
    return modelsApi.endpoints.listModels.select({ projectId, ...filters });
  },
};

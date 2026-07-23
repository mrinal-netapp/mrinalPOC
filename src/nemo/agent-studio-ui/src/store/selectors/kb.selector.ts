import type { RootState, KBState } from '../store.types';
import type { KBListParams } from '@/api/kb.types';
import { kbApi } from '@/api/kb-api.slice';
import rootSelector from './root.selector';

const getKBSelector = rootSelector.kbSelector;

export const kbSelector = {
  state(state: RootState): KBState {
    return getKBSelector(state);
  },

  selectedKbId(state: RootState): string | null {
    return getKBSelector(state).selectedKbId;
  },

  listFilters(state: RootState): KBListParams {
    return getKBSelector(state).listFilters;
  },

  getKBListSelector(projectId: string, filters: KBListParams): ReturnType<typeof kbApi.endpoints.listKnowledgeBases.select> {
    return kbApi.endpoints.listKnowledgeBases.select({ projectId, ...filters });
  },
};

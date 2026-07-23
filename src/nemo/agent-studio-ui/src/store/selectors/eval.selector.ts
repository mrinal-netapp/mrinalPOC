import type { RootState, EvalState } from '../store.types';
import type { EvalListParams } from '@/routes/pages/evaluations/api/eval.types';
import { evalApi } from '@/routes/pages/evaluations/api/eval-api.slice';
import rootSelector from './root.selector';

const getEvalSelector = rootSelector.evalSelector;

export const evalSelector = {
  state(state: RootState): EvalState {
    return getEvalSelector(state);
  },

  selectedTemplateId(state: RootState): string | null {
    return getEvalSelector(state).selectedTemplateId;
  },

  listFilters(state: RootState): Partial<EvalListParams> {
    return getEvalSelector(state).listFilters;
  },

  // Bridge to RTK Query: expose the cached list result keyed by filters.
  // NB: filters must match the args useListEvaluationsQuery was called with
  // (see state management guide §3.7 — cache key matching).
  getEvalListSelector(projectId: string, filters?: Partial<EvalListParams>): ReturnType<typeof evalApi.endpoints.listEvaluations.select> {
    const queryArg = {
      projectId,
      ...(filters && Object.keys(filters).length > 0 ? (filters as EvalListParams) : {}),
    };
    return evalApi.endpoints.listEvaluations.select(queryArg);
  },
};

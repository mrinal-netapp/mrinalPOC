import type { RootState, LayoutState, DataSourceState, DatasetState, KBState, ModelState, EvalState } from "../store.types";

const rootSelector = {
  layoutSelector(state: RootState): LayoutState {
    return state.layout
  },
  dataSourceSelector(state: RootState): DataSourceState {
    return state.dataSource
  },
  datasetSelector(state: RootState): DatasetState {
    return state.dataset
  },
  kbSelector(state: RootState): KBState {
    return state.kb
  },
  modelSelector(state: RootState): ModelState {
    return state.model
  },
  evalSelector(state: RootState): EvalState {
    return state.eval
  },
};

export default rootSelector;

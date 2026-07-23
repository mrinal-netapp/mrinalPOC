import { configureStore } from "@reduxjs/toolkit";
import { agentApi } from "@/api/agent-api.slice";
import { apiSlice } from "@/api/api.slice";
import "@/api/project-api.slice";
import "@/api/provider-catalog-api.slice";
import { utilitiesApi } from "@/api/utilities-api.slice";
import { TOOLSET_STORE_SLICE_NAME } from "@/components/toolset/model";
import { toolsetReducer } from "@/components/toolset/reducer";
import { layoutSlice } from "./slices/layout.slice";
import { dataSourceSlice } from "./slices/data-source.slice";
import { datasetSlice } from "./slices/dataset.slice";
import { kbSlice } from "./slices/kb.slice";
import { modelSlice } from "./slices/model.slice";
import { evalSlice } from "./slices/eval.slice";
import { projectContextSlice } from "./slices/project-context.slice";
// agentsConfigApi and agentsRuntimeApi inject into apiSlice — no separate
// reducer or middleware registration needed here.
import "@/routes/pages/agents/api/agents-config-api.slice";
import "@/routes/pages/agents/api/agents-runtime-api.slice";
import { agentsSlice } from "@/store/agents";
import { agentPlaygroundSlice } from "@/store/agent-playground";

export const store = configureStore({
  reducer: {
    [apiSlice.reducerPath]: apiSlice.reducer,
    [agentApi.reducerPath]: agentApi.reducer,
    [utilitiesApi.reducerPath]: utilitiesApi.reducer,
    [layoutSlice.name]: layoutSlice.reducer,
    [dataSourceSlice.name]: dataSourceSlice.reducer,
    [datasetSlice.name]: datasetSlice.reducer,
    [kbSlice.name]: kbSlice.reducer,
    [modelSlice.name]: modelSlice.reducer,
    [evalSlice.name]: evalSlice.reducer,
    [projectContextSlice.name]: projectContextSlice.reducer,
    [agentsSlice.name]: agentsSlice.reducer,
    [agentPlaygroundSlice.name]: agentPlaygroundSlice.reducer,
    [TOOLSET_STORE_SLICE_NAME]: toolsetReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(
      apiSlice.middleware,
      agentApi.middleware,
      utilitiesApi.middleware,
    ),
});

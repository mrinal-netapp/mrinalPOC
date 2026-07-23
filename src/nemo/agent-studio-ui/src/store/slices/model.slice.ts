import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ModelListParams } from '@/routes/pages/models/models.api.types';
import type { ModelState } from '../store.types';

const SLICE_NAME = 'model';

const initialState: ModelState = {
  selectedModelId: null,
  listFilters: {},
};

export const modelSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    setSelectedModel(state, action: PayloadAction<string | null>) {
      state.selectedModelId = action.payload;
    },
    setModelFilters(state, action: PayloadAction<Partial<ModelListParams>>) {
      state.listFilters = { ...state.listFilters, ...action.payload };
    },
    resetModelFilters(state) {
      state.listFilters = {};
    },
  },
});

export const {
  setSelectedModel,
  setModelFilters,
  resetModelFilters,
} = modelSlice.actions;

export default modelSlice;

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { DatasetListParams } from '@/api/dataset.types';
import type { DatasetState } from '../store.types';

const SLICE_NAME = 'dataset';

const initialState: DatasetState = {
  selectedDsetId: null,
  listFilters: {},
};

export const datasetSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    setSelectedDataset(state, action: PayloadAction<string | null>) {
      state.selectedDsetId = action.payload;
    },
    setDatasetFilters(state, action: PayloadAction<Partial<DatasetListParams>>) {
      state.listFilters = { ...state.listFilters, ...action.payload };
    },
    resetDatasetFilters(state) {
      state.listFilters = {};
    },
  },
});

export const {
  setSelectedDataset,
  setDatasetFilters,
  resetDatasetFilters,
} = datasetSlice.actions;

export default datasetSlice;

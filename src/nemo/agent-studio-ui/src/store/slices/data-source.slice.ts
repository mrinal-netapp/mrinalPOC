import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { DataSourceListParams } from "@/api/data-source.types";
import type { DataSourceState } from "../store.types";

const SLICE_NAME = 'dataSource';

const initialState: DataSourceState = {
  selectedDsrcId: null,
  listFilters: {},
};

export const dataSourceSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    setSelectedDataSource(state, action: PayloadAction<string | null>) {
      state.selectedDsrcId = action.payload;
    },
    setDataSourceFilters(state, action: PayloadAction<Partial<DataSourceListParams>>) {
      state.listFilters = { ...state.listFilters, ...action.payload };
    },
    resetDataSourceFilters(state) {
      state.listFilters = {};
    },
  },
});

export const {
  setSelectedDataSource,
  setDataSourceFilters,
  resetDataSourceFilters,
} = dataSourceSlice.actions;

export default dataSourceSlice;

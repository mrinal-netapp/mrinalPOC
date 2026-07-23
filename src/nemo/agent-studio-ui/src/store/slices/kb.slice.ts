import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { KBListParams } from '@/api/kb.types';
import type { KBState } from '../store.types';

const SLICE_NAME = 'kb';

const initialState: KBState = {
  selectedKbId: null,
  listFilters: {},
};

export const kbSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    setSelectedKB(state, action: PayloadAction<string | null>) {
      state.selectedKbId = action.payload;
    },
    setKBFilters(state, action: PayloadAction<Partial<KBListParams>>) {
      state.listFilters = { ...state.listFilters, ...action.payload };
    },
    resetKBFilters(state) {
      state.listFilters = {};
    },
  },
});

export const {
  setSelectedKB,
  setKBFilters,
  resetKBFilters,
} = kbSlice.actions;

export default kbSlice;

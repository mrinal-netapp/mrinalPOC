import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { EvalListParams } from '@/routes/pages/evaluations/api/eval.types';
import type { EvalState } from '../store.types';

const SLICE_NAME = 'eval';

const initialState: EvalState = {
  selectedTemplateId: null,
  listFilters: {},
};

export const evalSlice = createSlice({
  name: SLICE_NAME,
  initialState,
  reducers: {
    setSelectedTemplate(state, action: PayloadAction<string | null>) {
      state.selectedTemplateId = action.payload;
    },
    setEvalFilters(state, action: PayloadAction<Partial<EvalListParams>>) {
      state.listFilters = { ...state.listFilters, ...action.payload };
    },
    resetEvalFilters(state) {
      state.listFilters = {};
    },
  },
});

export const {
  setSelectedTemplate,
  setEvalFilters,
  resetEvalFilters,
} = evalSlice.actions;

export default evalSlice;

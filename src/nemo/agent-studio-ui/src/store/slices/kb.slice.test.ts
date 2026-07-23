import { describe, expect, it } from 'vitest';

import {
  kbSlice,
  setSelectedKB,
  setKBFilters,
  resetKBFilters,
} from './kb.slice';

const reducer = kbSlice.reducer;

describe('kbSlice', () => {
  it('[tag:kb][tag:redux] should return the correct initial state', () => {
    const state = reducer(undefined, { type: '@@INIT' });

    expect(state).toEqual({ selectedKbId: null, listFilters: {} });
  });

  it('[tag:kb][tag:redux] should set selectedKbId to the provided string', () => {
    const state = reducer(undefined, setSelectedKB('kb-abc'));

    expect(state.selectedKbId).toBe('kb-abc');
  });

  it('[tag:kb][tag:redux] should reset selectedKbId to null', () => {
    const prev = reducer(undefined, setSelectedKB('kb-abc'));
    const state = reducer(prev, setSelectedKB(null));

    expect(state.selectedKbId).toBeNull();
  });

  it('[tag:kb][tag:redux] should merge filters into empty listFilters', () => {
    const state = reducer(undefined, setKBFilters({ limit: 10, offset: 0 }));

    expect(state.listFilters).toEqual({ limit: 10, offset: 0 });
  });

  it('[tag:kb][tag:redux] should merge additional filters into existing ones', () => {
    const prev = reducer(undefined, setKBFilters({ limit: 10 }));
    const state = reducer(prev, setKBFilters({ search: 'foo' }));

    expect(state.listFilters).toEqual({ limit: 10, search: 'foo' });
  });

  it('[tag:kb][tag:redux] should overwrite an existing filter field', () => {
    const prev = reducer(undefined, setKBFilters({ limit: 10 }));
    const state = reducer(prev, setKBFilters({ limit: 20 }));

    expect(state.listFilters.limit).toBe(20);
  });

  it('[tag:kb][tag:redux] should clear all filters back to empty object', () => {
    const prev = reducer(
      undefined,
      setKBFilters({ limit: 10, search: 'bar' }),
    );
    const state = reducer(prev, resetKBFilters());

    expect(state.listFilters).toEqual({});
  });
});

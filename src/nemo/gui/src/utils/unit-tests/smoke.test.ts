// Smoke test that guarantees the Vitest pipeline (JSDOM env, coverage,
// JSON/JUnit reporters, sticky-comment summary) has at least one passing
// case to surface. Replace / extend with real component and hook tests
// as the UI test suite grows.

import { describe, it, expect } from 'vitest';

describe('vitest pipeline smoke', () => {
  it('runs and reports a passing case', () => {
    expect(1 + 1).toBe(2);
  });

  it('has access to JSDOM globals', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });
});

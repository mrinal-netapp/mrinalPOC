// Test environment bootstrap loaded by Vitest before every test file.
// Pulls in @testing-library/jest-dom so DOM assertions like
// `toBeInTheDocument()` are available on `expect(...)`, and shims a couple of
// JSDOM gaps that Fluent UI / Recharts trip over (matchMedia + ResizeObserver
// are not provided by JSDOM but several of our components call them at mount).

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  if (typeof window.ResizeObserver === 'undefined') {
    class ResizeObserverPolyfill {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
      ResizeObserverPolyfill;
  }
}

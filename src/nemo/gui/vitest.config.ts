/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Test-only config, intentionally separate from `vite.config.ts` so the
// production Vite build never sees `test:` / coverage settings. Mirrors the
// old repo's `ui/src/utils/unit-tests/` layout for test artefacts so the
// CI summary job and downstream tooling find results/coverage at predictable
// paths regardless of which repo cut the workflow.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/utils/unit-tests/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/utils/unit-tests/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      'node_modules',
      'dist',
      // Standalone tsx-runnable tests (no Vitest harness — just top-level
      // assertions). They run via their own `npm run test:*` scripts and
      // would otherwise be reported as empty suites by Vitest.
      'src/components/wizard/connectorTemplatePickerSearch.test.ts',
      'src/components/agent-wizard/agentTeamWizardLogic.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
      reportsDirectory: 'src/utils/unit-tests/coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.config.{ts,js}',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/utils/unit-tests/**',
      ],
    },
  },
});

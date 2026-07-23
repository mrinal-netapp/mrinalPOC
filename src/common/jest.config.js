/** @type {import('jest').Config} */
module.exports = {
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // observability-client ships its own node:test suite; exclude it from Jest
  // to avoid "Your test suite must contain at least one test" errors.
  testPathIgnorePatterns: [
    '<rootDir>/src/observability/observability-client/',
  ],
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.test.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};

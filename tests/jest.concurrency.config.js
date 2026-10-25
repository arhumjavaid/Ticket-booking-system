const base = require('./jest.base.config');

module.exports = {
  ...base,
  displayName: 'concurrency',
  roots: ['<rootDir>/tests/concurrency'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000,
  // Avoid watchman permission failures on macOS sandboxed / CI shells.
  watchman: false,
};

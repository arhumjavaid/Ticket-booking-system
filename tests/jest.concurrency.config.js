const base = require('./jest.base.config');

module.exports = {
  ...base,
  displayName: 'concurrency',
  roots: ['<rootDir>/tests/concurrency'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000,
};

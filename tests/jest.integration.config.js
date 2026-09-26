const base = require('./jest.base.config');

module.exports = {
  ...base,
  displayName: 'integration',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000,
};

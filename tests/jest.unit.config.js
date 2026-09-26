const base = require('./jest.base.config');

module.exports = {
  ...base,
  displayName: 'unit',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
};

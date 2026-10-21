import { secretFromEnv } from '@ticketing/shared';

describe('secretFromEnv', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it('allows the dev default outside production', () => {
    process.env = { ...env, NODE_ENV: 'development', TEST_SECRET: undefined };
    expect(secretFromEnv('TEST_SECRET', 'dev-default')).toBe('dev-default');
  });

  it.each([
    ['unset', undefined],
    ['set to the dev default (as docker-compose does)', 'dev-default'],
  ])('refuses to start in production when the secret is %s', (_label, value) => {
    process.env = { ...env, NODE_ENV: 'production', TEST_SECRET: value };
    expect(() => secretFromEnv('TEST_SECRET', 'dev-default')).toThrow('TEST_SECRET must be set');
  });

  it('uses a real secret in production', () => {
    process.env = { ...env, NODE_ENV: 'production', TEST_SECRET: 'real-secret' };
    expect(secretFromEnv('TEST_SECRET', 'dev-default')).toBe('real-secret');
  });
});

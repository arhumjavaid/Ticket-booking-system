/**
 * Reads a shared secret, falling back to a dev default - except in
 * production, where an unset secret or the published default (which
 * docker-compose fills in via `${VAR:-default}`) refuses to start.
 */
export function secretFromEnv(name: string, devDefault: string): string {
  const value = process.env[name] || devDefault;
  if (process.env.NODE_ENV === 'production' && value === devDefault) {
    throw new Error(`${name} must be set to a non-default value when NODE_ENV=production`);
  }
  return value;
}

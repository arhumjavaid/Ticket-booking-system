// Shared constants for every k6 scenario. All scenarios hit NGINX
// (section 38), never an API instance directly - this is what proves
// horizontal scaling actually works under load rather than just in theory.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080/api';

export function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

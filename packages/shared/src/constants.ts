export const SEAT_HOLD_TTL_SECONDS = parseInt(process.env.SEAT_HOLD_TTL_SECONDS || '300', 10);
export const REDIS_LOCK_TTL_MS = parseInt(process.env.REDIS_LOCK_TTL_MS || '10000', 10);

export const RATE_LIMITS = {
  login: { limit: parseInt(process.env.RATE_LIMIT_LOGIN_PER_MIN || '5', 10), windowSeconds: 60 },
  browse: { limit: parseInt(process.env.RATE_LIMIT_BROWSE_PER_MIN || '100', 10), windowSeconds: 60 },
  booking: { limit: parseInt(process.env.RATE_LIMIT_BOOKING_PER_MIN || '10', 10), windowSeconds: 60 },
  hold: { limit: parseInt(process.env.RATE_LIMIT_HOLD_PER_MIN || '20', 10), windowSeconds: 60 },
} as const;

export const CACHE_TTL_SECONDS = {
  eventDetail: 60,
  eventAvailability: 15,
} as const;

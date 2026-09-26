import pino from 'pino';
import { getContext } from './context';

const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown-service';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * Structured JSON logger. Every line includes service, requestId (when
 * available from AsyncLocalStorage) and timestamp so logs from every
 * container can be correlated by X-Request-ID across the whole request
 * path: Nginx -> API -> Booking Service -> Redis -> Postgres -> MQ -> Worker.
 */
const base = pino({
  level: LOG_LEVEL,
  base: { service: SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  mixin() {
    const ctx = getContext();
    return ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {};
  },
});

export interface LogFields {
  [key: string]: unknown;
  operation?: string;
  eventId?: string;
  seatId?: string;
  bookingId?: string;
  status?: string;
  durationMs?: number;
}

export const logger = {
  info: (fields: LogFields, msg: string) => base.info(fields, msg),
  warn: (fields: LogFields, msg: string) => base.warn(fields, msg),
  error: (fields: LogFields, msg: string) => base.error(fields, msg),
  debug: (fields: LogFields, msg: string) => base.debug(fields, msg),
};

import axios from 'axios';
import { getContext } from '@ticketing/logging';

const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'dev-internal-token-change-in-production';

function withRequestId(headers: Record<string, string> = {}) {
  const ctx = getContext();
  return ctx ? { ...headers, 'X-Request-ID': ctx.requestId } : headers;
}

export const bookingServiceClient = axios.create({
  baseURL: process.env.BOOKING_SERVICE_URL || 'http://booking-service:4000',
  timeout: 8000,
  headers: { 'X-Internal-Token': INTERNAL_TOKEN },
});
bookingServiceClient.interceptors.request.use((config) => {
  config.headers = { ...config.headers, ...withRequestId() } as any;
  return config;
});

export const searchServiceClient = axios.create({
  baseURL: process.env.SEARCH_SERVICE_URL || 'http://search-service:4300',
  timeout: 5000,
});

export const analyticsServiceClient = axios.create({
  baseURL: process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:4200',
  timeout: 5000,
});

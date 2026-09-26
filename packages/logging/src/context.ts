import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return als.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return als.getStore();
}

export function setContextUserId(userId: string): void {
  const ctx = als.getStore();
  if (ctx) ctx.userId = userId;
}

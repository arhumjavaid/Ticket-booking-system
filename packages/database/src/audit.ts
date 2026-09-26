import { writeDB } from './client';

export interface AuditLogInput {
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Fire-and-forget audit trail write. Never awaited by callers on the
 * critical path - an audit log failure must not fail the business
 * operation it is describing.
 */
export function recordAuditLog(input: AuditLogInput): void {
  writeDB.auditLog
    .create({
      data: {
        actorId: input.actorId || null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId || null,
        metadata: input.metadata as any,
        requestId: input.requestId,
      },
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', component: 'audit', message: (err as Error).message }));
    });
}

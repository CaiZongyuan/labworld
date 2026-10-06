import type { Audit, AuditRecord } from '../../platform/context.ts';
import { auditEvents } from './schema.ts';
export const databaseAudit: Audit = {
  async record(transaction, event: AuditRecord) {
    await transaction
      .insert(auditEvents)
      .values({
        actorId: event.actorId,
        actorType: event.actorType,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        requestId: event.requestId,
        correlationId: event.correlationId,
        metadata: event.metadata,
      });
  },
};

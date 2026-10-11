import { randomUUID } from 'node:crypto';
import {
  sql,
  type Database,
  type DbOperation,
} from '../../platform/db/index.ts';
import { provisionMachineIn } from '../../core/machines/use-cases.ts';
import { endSessionIn, reserveSessionIn } from '../sessions/store.ts';
import type { Session } from '../sessions/dto.ts';
export type ResetSuccessor = {
  session: Session;
  machine: Record<string, unknown> | null;
  credential: string | undefined;
};
class ResetRollback extends Error {
  plan: ResetSuccessor;
  constructor(plan: ResetSuccessor) {
    super('recording_reset_plan');
    this.plan = plan;
  }
}
/** Allocate exact future identities/instants without exposing a committed successor. */
export async function planResetSuccessor(
  db: Database,
  op: DbOperation,
  current: Session,
  actorId: string,
  owned: boolean,
  now: string,
): Promise<ResetSuccessor> {
  const id = randomUUID();
  try {
    await db.transaction(op, async (tx) => {
      await endSessionIn(tx, current.id, 'reset', 'reset_requested', now, id);
      const source = owned
        ? await provisionMachineIn(
            tx,
            actorId,
            'Development synthetic Session',
            now,
          )
        : { machine: { id: current.machine_id }, credential: undefined };
      const session = await reserveSessionIn(
        tx,
        current.lab_id,
        current.installation_id,
        source.machine.id,
        current.snapshot,
        actorId,
        now,
        id,
      );
      const machine = owned
        ? (
            await tx.execute<{ value: Record<string, unknown> }>(
              sql`select to_jsonb(m) as value from labos_threejs_core.machines m where id=${source.machine.id}::uuid`,
            )
          ).rows[0].value
        : null;
      throw new ResetRollback({
        session,
        machine,
        credential: source.credential,
      });
    });
    throw new Error('recording_reset_plan_missing');
  } catch (error) {
    if (error instanceof ResetRollback) return error.plan;
    throw error;
  }
}

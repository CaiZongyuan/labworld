import { randomUUID } from 'node:crypto';
import { stream, streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { eq, desc, sql, and, lt, or } from 'drizzle-orm';
import { createApp } from '../src/core/system/routes.ts';
import type { FoundationContext } from '../src/platform/context.ts';
import { users } from '../src/core/identity/schema.ts';
import { organizations, memberships } from '../src/core/organization/schema.ts';
import { labs, entities } from '../src/lab/world/schema.ts';
import { bindings, runs, observations } from '../src/lab/devices/schema.ts';
import { history } from '../src/lab/history/schema.ts';
import { utcInstant } from '../src/platform/db/instant.ts';
import { version } from '../../../apps/server/src/runtime.ts';

const Sample = z.object({
  entity_id: z.string().uuid(),
  id: z.string().uuid(),
  received_at: z.string(),
  value: z.number(),
  sequence: z.number().int().positive(),
});
type Sample = z.infer<typeof Sample>;
export async function fixtureApp(context: FoundationContext) {
  const { db } = context;
  const seed = await db.transaction(
    { id: 'fixture:seed', kind: 'startup' },
    async (tx) => {
      const old = await tx
        .select()
        .from(users)
        .where(eq(users.normalizedEmail, 'fixture@example.test'));
      let actorId = old[0]?.id;
      if (!actorId) {
        actorId = (
          await tx
            .insert(users)
            .values({
              email: 'fixture@example.test',
              normalizedEmail: 'fixture@example.test',
            })
            .returning()
        )[0].id;
        await tx.insert(organizations).values({ id: 1, name: 'Synthetic M1' });
        await tx
          .insert(memberships)
          .values({ userId: actorId, organizationId: 1, role: 'owner' });
        const lab = (
          await tx
            .insert(labs)
            .values({ name: 'Synthetic M1', createdBy: actorId })
            .returning()
        )[0];
        const devices = await tx
          .insert(entities)
          .values(
            Array.from({ length: 100 }, (_, i) => ({
              labId: lab.id,
              name: `Synthetic ${i}`,
              kind: 'equipment',
              reality: 'simulated',
              definitionId: 'sensor',
              definitionVersion: '1.0',
              definition: { properties: { temperature: { type: 'number' } } },
              configuration: { interval_ms: 1000 },
              createdBy: actorId!,
              updatedBy: actorId!,
            })),
          )
          .returning();
        const linked = await tx
          .insert(bindings)
          .values(
            devices.map((e) => {
              const id = randomUUID();
              return {
                id,
                entityId: e.id,
                programId: 'sensor.v1',
                source: `synthetic:${id}`,
                definitionId: 'sensor',
                definitionVersion: '1.0',
                definition: e.definition,
              };
            }),
          )
          .returning();
        await tx.insert(runs).values(
          linked.map((binding) => ({
            entityId: binding.entityId,
            bindingId: binding.id,
            generation: 1,
            configuration: { interval_ms: 1000 },
            status: 'running',
            startedBy: actorId!,
          })),
        );
      }
      const devices = await tx
        .select({ entity_id: entities.id, run_id: runs.id })
        .from(entities)
        .innerJoin(runs, eq(runs.entityId, entities.id))
        .orderBy(entities.id);
      return { actor_id: actorId, devices };
    },
  );
  const app = createApp(context, version);
  type Subscriber = { pending: string[]; active: boolean; wake?: () => void };
  const subscribers = new Set<Subscriber>();
  let revision = 0;
  const publish = (samples: Sample[]) => {
    const message = JSON.stringify({ revision: ++revision, samples });
    if (Buffer.byteLength(message) > 1024 * 1024)
      throw new Error('SSE event exceeds retained budget');
    for (const subscriber of subscribers) {
      if (subscriber.pending.length >= 8) {
        subscriber.active = false;
        subscriber.wake?.();
        continue;
      }
      subscriber.pending.push(message);
      subscriber.wake?.();
    }
  };
  app.get('/proof/devices', (c) => c.json(seed));
  const persist = async (requestId: string, samples: Sample[]) => {
    const committed = await db.transaction(
      { id: requestId, kind: 'request', budget: 10 },
      async (tx) => {
        await tx
          .select()
          .from(memberships)
          .where(eq(memberships.userId, seed.actor_id!));
        const records = samples.map((sample) => {
          const device = seed.devices.find(
            (d) => d.entity_id === sample.entity_id,
          );
          if (!device) throw new Error('Unknown fixture device');
          return {
            id: sample.id,
            entityId: sample.entity_id,
            runId: device.run_id,
            observedAt: sample.received_at,
            receivedAt: sample.received_at,
            data: {
              value: sample.value,
              sequence: sample.sequence,
              received_at: sample.received_at,
            },
          };
        });
        const inserted = await tx.insert(history).values(records).returning();
        await tx
          .insert(observations)
          .values(
            records.map((r) => ({
              entityId: r.entityId,
              runId: r.runId,
              sequence: (r.data as { sequence: number }).sequence,
              source: 'synthetic:fixture',
              values: { temperature: (r.data as { value: number }).value },
              observedAt: r.receivedAt,
              receivedAt: r.receivedAt,
              quality: 'good',
            })),
          )
          .onConflictDoUpdate({
            target: observations.entityId,
            set: {
              sequence: sql`excluded.sequence`,
              values: sql`excluded.values`,
              receivedAt: sql`excluded.received_at`,
              observedAt: sql`excluded.observed_at`,
            },
          });
        return inserted.map((r) => ({
          id: r.id,
          entity_id: r.entityId,
          received_at: utcInstant(r.receivedAt),
          data: r.data,
        }));
      },
    );
    publish(samples);
    return committed;
  };
  app.post('/proof/samples', async (c) => {
    const parsed = z
      .array(Sample)
      .min(1)
      .max(100)
      .safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: 'Invalid synthetic sample' }, 422);
    const samples = parsed.data;
    const committed = await persist(c.get('requestId'), samples);
    return c.json({ committed }, 201);
  });
  app.get('/proof/burst', (c) =>
    stream(c, async (output) => {
      let active = true;
      output.onAbort(() => {
        active = false;
      });
      const entityId = c.req.query('entity_id')!;
      for (let sequence = 1; active && sequence <= 100000; sequence++) {
        const committed = await persist(`${c.get('requestId')}:${sequence}`, [
          {
            id: randomUUID(),
            entity_id: entityId,
            received_at: new Date().toISOString(),
            value: sequence,
            sequence,
          },
        ]);
        await output.write(JSON.stringify({ committed }) + '\n');
      }
    }),
  );
  app.get('/proof/history', async (c) => {
    const entityId = c.req.query('entity_id');
    const count = Number(c.req.query('limit') ?? 100);
    if (!entityId || !Number.isInteger(count) || count < 1 || count > 100)
      return c.json({ error: 'Invalid query' }, 422);
    let cursor: { at: string; id: string } | undefined;
    if (c.req.query('cursor'))
      cursor = JSON.parse(
        Buffer.from(c.req.query('cursor')!, 'base64url').toString(),
      );
    const page = await db.read(
      { id: c.get('requestId'), kind: 'request', budget: 10 },
      async (tx) => {
        await tx
          .select()
          .from(memberships)
          .where(eq(memberships.userId, seed.actor_id!));
        return tx
          .select()
          .from(history)
          .where(
            and(
              eq(history.entityId, entityId),
              cursor
                ? or(
                    lt(history.receivedAt, cursor.at),
                    and(
                      eq(history.receivedAt, cursor.at),
                      lt(history.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(history.receivedAt), desc(history.id))
          .limit(count + 1);
      },
    );
    const items = page.slice(0, count).map((r) => ({
      id: r.id,
      entity_id: r.entityId,
      received_at: utcInstant(r.receivedAt),
      data: r.data,
    }));
    const last = items.at(-1);
    const next =
      page.length > count && last
        ? Buffer.from(
            JSON.stringify({ at: last.received_at, id: last.id }),
          ).toString('base64url')
        : null;
    return c.json({ items, next_cursor: next });
  });
  app.get('/proof/world', async (c) =>
    c.json(
      await db.read(
        { id: c.get('requestId'), kind: 'request', budget: 10 },
        async (tx) => {
          await tx
            .select()
            .from(memberships)
            .where(eq(memberships.userId, seed.actor_id!));
          return tx
            .select({
              id: entities.id,
              name: entities.name,
              values: observations.values,
              received_at: observations.receivedAt,
            })
            .from(entities)
            .leftJoin(observations, eq(observations.entityId, entities.id))
            .limit(100);
        },
      ),
    ),
  );
  app.get('/proof/stats', async (c) => {
    const selected = seed.devices.slice(0, 20).map((d) => d.entity_id);
    const rows = await db.read(
      { id: c.get('requestId'), kind: 'request', budget: 10 },
      async (tx) => {
        await tx
          .select()
          .from(memberships)
          .where(eq(memberships.userId, seed.actor_id!));
        return (
          await tx.execute(
            sql`select entity_id,count(*)::integer as samples,count(distinct(data->>'sequence'))::integer as sequences,min((data->>'sequence')::integer) as first_sequence,max((data->>'sequence')::integer) as last_sequence from lab.observation_history where entity_id in (${sql.join(
              selected.map((id) => sql`${id}::uuid`),
              sql`,`,
            )}) group by entity_id`,
          )
        ).rows;
      },
    );
    return c.json(rows);
  });
  app.get('/proof/metadata', async (c) =>
    c.json({
      database: await db.metadata(),
      node: process.version,
      platform: process.platform,
      memory: process.memoryUsage(),
      pglite: '0.5.8',
      relaxedDurability: false,
    }),
  );
  app.get('/proof/events', (c) =>
    streamSSE(c, async (stream) => {
      const subscriber: Subscriber = { pending: [], active: true };
      subscribers.add(subscriber);
      stream.onAbort(() => {
        subscriber.active = false;
        subscriber.wake?.();
      });
      try {
        await stream.writeSSE({
          event: 'snapshot',
          data: JSON.stringify({ revision }),
          id: String(revision),
        });
        while (subscriber.active) {
          if (subscriber.pending.length) {
            await stream.writeSSE({
              event: 'update',
              data: subscriber.pending.shift()!,
              id: String(revision),
            });
          } else
            await new Promise<void>((resolve) => {
              subscriber.wake = resolve;
            });
        }
      } finally {
        subscribers.delete(subscriber);
      }
    }),
  );
  return {
    app,
    stop: async () => {
      for (const subscriber of subscribers) {
        subscriber.active = false;
        subscriber.wake?.();
      }
    },
  };
}

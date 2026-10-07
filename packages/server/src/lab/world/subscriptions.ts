import { randomUUID } from 'node:crypto';
import {
  accessIn,
  revalidateIn,
  type AccessActor,
} from '../../core/api-keys/authentication.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { WorldService } from './use-cases.ts';
type Snapshot = Awaited<ReturnType<WorldService['snapshotIn']>>;
type Event = Record<string, unknown>;
type Subscription = {
  actor: AccessActor;
  lab: string;
  previous: Snapshot;
  available: boolean;
  pending: string[];
  controller?: ReadableStreamDefaultController<Uint8Array>;
  transfer?: () => void;
  closed: boolean;
  terminal?: Event;
};
const maximumBytes = 1024 * 1024,
  maximumPending = 8;
function encoded(event: Event) {
  const value = JSON.stringify(event);
  if (Buffer.byteLength(value) > maximumBytes)
    throw new PublicFailure(
      413,
      'lab.snapshot_too_large',
      'World exceeds the subscription payload limit',
    );
  return value;
}
export function worldChanges(previous: Snapshot, current: Snapshot) {
  const changes: Array<{
    collection: string;
    id: string;
    patch: Record<string, unknown> | null;
  }> = [];
  for (const collection of [
    'entities',
    'nodes',
    'assets',
    'relationships',
  ] as const) {
    const old = new Map(
        previous[collection].map((item) => [String(item.id), item]),
      ),
      next = new Map(
        current[collection].map((item) => [String(item.id), item]),
      );
    for (const [id, item] of next) {
      const prior = old.get(id);
      if (prior && JSON.stringify(prior) === JSON.stringify(item)) continue;
      const patch = prior
        ? Object.fromEntries(
            Object.entries(item).filter(
              ([key, value]) =>
                JSON.stringify((prior as Record<string, unknown>)[key]) !==
                JSON.stringify(value),
            ),
          )
        : item;
      changes.push({ collection, id, patch });
    }
    for (const id of old.keys())
      if (!next.has(id)) changes.push({ collection, id, patch: null });
  }
  return changes;
}
/** Created during startup: transport pulls enqueue work without inheriting HTTP DB scopes. */
export class WorldSubscriptions {
  readonly world: WorldService;
  readonly runtimeReady: () => boolean;
  private subscribers = new Set<Subscription>();
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<void>;
  private closing = false;
  private started = false;
  constructor(world: WorldService, runtimeReady: () => boolean) {
    this.world = world;
    this.runtimeReady = runtimeReady;
  }
  start() {
    if (this.started || this.closing) return;
    this.started = true;
    const loop = async () => {
      await this.tick();
      if (!this.closing) {
        this.timer = setTimeout(() => void loop(), 250);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => void loop(), 250);
    this.timer.unref();
  }
  async subscribe(headers: Headers, requestId: string, lab: string) {
    if (this.closing)
      throw new PublicFailure(
        503,
        'lab.unavailable',
        'Subscriptions are stopping',
      );
    const { actor, snapshot } = await this.world.context.db.transaction(
      { id: requestId, kind: 'request', budget: 10 },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
        );
        return { actor, snapshot: await this.world.snapshotIn(tx, lab) };
      },
    );
    if (this.closing)
      throw new PublicFailure(
        503,
        'lab.unavailable',
        'Subscriptions are stopping',
      );
    const available = this.runtimeReady(),
      subscriber: Subscription = {
        actor,
        lab,
        previous: snapshot,
        available,
        pending: [
          encoded({ type: 'snapshot', world: snapshot }),
          encoded({ type: 'runtime_status', available }),
        ],
        closed: false,
      };
    this.subscribers.add(subscriber);
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          subscriber.controller = controller;
        },
        pull: () =>
          new Promise<void>((resolve) => {
            if (subscriber.closed) resolve();
            else subscriber.transfer = resolve;
          }),
        cancel: () => {
          this.remove(subscriber);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    });
  }
  private remove(subscriber: Subscription) {
    subscriber.closed = true;
    subscriber.pending = [];
    this.subscribers.delete(subscriber);
    subscriber.transfer?.();
    subscriber.transfer = undefined;
  }
  private end(subscriber: Subscription, event: Event) {
    if (subscriber.closed) return;
    subscriber.terminal = event;
    subscriber.pending = [];
    try {
      subscriber.controller?.enqueue(
        new TextEncoder().encode('data: ' + encoded(event) + '\n\n'),
      );
      subscriber.controller?.close();
    } catch {
      /* Consumer cancellation can win the race. */
    }
    this.remove(subscriber);
  }
  private push(subscriber: Subscription, event: Event) {
    if (subscriber.closed || subscriber.terminal) return;
    if (subscriber.pending.length >= maximumPending) {
      this.end(subscriber, { type: 'resync', reason: 'slow_client' });
      return;
    }
    try {
      subscriber.pending.push(encoded(event));
    } catch {
      this.end(subscriber, { type: 'resync', reason: 'payload_limit' });
    }
  }
  private failure(subscriber: Subscription, error: unknown) {
    this.end(
      subscriber,
      error instanceof PublicFailure &&
        (error.status === 401 || error.status === 403)
        ? { type: 'access_ended' }
        : { type: 'resync', reason: 'source_unavailable' },
    );
  }
  private async transfer(subscriber: Subscription) {
    if (subscriber.closed || !subscriber.transfer || !subscriber.pending.length)
      return;
    const accessTimeout = setTimeout(
      () =>
        this.end(subscriber, {
          type: 'resync',
          reason: 'source_unavailable',
        }),
      3000,
    );
    try {
      const id = 'world:transfer:' + randomUUID();
      await this.world.context.db.operation({ id, kind: 'background' }, () =>
        this.world.context.db.read({ id, kind: 'background' }, async (tx) => {
          await revalidateIn(
            tx,
            this.world.context,
            this.world.policy,
            subscriber.actor,
            'lab:full',
          );
          // The same serial executor admission covers the credential check and synchronous handoff.
          if (subscriber.closed || subscriber.terminal) return;
          subscriber.controller!.enqueue(
            new TextEncoder().encode(
              'data: ' + subscriber.pending.shift()! + '\n\n',
            ),
          );
          subscriber.transfer?.();
          subscriber.transfer = undefined;
        }),
      );
    } catch (error) {
      this.failure(subscriber, error);
    } finally {
      clearTimeout(accessTimeout);
    }
  }
  async tick() {
    if (this.closing) return;
    if (this.current) return this.current;
    this.current = (async () => {
      for (const subscriber of this.subscribers) {
        if (subscriber.closed) continue;
        await this.transfer(subscriber);
        if (subscriber.closed) continue;
        const timeout = setTimeout(
          () =>
            this.end(subscriber, {
              type: 'resync',
              reason: 'source_unavailable',
            }),
          5000,
        );
        try {
          const id = 'world:poll:' + randomUUID();
          const snapshot = await this.world.context.db.operation(
            { id, kind: 'background', budget: 10 },
            () =>
              this.world.context.db.transaction(
                { id, kind: 'background' },
                async (tx) => {
                  await revalidateIn(
                    tx,
                    this.world.context,
                    this.world.policy,
                    subscriber.actor,
                    'lab:full',
                  );
                  return this.world.snapshotIn(tx, subscriber.lab);
                },
              ),
          );
          if (subscriber.closed) continue;
          const available = this.runtimeReady();
          if (available !== subscriber.available) {
            this.push(subscriber, { type: 'runtime_status', available });
            subscriber.available = available;
          }
          if (snapshot.version === subscriber.previous.version)
            this.push(subscriber, {
              type: 'heartbeat',
              version: snapshot.version,
            });
          else {
            this.push(subscriber, {
              type: 'update',
              version: snapshot.version,
              base_version: subscriber.previous.version,
              lab:
                JSON.stringify(snapshot.lab) ===
                JSON.stringify(subscriber.previous.lab)
                  ? null
                  : snapshot.lab,
              changes: worldChanges(subscriber.previous, snapshot),
            });
            subscriber.previous = snapshot;
          }
        } catch (error) {
          this.failure(subscriber, error);
        } finally {
          clearTimeout(timeout);
        }
      }
    })();
    try {
      await this.current;
    } finally {
      this.current = undefined;
    }
  }
  async stop() {
    this.closing = true;
    clearTimeout(this.timer);
    for (const subscriber of this.subscribers)
      this.end(subscriber, { type: 'resync', reason: 'source_unavailable' });
    await this.current;
  }
}

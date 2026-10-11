import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import {
  accessIn,
  revalidateIn,
  type AccessActor,
} from '../../core/api-keys/authentication.ts';
import {
  authenticateMachineIn,
  provisionMachineIn,
} from '../../core/machines/use-cases.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import { sql } from '../../platform/db/index.ts';
import type { WorldService } from '../world/use-cases.ts';
import { loadLab } from '../world/use-cases.ts';
import { worldId } from '../world/entities.ts';
import type { MotionFixture } from '../motion/fixture.ts';
import type { MotionTransport } from '../motion/gateway.ts';
import type {
  MotionSnapshot,
  MotionSessionControl,
  MotionSessionAck,
} from '../../../../contracts/src/motion/index.ts';
import {
  SessionParameters,
  type Session,
  type Start,
  type Snapshot,
} from './dto.ts';
import {
  createInstallationIn,
  installationIn,
  reserveSessionIn,
  snapshotIn,
  sessionIn,
  sessionColumns,
  sessionValue,
  sessionFailure,
  endSessionIn,
} from './store.ts';
export type SessionOptions = {
  enabled: boolean;
  graceMillis: number;
  ackMillis: number;
};
export type SourceStart = {
  session: Session;
  ticket: string;
  websocket_path: string;
};
export type OwnedSource = { stop: () => Promise<void> };
/** #72 supplies a real durable readiness receipt for this exact immutable snapshot. */
export interface RecordingAdmission {
  prepare(sessionId: string, snapshotHash: string): Promise<void>;
}
type Transition = {
  control: MotionSessionControl;
  deadline: number;
  baseline?: bigint;
  ack?: MotionSessionAck;
};
type Live = {
  session: Session;
  progress: number;
  pong: number;
  last?: MotionSnapshot;
  transport?: MotionTransport;
  source?: OwnedSource;
  transition?: Transition;
  connected: boolean;
  owned: boolean;
  fault?: string;
  initial: boolean;
};
type Ticket = {
  session: Session;
  actor?: AccessActor;
  machine?: string;
  role: 'viewer' | 'publisher';
  rate: 15 | 30;
  expires: number;
};
type Subscriber = {
  lab: string;
  actor: AccessActor;
  queue: Session[];
  controller?: ReadableStreamDefaultController<Uint8Array>;
  waiting?: () => void;
  closed: boolean;
};
export class SimulationSessions {
  readonly world: WorldService;
  readonly options: SessionOptions;
  readonly log: (entry: Record<string, unknown>) => void;
  private live = new Map<string, Live>();
  private tickets = new Map<string, Ticket>();
  private subscribers = new Set<Subscriber>();
  private timer?: ReturnType<typeof setInterval>;
  private current?: Promise<void>;
  private stopping = false;
  private checkedSubscribersAt = 0;
  private resource = new AsyncResource('simulation-session-owner');
  private launcher?: (input: SourceStart) => Promise<OwnedSource>;
  private fenceMotion: (id: string) => void = () => {};
  constructor(
    world: WorldService,
    options: SessionOptions,
    log: (entry: Record<string, unknown>) => void = () => {},
  ) {
    this.world = world;
    this.options = options;
    this.log = log;
  }
  configure(
    launcher: (input: SourceStart) => Promise<OwnedSource>,
    fence: (id: string) => void,
  ) {
    this.launcher = launcher;
    this.fenceMotion = fence;
  }
  async initialize() {
    await this.world.context.db.transaction(
      { id: 'sessions:recovery:' + randomUUID(), kind: 'startup' },
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`select id::text from lab.simulation_sessions where ended_at is null`,
        );
        for (const row of rows.rows)
          await endSessionIn(
            tx,
            row.id,
            'interrupted',
            'server_restarted',
            this.world.context.clock.now(),
          );
      },
    );
    this.timer = setInterval(() => void this.tick(), 100);
    this.timer.unref();
  }
  private enabled() {
    if (!this.options.enabled || this.stopping)
      throw sessionFailure(
        'synthetic_session_disabled',
        'Development synthetic Sessions are disabled',
        503,
      );
  }
  /** There is no production caller bypass: a later backend must obtain this receipt first. */
  async requireRecordingReady(session: Session, recording: RecordingAdmission) {
    await recording.prepare(session.id, session.snapshot.hash);
  }
  private async audit(
    tx: Parameters<WorldService['snapshotIn']>[0],
    actor: AccessActor,
    requestId: string,
    id: string,
    action: string,
  ) {
    await databaseAudit.record(tx, {
      actorId: actor.user.id,
      actorType: actor.isApiKey ? 'agent' : 'user',
      action: 'lab.session.' + action,
      resourceType: 'lab.simulation_session',
      resourceId: id,
      requestId,
      correlationId: requestId,
      metadata: {},
    });
  }
  async installations(headers: Headers, requestId: string, lab: string) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
        );
        await loadLab(tx, lab);
        const result = await tx.execute<{
          metadata: Snapshot['installation'];
          archived_at: string | null;
        }>(
          sql`select metadata,archived_at from lab.scene_installations where lab_id=${lab}::uuid order by created_at,id`,
        );
        return {
          data: result.rows.map((row) => ({
            ...row.metadata,
            archived_at: row.archived_at,
          })),
        };
      },
    );
  }
  async install(
    headers: Headers,
    requestId: string,
    lab: string,
    representation: string,
  ) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
          true,
        );
        this.enabled();
        const installation = await createInstallationIn(
          tx,
          this.world,
          lab,
          representation,
          actor.user.id,
          this.world.context.clock.now(),
        );
        await this.audit(tx, actor, requestId, installation.id, 'install');
        return installation;
      },
    );
  }
  async archiveInstallation(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
  ) {
    await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
          true,
        );
        await installationIn(tx, lab, id);
        const active = await tx.execute(
          sql`select id from lab.simulation_sessions where installation_id=${id}::uuid and ended_at is null`,
        );
        if (active.rows.length)
          throw sessionFailure(
            'installation_in_use',
            'Stop the active Session before archiving this Installation',
          );
        await tx.execute(
          sql`update lab.scene_installations set archived_at=coalesce(archived_at,${this.world.context.clock.now()}::timestamptz) where id=${id}::uuid`,
        );
        await this.audit(tx, actor, requestId, id, 'installation.archive');
      },
    );
  }
  async list(headers: Headers, requestId: string, lab: string) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
        );
        await loadLab(tx, lab);
        const result = await tx.execute<Session>(
            sql`select ${sessionColumns} from lab.simulation_sessions where lab_id=${lab}::uuid order by started_at desc,id desc limit 20`,
          ),
          data = result.rows.map(sessionValue);
        return {
          data,
          active_session_id: data.find((s) => !s.ended_at)?.id ?? null,
          development_synthetic_enabled: this.options.enabled,
        };
      },
    );
  }
  async get(headers: Headers, requestId: string, lab: string, id: string) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
        );
        return sessionIn(tx, lab, id);
      },
    );
  }
  async start(headers: Headers, requestId: string, lab: string, input: Start) {
    const result = await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
          true,
        );
        this.enabled();
        const installation = await installationIn(
            tx,
            lab,
            input.installation_id,
          ),
          parameters = SessionParameters.parse({
            translation_amplitude: 0.45,
            angular_speed: 1,
            joint_amplitude: 1,
            ...input.parameters,
          });
        const snapshot = await snapshotIn(
          tx,
          this.world,
          installation,
          parameters,
        );
        const machine = input.machine_id
          ? { machine: { id: input.machine_id }, credential: undefined }
          : await provisionMachineIn(
              tx,
              actor.user.id,
              'Development synthetic Session',
              this.world.context.clock.now(),
            );
        const session = await reserveSessionIn(
          tx,
          lab,
          installation.id,
          machine.machine.id,
          snapshot,
          actor.user.id,
          this.world.context.clock.now(),
        );
        await this.audit(tx, actor, requestId, session.id, 'start');
        return { session, credential: machine.credential };
      },
    );
    return this.activate(result.session, result.credential, requestId);
  }
  private async activate(
    session: Session,
    credential: string | undefined,
    requestId: string,
  ) {
    const now = performance.now(),
      live: Live = {
        session,
        progress: now,
        pong: now,
        connected: false,
        owned: !!credential,
        initial: false,
      };
    this.live.set(session.id, live);
    if (this.stopping) {
      const ended = await this.world.context.db.transaction(
        { id: requestId, kind: 'request' },
        (tx) =>
          endSessionIn(
            tx,
            session.id,
            'interrupted',
            'server_shutdown',
            this.world.context.clock.now(),
          ),
      );
      if (ended) live.session = ended;
      await this.release(live);
      return live.session;
    }
    this.broadcast(session);
    if (!credential) return live.session;
    try {
      if (!this.launcher)
        throw new Error('Configured synthetic source unavailable');
      const admission = await this.admit(
        new Headers({ authorization: 'Bearer ' + credential }),
        requestId,
        session.lab_id,
        session.id,
        session.machine_id,
      );
      const owned = await this.resource.runInAsyncScope(
        this.launcher,
        undefined,
        {
          session: live.session,
          ticket: admission.ticket,
          websocket_path: admission.websocket_path,
        },
      );
      if (
        this.stopping ||
        this.live.get(session.id) !== live ||
        live.session.ended_at
      ) {
        await owned.stop();
        return live.session;
      }
      live.source = owned;
    } catch (error) {
      live.fault = 'source_unavailable';
      this.log({
        event: 'sessions.source_failed',
        session_id: session.id,
        message: error instanceof Error ? error.message : 'Source start failed',
      });
      // HTTP's transaction scope remains the owner of this compensation.
      const ended = await this.world.context.db.transaction(
        { id: requestId, kind: 'request' },
        (tx) =>
          endSessionIn(
            tx,
            session.id,
            'interrupted',
            'source_unavailable',
            this.world.context.clock.now(),
          ),
      );
      if (ended) {
        live.session = ended;
        this.broadcast(ended);
        await this.release(live);
      }
    }
    return live.session;
  }
  private issueTicket(record: Omit<Ticket, 'expires'>) {
    if (this.stopping)
      throw sessionFailure(
        'session_unavailable',
        'Simulation Sessions are stopping',
        503,
      );
    for (const [key, ticket] of this.tickets)
      if (ticket.expires <= performance.now()) this.tickets.delete(key);
    if (this.tickets.size >= 256)
      throw sessionFailure(
        'session_ticket_capacity',
        'Motion admission capacity reached',
        429,
      );
    const ticket = 's_' + randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      ...record,
      expires: performance.now() + 30_000,
    });
    return {
      ticket,
      expires_in_seconds: 30,
      websocket_path: `/api/v1/lab/motion/sessions/${record.session.id}/${record.role}`,
    };
  }
  async viewerTicket(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    rate: 15 | 30,
  ) {
    const { actor, session } = await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
            tx,
            this.world.context,
            this.world.policy,
            headers,
            'lab:full',
            true,
          ),
          session = await sessionIn(tx, lab, id);
        if (session.ended_at)
          throw sessionFailure(
            'session_closed',
            'Simulation Session has ended',
          );
        return { actor, session };
      },
    );
    return this.issueTicket({ actor, session, role: 'viewer', rate });
  }
  async admit(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    machine: string,
  ) {
    lab = worldId(lab);
    id = worldId(id);
    machine = worldId(machine);
    const session = await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await authenticateMachineIn(
          tx,
          machine,
          headers,
          this.world.context.clock.now(),
        );
        this.enabled();
        const session = await sessionIn(tx, lab, id);
        if (
          session.ended_at ||
          session.status !== 'starting' ||
          session.machine_id !== machine
        )
          throw sessionFailure(
            'publisher_unauthorized',
            'Publisher admission failed',
            403,
          );
        if (session.lease_id)
          throw sessionFailure(
            'publisher_conflict',
            'This Session already owns a Publisher lease',
          );
        const epoch = await tx.execute<{ value: string }>(
          sql`update lab.publisher_epoch set value=value+1 where singleton and value<18446744073709551615 returning value::text`,
        );
        if (!epoch.rows.length)
          throw sessionFailure(
            'publisher_capacity',
            'Publisher epoch range exhausted',
            503,
          );
        const lease = randomUUID();
        await tx.execute(
          sql`insert into lab.publisher_leases(id,session_id,machine_id,epoch) values(${lease}::uuid,${session.id}::uuid,${machine}::uuid,${epoch.rows[0].value}::numeric)`,
        );
        const changed = await tx.execute<Session>(
          sql`update lab.simulation_sessions set lease_id=${lease}::uuid,epoch=${epoch.rows[0].value}::numeric,revision=revision+1 where id=${session.id}::uuid returning ${sessionColumns}`,
        );
        return sessionValue(changed.rows[0]);
      },
    );
    const live = this.live.get(id);
    if (live && !live.session.ended_at) live.session = session;
    this.broadcast(session);
    return {
      ...this.issueTicket({ session, machine, role: 'publisher', rate: 30 }),
      lease_id: session.lease_id!,
      epoch: session.epoch!,
      bootstrap: {
        snapshot_hash: session.snapshot.hash,
        session_id: session.id,
        scene_hash: session.snapshot.installation.scene_hash,
        body_order: session.snapshot.installation.pose_keys,
        joint_order: session.snapshot.installation.joint_keys,
        initial_poses: session.snapshot.initial_poses,
        initial_joints: session.snapshot.initial_joints,
        parameters: session.snapshot.parameters,
      },
    };
  }
  ownsTicket(ticket: string) {
    return ticket.startsWith('s_');
  }
  async consume(ticket: string, id: string, role: 'viewer' | 'publisher') {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !record ||
      record.expires <= performance.now() ||
      record.session.id !== id ||
      record.role !== role ||
      this.stopping
    )
      throw sessionFailure(
        'publisher_unauthorized',
        'Motion admission failed',
        403,
      );
    const session = await this.world.context.db.transaction(
      { id: randomUUID(), kind: 'request' },
      async (tx) => {
        if (record.actor)
          await revalidateIn(
            tx,
            this.world.context,
            this.world.policy,
            record.actor,
            'lab:full',
          );
        const current = await sessionIn(tx, record.session.lab_id, id);
        if (current.ended_at)
          throw sessionFailure(
            'session_closed',
            'Simulation Session has ended',
            403,
          );
        if (role === 'publisher') {
          const valid = await tx.execute(
            sql`select m.id from labos_threejs_core.machines m join lab.publisher_leases l on l.machine_id=m.id where m.id=${record.machine}::uuid and m.revoked_at is null and m.expires_at>${this.world.context.clock.now()}::timestamptz and l.id=${record.session.lease_id}::uuid and l.ended_at is null and l.session_id=${id}::uuid`,
          );
          if (
            !valid.rows.length ||
            current.lease_id !== record.session.lease_id ||
            current.epoch !== record.session.epoch
          )
            throw sessionFailure(
              'publisher_unauthorized',
              'Publisher lease has ended',
              403,
            );
        }
        return current;
      },
    );
    const i = session.snapshot.installation;
    const metadata: MotionFixture = {
      session_id: id,
      lab_id: session.lab_id,
      scene_hash: i.scene_hash,
      mapping_revision: i.mapping_revision,
      pose_keys: i.pose_keys,
      joint_keys: i.joint_keys,
      targets: i.targets.map((t) => ({
        ...t,
        body_to_visual: {
          position: t.body_to_visual.position as [number, number, number],
          quaternion: t.body_to_visual.quaternion as [
            number,
            number,
            number,
            number,
          ],
        },
      })),
    };
    return {
      metadata,
      rate: record.rate,
      authority: {
        lease_id: session.lease_id,
        epoch: session.epoch ?? '0',
        state:
          session.status === 'paused' || session.status === 'resuming'
            ? ('paused' as const)
            : ('waiting' as const),
      },
    };
  }
  bind(id: string, lease: string, transport: MotionTransport) {
    const live = this.live.get(id);
    if (
      !live ||
      live.session.ended_at ||
      live.session.lease_id !== lease ||
      live.transport
    )
      throw sessionFailure(
        'publisher_conflict',
        'Publisher lease cannot be replaced',
      );
    live.transport = transport;
    live.connected = true;
    live.pong = performance.now();
    return {
      frame: (frame: MotionSnapshot) => {
        if (!this.valid(live, lease, transport))
          throw sessionFailure(
            'publisher_unauthorized',
            'Publisher is fenced',
            403,
          );
        if (live.transition?.ack && live.transition.control.action !== 'resume')
          throw sessionFailure(
            'session_boundary_closed',
            'Source emitted beyond the acknowledged boundary',
            400,
          );
        if (!live.initial) {
          const expected = live.session.snapshot;
          const equal = (a: number, b: number) =>
            Math.abs(a - b) <= Math.max(0.00001, Math.abs(b) * 0.000001);
          if (
            frame.sim_time_ns !== 0n ||
            frame.poses.some(
              (pose, index) =>
                pose.position.some(
                  (v, axis) =>
                    !equal(v, expected.initial_poses[index].position[axis]),
                ) ||
                pose.quaternion.some(
                  (v, axis) =>
                    !equal(v, expected.initial_poses[index].quaternion[axis]),
                ),
            ) ||
            frame.joints.some(
              (v, index) => !equal(v, expected.initial_joints[index]),
            )
          )
            throw sessionFailure(
              'session_initial_state_rejected',
              'Initial source frame must match the fixed Session state',
              400,
            );
        }
        const now = performance.now();
        if (live.session.status === 'paused')
          throw sessionFailure(
            'session_paused',
            'Paused source cannot emit new frames',
            400,
          );
        if (!live.last || frame.sim_time_ns > live.last.sim_time_ns)
          live.progress = now;
        live.last = frame;
        if (!live.initial) live.initial = true;
      },
      ack: (ack: MotionSessionAck) => {
        if (!this.valid(live, lease, transport)) return;
        const pending = live.transition,
          last = live.last;
        if (
          !pending ||
          pending.ack ||
          ack.session_id !== id ||
          ack.epoch !== live.session.epoch ||
          ack.transition_id !== pending.control.transition_id ||
          ack.revision !== pending.control.revision ||
          ack.action !== pending.control.action ||
          performance.now() > pending.deadline ||
          !last ||
          (pending.control.action !== 'stop' &&
            pending.baseline !== undefined &&
            last.sequence <= pending.baseline) ||
          ack.last_sequence !== String(last.sequence) ||
          ack.sim_time_ns !== String(last.sim_time_ns)
        )
          throw sessionFailure(
            'session_ack_rejected',
            'Source boundary acknowledgement rejected',
            400,
          );
        pending.ack = ack;
      },
      pong: () => {
        if (this.valid(live, lease, transport)) live.pong = performance.now();
      },
      leave: () => {
        if (this.valid(live, lease, transport)) {
          live.connected = false;
          live.transport = undefined;
          live.fault = 'publisher_disconnected';
        }
      },
    };
  }
  private valid(live: Live, lease: string, transport: MotionTransport) {
    return (
      this.live.get(live.session.id) === live &&
      !live.session.ended_at &&
      live.session.lease_id === lease &&
      live.transport === transport
    );
  }
  async transition(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    action: 'pause' | 'resume' | 'stop' | 'reset',
    expected: number,
  ) {
    lab = worldId(lab);
    id = worldId(id);
    let owner: Live | undefined;
    let credential: string | undefined;
    const result = await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
            tx,
            this.world.context,
            this.world.policy,
            headers,
            'lab:full',
            true,
          ),
          session = await sessionIn(tx, lab, id),
          live = this.live.get(id);
        if (
          session.ended_at ||
          session.revision !== expected ||
          !live ||
          live.transition ||
          (action === 'pause' && session.status !== 'running') ||
          (action === 'resume' && session.status !== 'paused')
        )
          throw sessionFailure(
            'session_conflict',
            'Session changed or has a transition in progress',
          );
        owner = live;
        if (action === 'reset') {
          const successor = randomUUID();
          await endSessionIn(
            tx,
            id,
            'reset',
            'reset_requested',
            this.world.context.clock.now(),
            successor,
          );
          const machine = live.owned
            ? await provisionMachineIn(
                tx,
                actor.user.id,
                'Development synthetic Session',
                this.world.context.clock.now(),
              )
            : { machine: { id: session.machine_id }, credential: undefined };
          credential = machine.credential;
          const next = await reserveSessionIn(
            tx,
            lab,
            session.installation_id,
            machine.machine.id,
            session.snapshot,
            actor.user.id,
            this.world.context.clock.now(),
            successor,
          );
          await this.audit(tx, actor, requestId, id, action);
          return next;
        }
        const status =
          action === 'pause'
            ? 'pausing'
            : action === 'resume'
              ? 'resuming'
              : 'stopping';
        const changed = await tx.execute<Session>(
          sql`update lab.simulation_sessions set status=${status},revision=revision+1 where id=${id}::uuid returning ${sessionColumns}`,
        );
        await this.audit(tx, actor, requestId, id, action);
        return sessionValue(changed.rows[0]);
      },
    );
    const live = owner!;
    if (this.stopping && action !== 'reset') {
      return this.world.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          await endSessionIn(
            tx,
            id,
            'interrupted',
            'server_shutdown',
            this.world.context.clock.now(),
          );
          return sessionIn(tx, lab, id);
        },
      );
    }
    if (action === 'reset') {
      live.session = {
        ...live.session,
        status: 'reset',
        ended_at: this.world.context.clock.now(),
        successor_session_id: result.id,
        revision: live.session.revision + 1,
      };
      this.broadcast(live.session);
      await this.release(live);
      return this.activate(result, credential, requestId);
    }
    live.session = result;
    this.broadcast(result);
    const control: MotionSessionControl = {
      type: 'motion.session_control',
      session_id: id,
      epoch: result.epoch ?? '0',
      transition_id: randomUUID(),
      revision: result.revision,
      action,
    };
    live.transition = {
      control,
      deadline: performance.now() + this.options.ackMillis,
      baseline: live.last?.sequence,
    };
    if (!live.transport?.open || live.transport.bufferedAmount > 64 * 1024)
      live.fault = 'source_control_unavailable';
    else live.transport.send(JSON.stringify(control));
    return result;
  }
  private async release(live: Live) {
    this.fenceMotion(live.session.id);
    live.transport?.close(1000, 'session_closed');
    live.transport = undefined;
    for (const [key, ticket] of this.tickets)
      if (ticket.session.id === live.session.id) this.tickets.delete(key);
    const source = live.source;
    live.source = undefined;
    if (source) await source.stop();
    if (this.live.get(live.session.id) === live)
      this.live.delete(live.session.id);
  }
  private broadcast(session: Session) {
    for (const subscriber of this.subscribers)
      if (subscriber.lab === session.lab_id && !subscriber.closed) {
        if (subscriber.queue.length >= 8) this.endSubscriber(subscriber);
        else {
          subscriber.queue.push(session);
          subscriber.waiting?.();
          subscriber.waiting = undefined;
        }
      }
  }
  private endSubscriber(subscriber: Subscriber) {
    subscriber.closed = true;
    subscriber.waiting?.();
    subscriber.waiting = undefined;
    this.subscribers.delete(subscriber);
    try {
      subscriber.controller?.close();
    } catch {
      /* cancellation won */
    }
  }
  async subscribe(headers: Headers, requestId: string, lab: string) {
    lab = worldId(lab);
    const { actor, session } = await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
        );
        await loadLab(tx, lab);
        const rows = await tx.execute<Session>(
          sql`select ${sessionColumns} from lab.simulation_sessions where lab_id=${lab}::uuid order by started_at desc,id desc limit 1`,
        );
        return {
          actor,
          session: rows.rows[0] ? sessionValue(rows.rows[0]) : undefined,
        };
      },
    );
    if (this.stopping)
      throw sessionFailure(
        'session_unavailable',
        'Simulation Sessions are stopping',
        503,
      );
    const subscriber: Subscriber = {
      lab,
      actor,
      queue: session ? [session] : [],
      closed: false,
    };
    this.subscribers.add(subscriber);
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          subscriber.controller = controller;
          // Flush authenticated stream readiness even when this Lab has no Session.
          controller.enqueue(
            new TextEncoder().encode(': session lifecycle ready\n\n'),
          );
        },
        pull: () =>
          this.resource.runInAsyncScope(async () => {
            if (subscriber.closed) return;
            if (!subscriber.queue.length)
              await new Promise<void>((resolve) => {
                subscriber.waiting = resolve;
              });
            if (subscriber.closed) return;
            try {
              await this.world.context.db.read(
                { id: 'sessions:sse:' + randomUUID(), kind: 'background' },
                async (tx) => {
                  await revalidateIn(
                    tx,
                    this.world.context,
                    this.world.policy,
                    subscriber.actor,
                    'lab:full',
                  );
                  if (subscriber.closed) return;
                  const next = subscriber.queue.shift();
                  if (next)
                    subscriber.controller!.enqueue(
                      new TextEncoder().encode(
                        'data: ' +
                          JSON.stringify({ type: 'session', session: next }) +
                          '\n\n',
                      ),
                    );
                },
              );
            } catch {
              this.endSubscriber(subscriber);
            }
          }),
        cancel: () => this.endSubscriber(subscriber),
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
  async tick() {
    if (this.stopping) return;
    if (this.current) return this.current;
    this.current = this.resource
      .runInAsyncScope(async () => {
        if (performance.now() - this.checkedSubscribersAt >= 5000) {
          this.checkedSubscribersAt = performance.now();
          for (const subscriber of this.subscribers)
            try {
              await this.world.context.db.read(
                {
                  id: 'sessions:sse-access:' + randomUUID(),
                  kind: 'background',
                },
                (tx) =>
                  revalidateIn(
                    tx,
                    this.world.context,
                    this.world.policy,
                    subscriber.actor,
                    'lab:full',
                  ),
              );
            } catch {
              this.endSubscriber(subscriber);
            }
        }
        for (const live of this.live.values()) {
          if (live.session.ended_at) continue;
          const now = performance.now(),
            transition = live.transition;
          let target: Session['status'] | undefined, reason: string | undefined;
          if (live.fault === 'machine_revoked') {
            target = 'interrupted';
            reason = 'machine_revoked';
          } else if (transition?.ack) {
            target =
              transition.control.action === 'pause'
                ? 'paused'
                : transition.control.action === 'resume'
                  ? 'running'
                  : 'stopped';
            live.transition = undefined;
            live.progress = now;
          } else if (transition && now > transition.deadline) {
            target = 'interrupted';
            reason = 'source_ack_timeout';
          } else if (
            live.fault &&
            (!live.connected || live.fault !== 'publisher_disconnected') &&
            now - live.pong >= this.options.graceMillis
          ) {
            target = 'interrupted';
            reason = live.fault;
          } else if (now - live.pong >= this.options.graceMillis) {
            target = 'interrupted';
            reason = 'publisher_heartbeat_timeout';
          } else if (live.session.status === 'starting' && live.initial) {
            target = 'running';
          } else if (
            (live.session.status === 'running' ||
              live.session.status === 'starting') &&
            now - live.progress >= this.options.graceMillis
          ) {
            target = 'interrupted';
            reason = 'source_progress_timeout';
          }
          if (!target) continue;
          const changed = await this.world.context.db.transaction(
            { id: 'sessions:transition:' + randomUUID(), kind: 'background' },
            async (tx) => {
              if (target === 'interrupted' || target === 'stopped')
                return endSessionIn(
                  tx,
                  live.session.id,
                  target,
                  reason ?? 'stop_requested',
                  this.world.context.clock.now(),
                );
              const result = await tx.execute<Session>(
                sql`update lab.simulation_sessions set status=${target},revision=revision+1 where id=${live.session.id}::uuid and lease_id=${live.session.lease_id}::uuid and ended_at is null returning ${sessionColumns}`,
              );
              return result.rows[0] ? sessionValue(result.rows[0]) : undefined;
            },
          );
          if (changed) {
            live.session = changed;
            this.broadcast(changed);
            if (changed.ended_at) await this.release(live);
          }
        }
      })
      .catch((error) =>
        this.log({
          event: 'sessions.tick_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    try {
      await this.current;
    } finally {
      this.current = undefined;
    }
  }
  motionState(id: string) {
    const live = this.live.get(id),
      status = live?.session.status;
    if (live && !live.connected && live.initial && !live.session.ended_at)
      return 'stale';
    if (status === 'paused' || status === 'resuming') return 'paused';
    if (status === 'running' || status === 'pausing')
      return live &&
        (!live.connected || performance.now() - live.progress > 1000)
        ? 'stale'
        : 'live';
    if (status === 'interrupted') return 'interrupted';
    return status === 'stopped' || status === 'reset' ? 'closed' : 'waiting';
  }
  sourceExited(id: string) {
    const live = this.live.get(id);
    if (live && !live.session.ended_at) {
      live.connected = false;
      live.fault = 'source_exited';
    }
  }
  async machineRevoked(id: string) {
    for (const live of this.live.values())
      if (live.session.machine_id === id && !live.session.ended_at) {
        live.fault = 'machine_revoked';
        live.pong = 0;
        live.transport?.close(1008, 'unauthorized');
      }
    await this.resource.runInAsyncScope(() => this.tick());
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    await this.current;
    for (const live of this.live.values())
      if (!live.session.ended_at) {
        const changed = await this.resource.runInAsyncScope(() =>
          this.world.context.db.transaction(
            { id: 'sessions:shutdown:' + randomUUID(), kind: 'background' },
            (tx) =>
              endSessionIn(
                tx,
                live.session.id,
                'interrupted',
                'server_shutdown',
                this.world.context.clock.now(),
              ),
          ),
        );
        if (changed) live.session = changed;
        await this.release(live);
      }
    this.tickets.clear();
    for (const subscriber of this.subscribers) this.endSubscriber(subscriber);
    this.resource.emitDestroy();
  }
}

import {
  decodeMotionSnapshot,
  type MotionErrorCode,
  type MotionWelcome,
  type MotionSnapshot,
} from '../../../../contracts/src/motion/index.ts';
import type { MotionFixture } from './fixture.ts';

// The protocol depends on this bounded transport surface, not WebSocket itself.
export type MotionTransport = {
  readonly bufferedAmount: number;
  readonly open: boolean;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
};
type Viewer = {
  transport: MotionTransport;
  rate: 15 | 30;
  pending?: Uint8Array;
  sentAt: number;
  blockedAt?: number;
};
type Session = {
  metadata: MotionFixture;
  epoch: bigint;
  publisher?: MotionTransport;
  latest?: Uint8Array;
  sequence?: bigint;
  simTime?: bigint;
  receivedAt: number;
  budgetAt: number;
  budget: number;
  viewers: Set<Viewer>;
  state: 'waiting' | 'live' | 'stale' | 'interrupted';
};
export const motionBudgets = {
  softBytes: 64 * 1024,
  hardBytes: 256 * 1024,
  slowMillis: 2000,
  freshnessMillis: 1000,
  viewers: 64,
} as const;
export class MotionGateway {
  private sessions = new Map<string, Session>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor() {
    this.timer = setInterval(() => this.flush(performance.now()), 8);
    this.timer.unref();
  }
  private session(metadata: MotionFixture) {
    let session = this.sessions.get(metadata.session_id);
    if (!session) {
      session = {
        metadata,
        epoch: 0n,
        receivedAt: 0,
        budgetAt: 0,
        budget: 60,
        viewers: new Set(),
        state: 'waiting',
      };
      this.sessions.set(metadata.session_id, session);
    }
    return session;
  }
  private welcome(session: Session, rate: 15 | 30): MotionWelcome {
    return {
      ...session.metadata,
      type: 'motion.welcome',
      version: 1,
      epoch: String(session.epoch),
      codec: 'pose-f32-v1',
      coordinate_frame: 'rh-y-up-m',
      rate_hz: rate,
      simulation_rate: 1,
    };
  }
  private control(transport: MotionTransport, message: unknown) {
    if (!transport.open) return;
    if (transport.bufferedAmount > motionBudgets.softBytes) {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'motion.welcome'
      )
        transport.close(1008, 'slow_viewer');
      return;
    }
    transport.send(JSON.stringify(message));
  }
  reject(transport: MotionTransport, code: MotionErrorCode, message: string) {
    this.control(transport, { type: 'motion.error', code, message });
    transport.close(1008, code);
  }
  join(
    metadata: MotionFixture,
    role: 'publisher' | 'viewer',
    rate: 15 | 30,
    transport: MotionTransport,
  ) {
    if (this.stopped) {
      this.reject(transport, 'session_closed', 'Motion gateway is closed');
      return undefined;
    }
    const session = this.session(metadata);
    if (role === 'publisher') {
      if (session.publisher) {
        this.reject(
          transport,
          'publisher_conflict',
          'The fixture already has a Publisher',
        );
        return undefined;
      }
      session.epoch += 1n;
      session.publisher = transport;
      session.latest = undefined;
      session.sequence = undefined;
      session.simTime = undefined;
      session.budget = 60;
      session.budgetAt = performance.now();
      session.receivedAt = performance.now();
      session.state = 'waiting';
      for (const viewer of session.viewers) {
        viewer.pending = undefined;
        this.control(viewer.transport, this.welcome(session, viewer.rate));
      }
      this.control(transport, this.welcome(session, 30));
      return {
        receive: (bytes: Uint8Array) => this.publish(session, transport, bytes),
        leave: () => {
          if (session.publisher !== transport) return;
          session.publisher = undefined;
          session.state = 'interrupted';
          for (const viewer of session.viewers)
            this.control(viewer.transport, {
              type: 'motion.status',
              state: 'interrupted',
              rate_hz: viewer.rate,
            });
        },
      };
    }
    if (session.viewers.size >= motionBudgets.viewers) {
      this.reject(transport, 'limit_exceeded', 'Viewer capacity reached');
      return undefined;
    }
    const viewer: Viewer = {
      transport,
      rate,
      sentAt: -Infinity,
      pending: session.latest,
    };
    session.viewers.add(viewer);
    this.control(transport, this.welcome(session, rate));
    this.control(transport, {
      type: 'motion.status',
      state: session.state,
      rate_hz: rate,
    });
    this.flushViewer(viewer, performance.now());
    return {
      receive: () =>
        this.reject(transport, 'unauthorized', 'Viewers cannot publish motion'),
      leave: () => {
        viewer.pending = undefined;
        session.viewers.delete(viewer);
      },
    };
  }
  private publish(
    session: Session,
    transport: MotionTransport,
    bytes: Uint8Array,
  ) {
    if (session.publisher !== transport || !transport.open) {
      this.reject(transport, 'epoch_mismatch', 'Publisher is no longer active');
      return;
    }
    let snapshot: MotionSnapshot;
    try {
      snapshot = decodeMotionSnapshot(bytes, {
        epoch: session.epoch,
        mapping_revision: session.metadata.mapping_revision,
        body_count: session.metadata.pose_keys.length,
        joint_count: session.metadata.joint_keys.length,
      });
    } catch (error) {
      this.reject(
        transport,
        error && typeof error === 'object' && 'code' in error
          ? (error.code as MotionErrorCode)
          : 'invalid_message',
        'Motion snapshot was rejected',
      );
      return;
    }
    if (
      (session.sequence !== undefined &&
        snapshot.sequence <= session.sequence) ||
      (session.simTime !== undefined && snapshot.sim_time_ns < session.simTime)
    ) {
      this.reject(
        transport,
        'sequence_rejected',
        'Sequence or simulation time moved backwards',
      );
      return;
    }
    const now = performance.now();
    session.budget = Math.min(
      60,
      session.budget + (now - session.budgetAt) * 0.03,
    );
    session.budgetAt = now;
    if (session.budget < 1) {
      this.reject(
        transport,
        'rate_exceeded',
        'Publisher exceeded 30 Hz with a 60-frame burst budget',
      );
      return;
    }
    session.budget -= 1;
    session.sequence = snapshot.sequence;
    session.simTime = snapshot.sim_time_ns;
    session.receivedAt = now;
    session.latest = bytes.slice();
    if (session.state !== 'live') {
      session.state = 'live';
      for (const viewer of session.viewers)
        this.control(viewer.transport, {
          type: 'motion.status',
          state: 'live',
          rate_hz: viewer.rate,
        });
    }
    for (const viewer of session.viewers) viewer.pending = session.latest;
  }
  private flushViewer(viewer: Viewer, now: number) {
    if (!viewer.transport.open) {
      viewer.pending = undefined;
      return;
    }
    const queued = viewer.transport.bufferedAmount;
    if (queued > motionBudgets.hardBytes) {
      viewer.pending = undefined;
      viewer.transport.close(1008, 'slow_viewer');
      return;
    }
    if (queued > motionBudgets.softBytes) {
      viewer.blockedAt ??= now;
      if (viewer.rate === 30) {
        viewer.rate = 15;
        // Defer status until the transport drains; it shares the same byte budget.
      }
      if (now - viewer.blockedAt >= motionBudgets.slowMillis) {
        viewer.pending = undefined;
        viewer.transport.close(1008, 'slow_viewer');
      }
      return;
    }
    if (viewer.blockedAt !== undefined) {
      viewer.blockedAt = undefined;
      this.control(viewer.transport, {
        type: 'motion.status',
        state: 'live',
        rate_hz: viewer.rate,
      });
    }
    if (!viewer.pending || now - viewer.sentAt < 1000 / viewer.rate) return;
    const bytes = viewer.pending;
    viewer.pending = undefined;
    viewer.sentAt = now;
    viewer.transport.send(bytes);
  }
  private flush(now: number) {
    for (const session of this.sessions.values()) {
      if (
        session.state === 'live' &&
        now - session.receivedAt > motionBudgets.freshnessMillis
      ) {
        session.state = 'stale';
        for (const viewer of session.viewers)
          this.control(viewer.transport, {
            type: 'motion.status',
            state: 'stale',
            rate_hz: viewer.rate,
          });
      }
      for (const viewer of session.viewers) this.flushViewer(viewer, now);
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const session of this.sessions.values()) {
      session.publisher?.close(1001, 'server_shutdown');
      session.publisher = undefined;
      session.latest = undefined;
      for (const viewer of session.viewers) {
        viewer.pending = undefined;
        viewer.transport.close(1001, 'server_shutdown');
      }
      session.viewers.clear();
    }
    this.sessions.clear();
  }
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type {
  PublisherAdmission,
  SimulationSession,
} from '../../packages/contracts/src/generated/types.gen.ts';
import {
  assertAck,
  canonicalHeader,
  capturePolicy,
  digest,
  frameBatch,
  initialPrefix,
  mappingDigest,
  nextPrefix,
  sourceHeader,
  sourcePacket,
  type RecordingIdentity,
  type SourceAck,
} from './recording-wire-oracle.ts';
import {
  ownRecordingSocket,
  recordingEventually,
} from './recording-public-support.ts';

export type RecordingBootstrap = RecordingIdentity & {
  ticket: string;
  websocket_path: string;
  expires_in_seconds: number;
  capture_policy: typeof capturePolicy;
  limits: Record<string, number>;
};
export type RecordingAdmission = PublisherAdmission & {
  recording: RecordingBootstrap;
};
export type SessionControl = {
  type: 'motion.session_control';
  session_id: string;
  epoch: string;
  transition_id: string;
  revision: number;
  action: 'pause' | 'resume' | 'stop';
};
type Message = Record<string, unknown>;

function rawBytes(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
}

class Peer {
  socket: WebSocket;
  messages: Message[] = [];
  failure?: Error;
  constructor(
    url: string,
    hello: Message,
    role: string,
    scope: RecordingIdentity,
    origin?: string,
  ) {
    this.socket = new WebSocket(url, origin ? { origin } : undefined);
    ownRecordingSocket(this.socket, role, scope.session_id, scope.recording_id);
    this.socket.on('error', (error) => {
      this.failure = error;
    });
    this.socket.on('message', (data, binary) => {
      try {
        assert(!binary, 'Machine received unexpected binary control');
        assert(rawBytes(data).length <= 16384);
        assert(this.messages.length < 64, 'Verifier control inbox overflow');
        this.messages.push(JSON.parse(rawBytes(data).toString('utf8')));
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error('WireError');
        this.socket.terminate();
      }
    });
    this.socket.once('open', () => this.socket.send(JSON.stringify(hello)));
  }
  async take(
    type: string,
    predicate: (value: Message) => boolean = () => true,
  ) {
    const value = await recordingEventually(() => {
      const found = this.messages.find(
        (item) => item.type === type && predicate(item),
      );
      if (found) return found;
      if (this.failure) throw this.failure;
      if (this.socket.readyState === WebSocket.CLOSED)
        throw new Error('Machine closed before expected receipt');
      return undefined;
    }, Boolean);
    assert(value);
    this.messages.splice(this.messages.indexOf(value), 1);
    return value;
  }
}

export class RecordingMachine {
  readonly session: SimulationSession;
  readonly scope: RecordingIdentity;
  readonly live: Peer;
  readonly reliable: Peer;
  // Finite predetermined test inputs, retained independently of server data.
  readonly selected: Buffer[] = [];
  readonly events: Message[] = [];
  readonly packets: { bytes: Buffer; receipt: SourceAck }[] = [];
  private packetSequence = 0n;
  private sourceSequence = 0n;
  private eventSequence = 0n;
  private prefix: string;
  private pending = false;
  private pendingBytes?: Buffer;
  private ended = false;

  constructor(
    session: SimulationSession,
    admission: RecordingAdmission,
    apiUrl: string,
    origin?: string,
    recordingUrl?: string,
  ) {
    this.session = session;
    const bootstrap = admission.recording;
    assert(bootstrap, 'Formal admission has no Recording bootstrap');
    this.scope = {
      recording_id: bootstrap.recording_id,
      session_id: bootstrap.session_id,
      lease_id: bootstrap.lease_id,
      epoch: bootstrap.epoch,
      snapshot_hash: bootstrap.snapshot_hash,
      manifest_sha256: bootstrap.manifest_sha256,
      scene_hash: bootstrap.scene_hash,
      mapping_revision: bootstrap.mapping_revision,
      mapping_sha256: bootstrap.mapping_sha256,
    };
    assert.equal(this.scope.session_id, session.id);
    assert.equal(this.scope.lease_id, admission.lease_id);
    assert.equal(this.scope.epoch, admission.epoch);
    assert.equal(this.scope.snapshot_hash, session.snapshot.hash);
    assert.equal(this.scope.mapping_sha256, mappingDigest(session));
    assert.deepEqual(bootstrap.capture_policy, capturePolicy);
    const wsUrl = apiUrl.replace(/^http/, 'ws');
    const header = sourceHeader();
    this.prefix = initialPrefix(this.scope, header);
    this.live = new Peer(
      wsUrl + admission.websocket_path,
      {
        type: 'motion.hello',
        version: 1,
        codec: 'pose-f32-v1',
        role: 'publisher',
        session_id: session.id,
        scene_hash: session.snapshot.installation.scene_hash,
        ticket: admission.ticket,
        preferred_rate_hz: 30,
      },
      'manual-live-publisher',
      this.scope,
      origin,
    );
    this.reliable = new Peer(
      recordingUrl ?? wsUrl + bootstrap.websocket_path,
      {
        type: 'recording.hello',
        version: 1,
        codec: 'lwr1-source-v1',
        ticket: bootstrap.ticket,
        ...this.scope,
        source_header: header,
      },
      'manual-reliable-source',
      this.scope,
      origin,
    );
  }

  async ready() {
    const [live, reliable] = await Promise.all([
      this.live.take('motion.welcome'),
      this.reliable.take('recording.ready'),
    ]);
    assert.equal(live.session_id, this.session.id);
    assert.equal(live.epoch, this.scope.epoch);
    assert.deepEqual(
      live.pose_keys,
      this.session.snapshot.installation.pose_keys,
    );
    assert.deepEqual(
      live.joint_keys,
      this.session.snapshot.installation.joint_keys,
    );
    for (const [key, value] of Object.entries(this.scope))
      assert.equal(reliable[key], value);
    assert.equal(
      reliable.source_header_sha256,
      digest(canonicalHeader(sourceHeader())),
    );
    assert.equal(reliable.source_prefix_sha256, this.prefix);
    assert.deepEqual(reliable.capture_policy, capturePolicy);
    return { live, reliable };
  }

  private async submit(
    kind: 1 | 2 | 3,
    payload: Buffer,
    nextSource: bigint,
    nextEvent: bigint,
  ) {
    assert(!this.pending && !this.ended, 'Source submission after boundary');
    this.pending = true;
    const sequence = this.packetSequence + 1n;
    const packet = sourcePacket(this.scope, kind, sequence, payload);
    this.pendingBytes = packet.bytes;
    const prefix = nextPrefix(this.prefix, packet.digest);
    try {
      this.reliable.socket.send(packet.bytes);
      const ack = (await this.reliable.take(
        'recording.ack',
        (value) => value.source_packet_sequence === String(sequence),
      )) as SourceAck;
      assertAck(ack, this.scope, {
        packetSequence: sequence,
        packetHash: packet.digest,
        prefixHash: prefix,
        sourceSequence: nextSource,
        eventSequence: nextEvent,
        ended: kind === 3,
      });
      this.packetSequence = sequence;
      this.sourceSequence = nextSource;
      this.eventSequence = nextEvent;
      this.prefix = prefix;
      this.ended = kind === 3;
      this.packets.push({ bytes: packet.bytes, receipt: ack });
      assert(
        this.packets.length <= 32,
        'Verifier packet oracle exceeded bound',
      );
      return ack;
    } finally {
      this.pending = false;
      this.pendingBytes = undefined;
    }
  }

  async capture(frames: readonly Buffer[]) {
    assert(this.selected.length + frames.length <= 120);
    assert.equal(frames[0].readBigUInt64LE(16), this.sourceSequence + 1n);
    // Selection is witnessed before network submission, as an external input.
    this.selected.push(...frames.map((frame) => Buffer.from(frame)));
    return this.submit(
      1,
      frameBatch(frames),
      frames.at(-1)!.readBigUInt64LE(16),
      this.eventSequence,
    );
  }

  liveFrame(bytes: Buffer) {
    this.live.socket.send(bytes);
  }

  async control(action: SessionControl['action']) {
    return (await this.live.take(
      'motion.session_control',
      (value) => value.action === action,
    )) as SessionControl;
  }

  async applied(control: SessionControl) {
    const last = this.selected.at(-1)!;
    const event = {
      source_event_sequence: String(this.eventSequence + 1n),
      event_id: randomUUID(),
      event_type: 'lifecycle.applied',
      subject: { session_id: this.session.id },
      sim_time_ns: String(last.readBigUInt64LE(24)),
      observed_at: null,
      event: {
        transition_id: control.transition_id,
        revision: control.revision,
        action: control.action,
        boundary_source_sequence: String(this.sourceSequence),
      },
    };
    this.events.push(event);
    await this.submit(
      2,
      Buffer.from(JSON.stringify(event)),
      this.sourceSequence,
      this.eventSequence + 1n,
    );
    return event;
  }

  async end(control: SessionControl) {
    assert.equal(control.action, 'stop');
    return this.submit(
      3,
      Buffer.from(
        JSON.stringify({
          transition_id: control.transition_id,
          revision: control.revision,
          reason: 'stop',
          last_source_sequence: String(this.sourceSequence),
          last_source_event_sequence: String(this.eventSequence),
          sim_time_ns: String(this.selected.at(-1)!.readBigUInt64LE(24)),
        }),
      ),
      this.sourceSequence,
      this.eventSequence,
    );
  }

  ack(control: SessionControl, frame = this.selected.at(-1)!) {
    this.live.socket.send(
      JSON.stringify({
        type: 'motion.session_ack',
        session_id: control.session_id,
        epoch: control.epoch,
        transition_id: control.transition_id,
        revision: control.revision,
        action: control.action,
        result: 'applied',
        last_sequence: String(frame.readBigUInt64LE(16)),
        sim_time_ns: String(frame.readBigUInt64LE(24)),
      }),
    );
  }

  async duplicateLast() {
    const last = this.packets.at(-1)!;
    this.reliable.socket.send(last.bytes);
    const ack = await this.reliable.take(
      'recording.ack',
      (value) =>
        value.source_packet_sequence === last.receipt.source_packet_sequence,
    );
    assert.deepEqual(ack, last.receipt);
    return ack;
  }

  retryPending() {
    assert(this.pendingBytes, 'No uncertain packet to retry');
    this.reliable.socket.send(this.pendingBytes);
  }
}

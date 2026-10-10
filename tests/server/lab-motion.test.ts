import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import {
  encodeMotionSnapshot,
  decodeMotionSnapshot,
  parseMotionWelcome,
  type MotionWelcome,
} from '../../packages/contracts/src/motion/index.ts';
import type { MotionFixture } from '../../packages/server/src/lab/motion/fixture.ts';
import {
  MotionGateway,
  motionBudgets,
  type MotionTransport,
} from '../../packages/server/src/lab/motion/gateway.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { MotionBuffer } from '../../packages/sdk/src/motion-buffer.ts';
import { parseMotionControl } from '../../packages/contracts/src/motion/index.ts';

type Ticket = { ticket: string; websocket_path: string };
class Peer {
  ws: WebSocket;
  controls: Record<string, unknown>[] = [];
  frames: Uint8Array[] = [];
  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url, { origin });
    this.ws.on('error', () => {});
    this.ws.on('message', (data, binary) => {
      if (binary) this.frames.push(new Uint8Array(data as Buffer));
      else
        this.controls.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
  }
  async hello(
    fixture: MotionFixture,
    role: 'viewer' | 'publisher',
    ticket: Ticket,
    rate: 15 | 30 = 30,
  ) {
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, 'open');
    this.ws.send(
      JSON.stringify({
        type: 'motion.hello',
        version: 1,
        role,
        session_id: fixture.session_id,
        scene_hash: role === 'publisher' ? fixture.scene_hash : undefined,
        codec: 'pose-f32-v1',
        ticket: ticket.ticket,
        preferred_rate_hz: rate,
      }),
    );
  }
  welcome() {
    return until(
      async () => this.controls.find((item) => item.type === 'motion.welcome'),
      (value) => !!value,
    ).then((value) => parseMotionWelcome(JSON.stringify(value)));
  }
  close() {
    this.ws.terminate();
  }
}
function snapshot(epoch: bigint, sequence: bigint, time = sequence) {
  return encodeMotionSnapshot({
    epoch,
    sequence,
    sim_time_ns: time,
    mapping_revision: 1,
    poses: Array.from({ length: 20 }, (_, i) => ({
      position: [i, 0.5, 0] as const,
      quaternion: [0, 0, 0, 1] as const,
    })),
    joints: [0, 1, 2, 3, 4, 5],
  });
}

test('opt-in motion fixture rejects non-loopback binding and invalid configuration', () => {
  assert.equal(configuration({}).motionFixture, false);
  assert.throws(() => configuration({ LAB_WORD_MOTION_FIXTURE: 'yes' }));
  assert.throws(
    () =>
      configuration({
        LAB_WORD_MOTION_FIXTURE: 'true',
        LAB_WORD_HOST: '0.0.0.0',
      }),
    /loopback/,
  );
});

test(
  'real authenticated same-port admission, two Viewers, late snapshot, fencing and shutdown preserve persistent World',
  { timeout: 60000 },
  async () => {
    const target = await new ServerProcess().create();
    target.env = {
      APP_ORIGIN: target.url,
      FILE_PUBLIC_ORIGIN: target.url,
      LAB_WORD_MOTION_FIXTURE: 'true',
      RATE_LIMIT_ENABLED: 'false',
    };
    const peers: Peer[] = [];
    try {
      await target.start();
      const client = new CoreHttp(target.url);
      await client.register('motion-owner@example.test');
      const member = new CoreHttp(target.url);
      await member.register('motion-member@example.test');
      const lab = await client.json<{ id: string }>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Motion fixture' },
        201,
      );
      const path = `/api/v1/lab/labs/${lab.id}/motion-fixture`;
      const asset = await publishAsset(
        client,
        await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
      );
      await new CoreHttp(target.url).error(
        'POST',
        path,
        { representation_id: asset.representation.id },
        401,
        'auth.unauthorized',
      );
      await client.error(
        'POST',
        path,
        { representation_id: asset.representation.id },
        404,
        'lab.motion_fixture_disabled',
        { 'x-forwarded-for': '127.0.0.1' },
      );
      const csrf = client.csrf;
      client.csrf = undefined;
      await client.error(
        'POST',
        path,
        { representation_id: asset.representation.id },
        403,
        'auth.csrf',
      );
      client.csrf = csrf;
      const fixture = await client.json<MotionFixture>(
        'POST',
        path,
        { representation_id: asset.representation.id },
        201,
      );
      assert.equal(fixture.targets.length, 20);
      assert.equal(
        new Set(fixture.targets.map((entry) => entry.node_id)).size,
        20,
      );
      const before = await client.json<{
        nodes: { id: string; representation_id: string }[];
        version: string;
      }>('GET', `/api/v1/lab/labs/${lab.id}/world`);
      assert.equal(before.nodes.length, 20);
      for (const node of before.nodes)
        assert.equal(node.representation_id, asset.representation.id);
      await member.error(
        'POST',
        `${path}/${fixture.session_id}/publisher-tickets`,
        { preferred_rate_hz: 30 },
        403,
        'lab.motion_publisher_forbidden',
      );
      async function ticket(
        role: 'viewer' | 'publisher',
        actor = client,
        rate: 15 | 30 = 30,
      ) {
        return actor.json<Ticket>(
          'POST',
          `${path}/${fixture.session_id}/${role}-tickets`,
          { preferred_rate_hz: rate },
          201,
        );
      }
      function peer(role: 'viewer' | 'publisher') {
        const value = new Peer(
          target.url.replace('http:', 'ws:') +
            `/api/v1/lab/motion/sessions/${fixture.session_id}/${role}`,
          target.url,
        );
        peers.push(value);
        return value;
      }
      const bad = peer('viewer');
      await bad.hello(fixture, 'viewer', {
        ticket: 'invalid_ticket_value',
        websocket_path: '',
      });
      await until(
        async () => bad.controls.length,
        (value) => value > 0,
      );
      assert.ok(bad.controls.every((entry) => entry.type === 'motion.error'));
      assert.equal(bad.frames.length, 0);
      const ticketA = await ticket('viewer');
      const a = peer('viewer');
      await a.hello(fixture, 'viewer', ticketA);
      await a.welcome();
      const b = peer('viewer');
      await b.hello(fixture, 'viewer', await ticket('viewer', member, 15), 30);
      assert.equal((await b.welcome()).rate_hz, 15);
      const replay = peer('viewer');
      await replay.hello(fixture, 'viewer', ticketA);
      await until(
        async () => replay.controls[0],
        (entry) => !!entry,
      );
      assert.equal(replay.controls[0].type, 'motion.error');
      const pub = peer('publisher');
      await pub.hello(fixture, 'publisher', await ticket('publisher'));
      const welcome = await pub.welcome();
      assert.equal(welcome.epoch, '1');
      const conflicting = peer('publisher');
      await conflicting.hello(fixture, 'publisher', await ticket('publisher'));
      await until(
        async () => conflicting.controls[0],
        (entry) => !!entry,
      );
      assert.equal(conflicting.controls[0].code, 'publisher_conflict');
      const sequence = 9007199254740997n;
      pub.ws.send(snapshot(1n, sequence));
      await until(
        async () => [a.frames.length, b.frames.length],
        (counts) => counts.every((count) => count > 0),
      );
      assert.equal(decodeMotionSnapshot(a.frames[0]).sequence, sequence);
      assert.deepEqual(a.frames[0], b.frames[0]);
      assert.equal(a.frames[0].byteLength, 632);
      const late = peer('viewer');
      await late.hello(fixture, 'viewer', await ticket('viewer'));
      assert.equal((await late.welcome()).epoch, '1');
      await until(
        async () => late.frames.length,
        (count) => count > 0,
      );
      assert.deepEqual(late.frames[0], a.frames[0]);
      pub.ws.send(snapshot(1n, sequence));
      await until(
        async () =>
          pub.controls.some((entry) => entry.code === 'sequence_rejected'),
        Boolean,
      );
      await until(
        async () => pub.ws.readyState,
        (state) => state === WebSocket.CLOSED,
      );
      const replacement = peer('publisher');
      await replacement.hello(fixture, 'publisher', await ticket('publisher'));
      assert.equal((await replacement.welcome()).epoch, '2');
      replacement.ws.send(snapshot(1n, 1n));
      await until(
        async () =>
          replacement.controls.some((entry) => entry.code === 'epoch_mismatch'),
        Boolean,
      );
      assert.deepEqual(
        await client.json('GET', `/api/v1/lab/labs/${lab.id}/world`),
        before,
      );
      const child = target.child!;
      await target.stop();
      assert.equal(child.exitCode, 0, target.logs);
      assert.equal(a.ws.readyState, WebSocket.CLOSED);
      assert.equal(b.ws.readyState, WebSocket.CLOSED);
    } finally {
      peers.forEach((peer) => peer.close());
      await target.cleanup();
      console.log(
        JSON.stringify({
          event: 'motion.resources',
          ledger: target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

class BoundedSink implements MotionTransport {
  private queuedBytes = 0;
  bufferedReads = 0;
  get bufferedAmount() {
    this.bufferedReads += 1;
    return this.queuedBytes;
  }
  set bufferedAmount(value: number) {
    this.queuedBytes = value;
    this.bufferedReads = 0;
  }
  open = true;
  data: (string | Uint8Array)[] = [];
  closeCode?: number;
  send(data: string | Uint8Array) {
    this.data.push(data);
  }
  close(code: number) {
    this.closeCode = code;
    this.open = false;
  }
}
test('transport boundary isolates a blocked Viewer, keeps the latest complete frame and enforces byte limits', async () => {
  const gateway = new MotionGateway();
  const publisher = new BoundedSink(),
    fast = new BoundedSink(),
    slow = new BoundedSink();
  const fixture: MotionFixture = {
    session_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410a',
    lab_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410b',
    scene_hash: 'sha256:' + '0'.repeat(64),
    mapping_revision: 1,
    pose_keys: Array.from({ length: 20 }, (_, i) => String(i)),
    joint_keys: ['0', '1', '2', '3', '4', '5'],
    targets: [],
  };
  try {
    const admitted = gateway.join(fixture, 'publisher', 30, publisher)!;
    gateway.join(fixture, 'viewer', 30, fast);
    gateway.join(fixture, 'viewer', 30, slow);
    slow.bufferedAmount = motionBudgets.softBytes + 1;
    for (let i = 1; i <= 3; i++) admitted.receive(snapshot(1n, BigInt(i)));
    await until(
      async () => fast.data.filter((entry) => typeof entry !== 'string').length,
      (count) => count > 0,
    );
    assert.equal(
      slow.data.filter((entry) => typeof entry !== 'string').length,
      0,
    );
    slow.bufferedAmount = 0;
    await until(
      async () => slow.data.filter((entry) => typeof entry !== 'string').length,
      (count) => count > 0,
    );
    assert.equal(
      decodeMotionSnapshot(
        slow.data.find((entry) => entry instanceof Uint8Array) as Uint8Array,
      ).sequence,
      3n,
    );
    const status = slow.data
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => JSON.parse(entry) as MotionWelcome);
    assert.equal(status.at(-1)!.rate_hz, 15);
    slow.bufferedAmount = motionBudgets.hardBytes + 1;
    await until(
      async () => slow.open,
      (open) => !open,
    );
    assert.equal(slow.closeCode, 1008);
    admitted.receive(snapshot(1n, 4n));
    await until(
      async () =>
        fast.data.filter((entry) => entry instanceof Uint8Array).length,
      (count) => count > 1,
    );
  } finally {
    gateway.stop();
  }
});

test(
  'malformed actual WebSockets do not exhaust admission and normal shutdown releases the data lease',
  { timeout: 60000 },
  async () => {
    const target = await new ServerProcess().create();
    target.env = {
      APP_ORIGIN: target.url,
      FILE_PUBLIC_ORIGIN: target.url,
      LAB_WORD_MOTION_FIXTURE: 'true',
      RATE_LIMIT_ENABLED: 'false',
    };
    const sockets = new Set<ReturnType<typeof connect> | WebSocket>();
    let viewer: Peer | undefined;
    const route =
      '/api/v1/lab/motion/sessions/00000000-0000-0000-0000-000000000001/publisher';
    try {
      await target.start();
      for (let i = 0; i < 130; i++) {
        if (i % 2 === 0) {
          const socket = connect(target.port, '127.0.0.1');
          sockets.add(socket);
          socket.on('error', () => {});
          const closed = once(socket, 'close');
          await once(socket, 'connect');
          let response = '',
            upgraded = false;
          socket.on('data', (bytes) => {
            if (upgraded) return;
            response += bytes.toString();
            if (response.includes('101 Switching Protocols')) {
              upgraded = true;
              // Client WebSocket frames must be masked; this actual unmasked frame is illegal.
              socket.write(Buffer.from([0x81, 0x01, 0x78]));
            }
          });
          socket.write(
            `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
          await closed;
          assert.equal(
            upgraded,
            true,
            `Malformed connection ${i} was admitted without a leaked capacity slot`,
          );
          sockets.delete(socket);
        } else {
          const socket = new WebSocket(
            target.url.replace('http:', 'ws:') + route,
          );
          sockets.add(socket);
          socket.on('error', () => {});
          const closed = once(socket, 'close');
          await once(socket, 'open');
          socket.send(Buffer.alloc(65_537));
          await closed;
          sockets.delete(socket);
        }
      }
      const client = new CoreHttp(target.url);
      await client.register('malformed-motion-owner@example.test');
      const asset = await publishAsset(
        client,
        await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
      );
      const lab = await client.json<{ id: string }>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'After malformed frames' },
        201,
      );
      const path = `/api/v1/lab/labs/${lab.id}/motion-fixture`;
      const fixture = await client.json<MotionFixture>(
        'POST',
        path,
        { representation_id: asset.representation.id },
        201,
      );
      const ticket = await client.json<Ticket>(
        'POST',
        `${path}/${fixture.session_id}/viewer-tickets`,
        { preferred_rate_hz: 30 },
        201,
      );
      viewer = new Peer(
        target.url.replace('http:', 'ws:') + ticket.websocket_path,
        target.url,
      );
      await viewer.hello(fixture, 'viewer', ticket);
      assert.equal((await viewer.welcome()).session_id, fixture.session_id);
      const child = target.child!;
      await target.stop();
      assert.equal(child.exitCode, 0, target.logs);
      assert.equal(
        child.signalCode,
        null,
        'Normal shutdown must not require the harness SIGKILL deadline',
      );
      assert.equal(viewer.ws.readyState, WebSocket.CLOSED);
      // The previous database and directory lease are gone; the same owned data can reopen.
      await target.start();
      await client.login('malformed-motion-owner@example.test');
      assert.equal(
        (
          await client.json<{ lab: { id: string } }>(
            'GET',
            `/api/v1/lab/labs/${lab.id}/world`,
          )
        ).lab.id,
        lab.id,
      );
    } finally {
      for (const socket of sockets) {
        if (socket instanceof WebSocket) socket.terminate();
        else socket.destroy();
      }
      viewer?.close();
      await target.cleanup();
      console.log(
        JSON.stringify({
          event: 'motion.malformed.resources',
          ledger: target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

for (const sourceState of [
  'waiting',
  'live',
  'stale',
  'interrupted',
] as const) {
  test(`soft-pressure recovery preserves authoritative ${sourceState} state and lower rate`, async () => {
    const gateway = new MotionGateway();
    const publisher = new BoundedSink(),
      fast = new BoundedSink(),
      slow = new BoundedSink();
    const fixture: MotionFixture = {
      session_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410a',
      lab_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410b',
      scene_hash: 'sha256:' + '0'.repeat(64),
      mapping_revision: 1,
      pose_keys: Array.from({ length: 20 }, (_, i) => String(i)),
      joint_keys: ['0', '1', '2', '3', '4', '5'],
      targets: [],
    };
    try {
      const admitted = gateway.join(fixture, 'publisher', 30, publisher)!;
      gateway.join(fixture, 'viewer', 30, fast);
      gateway.join(fixture, 'viewer', 30, slow);
      slow.bufferedAmount = motionBudgets.softBytes + 1;
      if (sourceState !== 'waiting') admitted.receive(snapshot(1n, 1n));
      await until(
        async () => slow.bufferedReads,
        (reads) => reads >= 3,
      );
      if (sourceState === 'interrupted') admitted.leave();
      if (sourceState === 'stale')
        await until(
          async () =>
            fast.data
              .filter((entry): entry is string => typeof entry === 'string')
              .some((entry) => JSON.parse(entry).state === 'stale'),
          Boolean,
        );
      const countBeforeDrain = slow.data.length;
      slow.bufferedAmount = 0;
      await until(
        async () => slow.data.length,
        (count) => count > countBeforeDrain,
      );
      const controls = slow.data
        .slice(countBeforeDrain)
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => JSON.parse(entry));
      assert.equal(controls[0].type, 'motion.status');
      assert.equal(controls[0].state, sourceState);
      assert.equal(controls[0].rate_hz, 15);
      assert.equal(
        controls.some((entry) => entry.state === 'live'),
        sourceState === 'live',
      );
    } finally {
      gateway.stop();
    }
  });
}

for (const sourceState of ['stale', 'interrupted'] as const) {
  test(`public Gateway latejoin cache preserves ${sourceState} until live status and a new Snapshot`, async () => {
    const gateway = new MotionGateway(),
      publisher = new BoundedSink(),
      observer = new BoundedSink();
    const buffer = new MotionBuffer();
    const fixture: MotionFixture = {
      session_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410a',
      lab_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410b',
      scene_hash: 'sha256:' + '0'.repeat(64),
      mapping_revision: 1,
      pose_keys: ['body'],
      joint_keys: [],
      targets: [
        {
          pose_key: 'body',
          entity_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410c',
          node_id: 'd1866a94-e3f6-4b3b-815f-674ae08f410d',
          visual_target: 'node-root',
        },
      ],
    };
    const frame = (epoch: bigint, sequence: bigint, x: number) =>
      encodeMotionSnapshot({
        epoch,
        sequence,
        sim_time_ns: sequence,
        mapping_revision: 1,
        poses: [{ position: [x, 0, 0], quaternion: [0, 0, 0, 1] }],
        joints: [],
      });
    const received: string[] = [];
    const viewer: MotionTransport = {
      bufferedAmount: 0,
      open: true,
      close() {},
      send(data) {
        if (typeof data === 'string') {
          const control = parseMotionControl(data);
          received.push(
            control.type === 'motion.status' ? control.state : control.type,
          );
          if (control.type === 'motion.welcome') {
            buffer.configure(control);
            buffer.setSourceState('waiting');
          } else if (control.type === 'motion.status')
            buffer.setSourceState(control.state);
        } else {
          received.push('snapshot');
          assert.equal(
            buffer.push(decodeMotionSnapshot(data), performance.now()),
            true,
          );
        }
      },
    };
    try {
      const admission = gateway.join(fixture, 'publisher', 30, publisher)!;
      gateway.join(fixture, 'viewer', 30, observer);
      admission.receive(frame(1n, 1n, 7));
      if (sourceState === 'interrupted') admission.leave();
      else
        await until(
          async () =>
            observer.data
              .filter((entry): entry is string => typeof entry === 'string')
              .some((entry) => JSON.parse(entry).state === 'stale'),
          Boolean,
        );
      gateway.join(fixture, 'viewer', 30, viewer);
      assert.deepEqual(received, ['motion.welcome', sourceState, 'snapshot']);
      const receivedAt = performance.now();
      for (const tick of [0, 250, 500, 1000]) {
        assert.equal(buffer.freshness(receivedAt + tick), sourceState);
        assert.equal(buffer.sample(receivedAt + tick)!.poses[0].position[0], 7);
      }
      if (sourceState === 'stale') admission.receive(frame(1n, 2n, 20));
      else
        gateway
          .join(fixture, 'publisher', 30, new BoundedSink())!
          .receive(frame(2n, 1n, 20));
      await until(
        async () => buffer.freshness(performance.now()),
        (state) => state === 'live',
      );
      assert.equal(buffer.sample(performance.now())!.poses[0].position[0], 20);
      const liveIndex = received.lastIndexOf('live');
      assert.ok(liveIndex >= 0 && received[liveIndex + 1] === 'snapshot');
    } finally {
      gateway.stop();
      buffer.clear();
    }
  });
}

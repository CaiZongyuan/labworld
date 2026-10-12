/* Lab World — live isometric lab plate.
   Hairline isometric renderer on Canvas 2D in the Factory Yard / ai-iso-skill language:
   flat unlit facets, 1px lines, two greys plus one --live colour reserved for what is live,
   and a day that turns to night. The device programs mirror the server-owned ones in the
   real product: runs outlive the browser, observations carry provenance, and a task only
   runs inside tolerance. */

import { C3, S3, B } from './geo.js';
import { readTokens, shade, theme, CUR, rgb, rgba, scaled } from './theme.js';
import {
  room,
  bench,
  beaker,
  flask,
  tubeRack,
  petri,
  reagentBottle,
  monitor,
  microscope,
  centrifuge,
  rotor,
  sensor,
  lightStand,
  lightCone,
  robotCell,
  robotArm,
  assetShelf,
  serverCabinet,
  person,
  stool,
  gasCylinder,
  bioBin,
  wallCabinet,
  plant,
} from './models.js';

export function startLab(root, t, lifecycle) {
  const { listen, animationFrame, observe } = lifecycle;
  const WORLD = { x0: 0, x1: 26, y0: 0, y1: 18 };
  const ENT = {}; // id -> {id, kind, title, def, status(), rows(), acts[]}
  const ent = (id, kind, title, def, extra = {}) =>
    (ENT[id] = Object.assign({ id, kind, title, def }, extra));

  // where the moving parts are anchored, filled in while the static world is built
  const ANCH = { light: {}, sensor: {}, cent: null, robot: null, server: null };
  const TOPZ = 0.96; // a bench worktop surface

  function buildStatic() {
    const b = new B(null);
    room(b, WORLD.x1, WORLD.y1);

    bench(b, 3.2, 5.4, 3.2, 'bench-01');
    bench(b, 3.2, 9.4, 3.2, 'bench-02');
    bench(b, 8.0, 5.4, 3.2, 'bench-03');

    // ware on bench 01, reagents on the shelf above it
    b.ent = 'labware';
    beaker(b, 3.7, 5.95, TOPZ, 0.11, 0.28);
    beaker(b, 4.02, 6.14, TOPZ, 0.08, 0.36);
    flask(b, 4.42, 5.9, TOPZ);
    tubeRack(b, 4.82, 5.95, TOPZ, 6);
    petri(b, 5.62, 6.05, TOPZ, 4);
    reagentBottle(b, 3.7, 5.62, 1.725, 0.22, 'k');
    reagentBottle(b, 4.05, 5.66, 1.725, 0.18, 'g');
    reagentBottle(b, 4.38, 5.6, 1.725, 0.24, 'k');
    reagentBottle(b, 5.5, 5.66, 1.725, 0.17, 'g');
    b.ent = null;

    microscope(b, 8.7, 5.8, TOPZ, 'microscope');
    monitor(b, 3.6, 9.55, TOPZ, 'bench-02');
    stool(b, 4.5, 7.8);

    // the devices whose programs run on the server
    ANCH.cent = centrifuge(b, 7.4, 11.8, 'centrifuge');
    ANCH.sensor['sensor-a'] = sensor(b, 6.2, 8.6, 'sensor-a');
    ANCH.sensor['sensor-b'] = sensor(b, 12.6, 8.6, 'sensor-b');
    ANCH.light['light-a'] = lightStand(b, 4.4, 3.4, 'light-a');
    ANCH.light['light-b'] = lightStand(b, 11.4, 3.4, 'light-b');
    ANCH.robot = robotCell(b, 13.4, 9.4, 'robot');
    ANCH.server = serverCabinet(b, 22.2, 2.6, 'server');
    assetShelf(b, 19.4, 2.0, 'asset-shelf');

    wallCabinet(b, 15.6, 0.36);
    gasCylinder(b, 2.1, 3.0);
    bioBin(b, 17.4, 12.8);
    plant(b, 2.3, 15.8);
    return b.out;
  }

  /* ---------------- simulation: server-owned device programs ---------------- */
  const sim = {
    t: 0,
    hour: 8,
    paused: false,
    lights: {
      'light-a': {
        run: true,
        target: 0.8,
        obs: 0.8,
        pending: null,
        startedAt: 0,
      },
      'light-b': {
        run: false,
        target: 0.5,
        obs: 0,
        pending: null,
        startedAt: 0,
      },
    },
    sensors: {
      'sensor-a': { base: 21.4, src: 'sim.thermal.a', last: null, phase: 0.3 },
      'sensor-b': { base: 19.8, src: 'sim.thermal.b', last: null, phase: 2.1 },
    },
    cent: {
      state: 'idle',
      rpm: 0,
      target: 3000,
      temp: 22.4,
      task: null,
      angle: 0,
      elapsed: 0,
      done: 0,
    },
    robot: { a1: -1.5, a2: 0.95, a3: 0.5, phase: 0, carry: false },
    tech: { p: 0, pause: 0 },
    helper: { gait: 0 },
    sse: 0,
  };

  const WAY = [
    [3, 14.6],
    [9, 14.6],
    [9, 9.2],
    [15.4, 13.2],
    [19.2, 13.2],
    [19.6, 8.2],
    [13, 4.2],
    [6, 4.2],
    [2.6, 7],
    [2.6, 12],
  ];
  function simStep(dt) {
    sim.t += dt;
    sim.hour = (8 + sim.t / 10) % 24; // a day passes in four minutes
    // lights: a pending command becomes an observation one tick later
    for (const id in sim.lights) {
      const L = sim.lights[id];
      if (L.pending && sim.t >= L.pending.at) {
        L.obs = L.pending.val;
        L.pending = null;
      }
    }
    // sensors: two independent 1 Hz sources; heartbeats never refresh a measurement
    for (const id in sim.sensors) {
      const s = sim.sensors[id];
      if (Math.floor(sim.t) !== Math.floor(sim.t - dt)) {
        s.phase += 1;
        const v =
          s.base +
          Math.sin(sim.t / 47 + id.length) * 1.6 +
          Math.sin(sim.t / 9 + s.phase) * 0.25;
        s.last = {
          v: +v.toFixed(2),
          unit: '°C',
          src: s.src,
          q: 'good',
          at: sim.t,
        };
      }
    }
    // centrifuge: prepare -> run inside tolerance -> decelerate -> completed
    const c = sim.cent;
    if (c.task) {
      c.temp += (20.0 - c.temp) * Math.min(1, dt * 0.5);
      if (c.state === 'preparing') {
        c.rpm += (c.target - c.rpm) * Math.min(1, dt * 0.9);
        if (Math.abs(c.rpm - c.target) <= 50 && Math.abs(c.temp - 20) <= 0.5) {
          c.state = 'running';
          c.elapsed = 0;
        }
      } else if (c.state === 'running') {
        c.elapsed += dt;
        c.rpm += Math.sin(sim.t * 3) * 8;
        if (c.elapsed >= c.task.dur) c.state = 'decelerating';
      } else if (c.state === 'decelerating') {
        c.rpm += (0 - c.rpm) * Math.min(1, dt * 1.4);
        if (c.rpm < 20) {
          c.rpm = 0;
          c.state = 'completed';
          c.done++;
          c.task = null;
        }
      } else if (c.state === 'cancelled') {
        c.rpm += (0 - c.rpm) * Math.min(1, dt * 2);
        if (c.rpm < 20) {
          c.rpm = 0;
          c.state = 'idle';
          c.task = null;
        }
      }
    } else if (c.rpm > 0) {
      c.rpm += (0 - c.rpm) * Math.min(1, dt * 2);
      if (c.rpm < 20) c.rpm = 0;
    }
    c.angle += (c.rpm / 60) * dt * Math.PI * 2 * 0.05;
    // robot: lift a tray off the infeed station, swing over to the cart, set it down
    const r = sim.robot;
    r.phase += dt / 7;
    const cyc = r.phase % 1;
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const swing = cyc < 0.5 ? ease(cyc / 0.5) : 1 - ease((cyc - 0.5) / 0.5);
    r.a1 = -1.19 + swing * 1.43;
    r.a2 = 1.17 + Math.sin(swing * Math.PI) * 0.3; // the elbow tucks on the way over
    r.a3 = 0.67 - r.a1 - r.a2; // the gripper stays square to the cell
    r.carry = cyc > 0.2 && cyc < 0.72;
    // the technician walks the loop and pauses at benches
    const tc = sim.tech;
    if (tc.pause > 0) tc.pause -= dt;
    else {
      tc.p += dt * 0.5;
      const n = WAY.length;
      if (tc.p >= n) {
        tc.p -= n;
        tc.pause = 1.6 + Math.random() * 2.4;
      }
    }
    sim.helper.gait += dt * 0.42;
    if (Math.random() < dt * 2.2) sim.sse++;
  }
  const techPos = () => {
    const n = WAY.length,
      p = sim.tech.p;
    const i = ((Math.floor(p) % n) + n) % n,
      f = p - Math.floor(p),
      a = WAY[i],
      b = WAY[(i + 1) % n];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };

  function buildDynamic() {
    const b = new B(null);
    // luminaires: the reflector comes on, and throws a cone and a pool across the floor
    for (const id in sim.lights) {
      const L = sim.lights[id],
        h = ANCH.light[id];
      if (!h) continue;
      b.ent = id;
      b.cylZ(h.x, h.y, h.z - 0.06, 0.15, 0.05, L.run ? 'l' : 'dark', id, 12);
      if (L.run && L.obs > 0.02) {
        lightCone(b, h, L.obs);
        b.pool(h.x, h.y, 1.0 + L.obs * 1.5, L.obs, id);
      }
      b.ent = null;
    }
    // sensors: a fresh observation blinks on the head
    for (const id in sim.sensors) {
      const s = sim.sensors[id],
        a = ANCH.sensor[id];
      if (!a) continue;
      const fresh = s.last && sim.t - s.last.at < 0.3;
      b.ent = id;
      b.put(
        a.x - 0.12,
        a.y + 0.1,
        1.2,
        0.24,
        0.03,
        0.05,
        fresh ? 'v' : 'panel',
        id,
      );
      b.ent = null;
    }
    // the rotor, driven by observed RPM
    const c = sim.cent;
    if (ANCH.cent) {
      b.ent = 'centrifuge';
      rotor(
        b,
        ANCH.cent.cx,
        ANCH.cent.cy,
        ANCH.cent.z,
        c.angle,
        Math.min(1, c.rpm / c.target),
        c.state === 'running',
      );
      b.ent = null;
    }
    // the server's status bay blinks with SSE traffic
    if (ANCH.server) {
      b.put(
        ANCH.server.x,
        ANCH.server.y,
        ANCH.server.z,
        0.07,
        0.04,
        0.07,
        Math.floor(sim.t * 2) % 2 === 0 ? 'v' : 'dark',
        'server',
      );
      b.put(
        ANCH.server.x + 0.13,
        ANCH.server.y,
        ANCH.server.z,
        0.07,
        0.04,
        0.07,
        'v',
        'server',
      );
    }
    // the robot arm
    if (ANCH.robot) {
      b.ent = 'robot';
      robotArm(
        b,
        ANCH.robot,
        sim.robot.a1,
        sim.robot.a2,
        sim.robot.a3,
        sim.robot.carry,
      );
      b.ent = null;
    }
    // people
    const [tx, ty] = techPos();
    b.ent = 'tech';
    person(b, tx, ty, 0, sim.tech.p, { carry: sim.tech.pause > 0.6 });
    b.ent = null;
    person(b, 5.5, 8.6, TOPZ - 0.04, sim.helper.gait, {
      tone: 'n',
      seated: true,
    });
    return b.out;
  }

  /* ---------------- entities: what the card shows ---------------- */
  const hhmm = (h) =>
    `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  const ago = (at) => t('v.ago', { n: Math.max(0, sim.t - at).toFixed(1) });
  const centState = () => t(`cs.${sim.cent.state}`);
  const label = (E) => t(E.title, E.tvars);
  ent('light-a', 'kind.virtual', 'ent.lightA', 'light · 1.0');
  ent('light-b', 'kind.virtual', 'ent.lightB', 'light · 1.0');
  ent('sensor-a', 'kind.virtual', 'ent.sensorA', 'sensor · 1.0');
  ent('sensor-b', 'kind.virtual', 'ent.sensorB', 'sensor · 1.0');
  ent('centrifuge', 'kind.virtual', 'ent.cent', 'centrifuge · 1.0');
  ent('robot', 'kind.entity', 'ent.robot', 'robot · 1.0');
  ent('bench-01', 'kind.entity', 'ent.bench', 'bench · 1.0', {
    tvars: { n: '01' },
  });
  ent('bench-02', 'kind.entity', 'ent.bench', 'bench · 1.0', {
    tvars: { n: '02' },
  });
  ent('bench-03', 'kind.entity', 'ent.bench', 'bench · 1.0', {
    tvars: { n: '03' },
  });
  ent('microscope', 'kind.representation', 'ent.microscope', 'model · 1.0');
  ent('labware', 'kind.entity', 'ent.labware', 'labware · 1.0');
  ent('asset-shelf', 'kind.library', 'ent.shelf', 'asset · 1.0');
  ent('server', 'kind.server', 'ent.server', 'node · 24');
  ent('tech', 'kind.member', 'ent.tech', 'user');

  const lightInfo = (id) => {
    const L = sim.lights[id];
    return {
      status: () => (L.run ? t('v.live') : t('v.stopped')),
      rows: () => [
        [t('row.run'), L.run ? `#${(L.startedAt + 1) | 0}` : '—'],
        [
          t('row.pending'),
          L.pending ? `${Math.round(L.pending.val * 100)} %` : t('v.none'),
        ],
        [t('row.observation'), `${Math.round(L.obs * 100)} %`],
        [t('row.reported'), L.run ? ago(Math.max(0, sim.t - 0.4)) : '—'],
        [t('row.binding'), 'light.v1'],
      ],
      acts: [
        {
          id: 'toggle',
          label: () => (L.run ? t('act.stop') : t('act.start')),
          pressed: () => L.run,
          run: () => {
            L.run = !L.run;
            if (L.run) {
              L.startedAt = sim.t;
              L.pending = { at: sim.t + 0.7, val: L.target };
            } else {
              L.pending = { at: sim.t + 0.5, val: 0 };
            }
          },
        },
        {
          id: 'dim',
          label: () => t('act.set40'),
          run: () => {
            L.target = 0.4;
            if (L.run) L.pending = { at: sim.t + 0.7, val: 0.4 };
          },
        },
        {
          id: 'full',
          label: () => t('act.set100'),
          run: () => {
            L.target = 1;
            if (L.run) L.pending = { at: sim.t + 0.7, val: 1 };
          },
        },
      ],
    };
  };
  Object.assign(ENT['light-a'], lightInfo('light-a'));
  Object.assign(ENT['light-b'], lightInfo('light-b'));
  const sensorInfo = (id) => {
    const s = sim.sensors[id];
    return {
      status: () => t('v.sampling'),
      rows: () => [
        [t('row.value'), s.last ? `${s.last.v} ${s.last.unit}` : '—'],
        [t('row.source'), s.src],
        [t('row.quality'), s.last ? s.last.q : '—'],
        [t('row.observed'), s.last ? ago(s.last.at) : '—'],
        [t('row.retention'), t('v.raw24')],
      ],
      acts: [],
    };
  };
  Object.assign(ENT['sensor-a'], sensorInfo('sensor-a'));
  Object.assign(ENT['sensor-b'], sensorInfo('sensor-b'));
  Object.assign(ENT['centrifuge'], {
    status: centState,
    rows: () => [
      [t('row.state'), centState()],
      [t('row.rpm'), `${Math.round(sim.cent.rpm)}`],
      [t('row.setpoint'), t('v.rpm', { n: sim.cent.target })],
      [t('row.chamber'), `${sim.cent.temp.toFixed(1)} °C`],
      [t('row.done'), `${sim.cent.done}`],
    ],
    bar: () =>
      sim.cent.state === 'running'
        ? sim.cent.elapsed / sim.cent.task.dur
        : sim.cent.state === 'preparing'
          ? (sim.cent.rpm / sim.cent.target) * 0.4
          : 0,
    acts: [
      {
        id: 'start',
        label: () => t('act.startTask'),
        pressed: () => !!sim.cent.task && sim.cent.state !== 'decelerating',
        run: () => {
          if (!sim.cent.task) {
            sim.cent.task = { dur: 14 };
            sim.cent.state = 'preparing';
          }
        },
      },
      {
        id: 'cancel',
        label: () => t('act.cancel'),
        run: () => {
          if (sim.cent.task) sim.cent.state = 'cancelled';
        },
      },
    ],
  });
  Object.assign(ENT['robot'], {
    status: () => (sim.robot.carry ? t('v.carrying') : t('v.reaching')),
    rows: () => [
      [t('row.cell'), t('v.cellName')],
      [t('row.cycle'), `${((sim.robot.phase % 1) * 7).toFixed(1)} s`],
      [t('row.payload'), sim.robot.carry ? t('v.tote') : t('v.none')],
      [t('row.binding'), 'robot.v1'],
    ],
    acts: [],
  });
  for (const id of ['bench-01', 'bench-02', 'bench-03'])
    Object.assign(ENT[id], {
      status: () => t('v.placed'),
      rows: () => [
        [t('row.relationship'), t('v.inLab')],
        [t('row.placement'), t('v.registered')],
        [t('row.nodes'), '1'],
      ],
      acts: [],
    });
  Object.assign(ENT['microscope'], {
    status: () => t('v.published'),
    rows: () => [
      [t('row.source'), 'Poly Haven'],
      [t('row.license'), 'CC0 1.0'],
      [t('row.triangles'), '16 598'],
      [t('row.format'), 'glTF 2.0 .glb'],
    ],
    acts: [],
  });
  Object.assign(ENT['labware'], {
    status: () => t('v.placed'),
    rows: () => [
      [t('row.vessels'), '14'],
      [t('row.identity'), t('v.perVessel')],
      [t('row.rack'), 'tube rack · 6'],
    ],
    acts: [],
  });
  Object.assign(ENT['asset-shelf'], {
    status: () => t('v.catalog'),
    rows: () => [
      [t('row.definitions'), '8'],
      [t('row.representations'), '12'],
      [t('row.bytes'), 'content-hash'],
    ],
    acts: [],
  });
  Object.assign(ENT['server'], {
    status: () => t('v.ready'),
    rows: () => [
      [t('row.process'), t('v.single')],
      [t('row.database'), t('v.embedded')],
      [t('row.sseEvents'), `${sim.sse}`],
      [t('row.header'), 'X-Lab-Runtime: ready'],
      [t('row.serves'), t('v.sameOrigin')],
    ],
    acts: [],
  });
  Object.assign(ENT['tech'], {
    status: () => (sim.tech.pause > 0 ? t('v.atBench') : t('v.onShift')),
    rows: () => [
      [t('row.role'), t('kind.member')],
      [t('row.session'), 'cookie + CSRF'],
      [t('row.lastAction'), t('v.layoutEdit')],
    ],
    acts: [],
  });

  /* ---------------- view: camera, pick, card ---------------- */
  const VIEWS = {
    lab: [2.4, 20.6, 1.4, 14.2, 0, 2.8],
    benches: [2.8, 11.8, 4.8, 11.2, 0, 2.2],
    devices: [5.6, 14.0, 7.6, 13.6, 0, 2.2],
    robot: [12.8, 17.4, 8.8, 12.8, 0, 2.6],
    assets: [18.8, 24.4, 1.4, 7.4, 0, 2.6],
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const stage = root.querySelector('.stage');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const tagHover = root.querySelector('#tagHover');
  const tagSel = root.querySelector('#tagSel');
  const card = root.querySelector('#card');
  const clockEl = root.querySelector('#clock');
  const phaseEl = root.querySelector('#phase');
  const readout = root.querySelector('#readout');
  readout.textContent = t('plate.loading');

  readTokens();
  const STATIC = buildStatic();
  const cam = { x: 0, y: 0, zoom: 20 };
  let W = 0,
    H = 0,
    dpr = 1,
    goal = null,
    selected = null,
    hovered = null,
    solids = [],
    hulls = [];

  const proj = (x, y, z) => [
    ((x - y) * C3 - cam.x) * cam.zoom + W / 2,
    ((x + y) * S3 - z - cam.y) * cam.zoom + H / 2,
  ];
  function frame(vb) {
    const [x0, x1, y0, y1, z0 = 0, z1 = 2] = vb;
    let minX = 1e9,
      maxX = -1e9,
      minY = 1e9,
      maxY = -1e9;
    for (const x of [x0, x1])
      for (const y of [y0, y1])
        for (const z of [z0, z1]) {
          const px = (x - y) * C3,
            py = (x + y) * S3 - z;
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
    const zoom = Math.min(W / (maxX - minX), H / (maxY - minY)) * 0.94;
    return { zoom, x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  function goView(k) {
    goal = frame(VIEWS[k]);
  }
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = stage.clientWidth;
    H = stage.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  observe(new ResizeObserver(resize), stage);
  resize();
  Object.assign(cam, frame(VIEWS.lab));

  // ---- pointer: pan, zoom, hover, pick ----
  let drag = null;
  const hullOf = (s) => {
    const pts = [];
    for (const f of s.faces) for (const p of f.p) pts.push(proj(...p));
    for (const l of s.lines) {
      pts.push(proj(...l[0]));
      pts.push(proj(...l[1]));
    }
    return hull(pts);
  };
  const inHull = (h, x, y) => {
    let inside = false;
    for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
      const [xi, yi] = h[i],
        [xj, yj] = h[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  };
  const pickAt = (x, y) => {
    for (let i = hulls.length - 1; i >= 0; i--) {
      const h = hulls[i];
      if (h.ent && inHull(h.pts, x, y)) return h.ent;
    }
    return null;
  };
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      cam.x -= dx / cam.zoom;
      cam.y -= dy / cam.zoom;
      goal = null;
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    hovered = pickAt(e.clientX - r.left, e.clientY - r.top);
    canvas.classList.toggle('over', !!hovered);
    if (hovered && hovered !== selected && ENT[hovered]) {
      const p = topOf(hovered);
      tagHover.hidden = false;
      tagHover.textContent = label(ENT[hovered]);
      tagHover.style.transform = `translate(${p[0]}px, ${p[1] - 14}px) translate(-50%,-100%)`;
    } else tagHover.hidden = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag && drag.moved < 5)
      select(pickAt(e.clientX - r.left, e.clientY - r.top));
    drag = null;
  });
  canvas.addEventListener('pointerleave', () => {
    tagHover.hidden = true;
    hovered = null;
    canvas.classList.remove('over');
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      goal = null;
      const r = canvas.getBoundingClientRect(),
        mx = e.clientX - r.left,
        my = e.clientY - r.top;
      const nz = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0012), 6, 220);
      cam.x += (mx - W / 2) / cam.zoom - (mx - W / 2) / nz;
      cam.y += (my - H / 2) / cam.zoom - (my - H / 2) / nz;
      cam.zoom = nz;
    },
    { passive: false },
  );
  // centroid of what an entity covers on screen — a point that is actually inside it
  const anchorOf = (id) => {
    const hs = hulls.filter((h) => h.ent === id);
    if (!hs.length) return [W / 2, H / 2];
    let x = 0,
      y = 0,
      n = 0;
    for (const h of hs)
      for (const p of h.pts) {
        x += p[0];
        y += p[1];
        n++;
      }
    return [x / n, y / n];
  };
  // the top of an entity's footprint, where its label floats
  const topOf = (id) => {
    const hs = hulls.filter((h) => h.ent === id);
    if (!hs.length) return anchorOf(id);
    let m = 1e9;
    for (const h of hs) for (const q of h.pts) m = Math.min(m, q[1]);
    const c = anchorOf(id);
    return [c[0], m];
  };

  // ---- card ----
  function select(id) {
    selected = id;
    tagHover.hidden = true;
    if (!id) {
      card.hidden = true;
      tagSel.hidden = true;
      return;
    }
    const E = ENT[id];
    card.hidden = false;
    card.querySelector('#cardKind').textContent = t(E.kind);
    card.querySelector('#cardTitle').textContent = label(E);
    card.querySelector('#cardDef').textContent = E.def;
    const foot = card.querySelector('#cardFoot');
    foot.innerHTML = '';
    (E.acts || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.textContent = a.label();
      btn.dataset.act = a.id;
      btn.onclick = () => {
        a.run();
        refreshCard();
      };
      foot.appendChild(btn);
    });
    foot.hidden = !(E.acts || []).length;
    refreshCard();
  }
  function refreshCard() {
    if (!selected) return;
    const E = ENT[selected];
    card.querySelector('#cardKind').textContent = t(E.kind);
    card.querySelector('#cardTitle').textContent = label(E);
    const st = card.querySelector('#cardStatus');
    st.textContent = E.status();
    st.classList.toggle(
      'live',
      /live|running|ready|sampling|carrying|运行中|就绪|采样中|搬运中/.test(
        st.textContent,
      ),
    );
    const dl = card.querySelector('#cardRows');
    dl.innerHTML = '';
    for (const [k, v] of E.rows()) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const bar = card.querySelector('#cardBar');
    if (E.bar) {
      bar.hidden = false;
      bar.querySelector('i').style.width = `${Math.round(E.bar() * 100)}%`;
    } else bar.hidden = true;
    for (const btn of card.querySelectorAll('.foot button')) {
      const a = (E.acts || []).find((x) => x.id === btn.dataset.act);
      if (a) btn.textContent = a.label();
      if (a && a.pressed)
        btn.setAttribute('aria-pressed', String(!!a.pressed()));
    }
    const p = topOf(selected);
    tagSel.hidden = false;
    tagSel.textContent = label(E);
    tagSel.style.transform = `translate(${p[0]}px, ${p[1] - 14}px) translate(-50%,-100%)`;
  }
  card.querySelector('#cardClose').onclick = () => select(null);

  // ---- tools ----
  root.querySelector('#zoomIn').onclick = () => {
    goal = { zoom: clamp(cam.zoom * 1.35, 6, 220), x: cam.x, y: cam.y };
  };
  root.querySelector('#zoomOut').onclick = () => {
    goal = { zoom: clamp(cam.zoom / 1.35, 6, 220), x: cam.x, y: cam.y };
  };
  root.querySelector('#home').onclick = () => {
    goal = frame(VIEWS.lab);
  };
  const pauseBtn = root.querySelector('#pause');
  pauseBtn.onclick = () => {
    sim.paused = !sim.paused;
    pauseBtn.setAttribute('aria-pressed', String(sim.paused));
  };
  root.querySelector('#time').onclick = () => {
    sim.t += 60;
  };
  root.querySelectorAll('.sites button').forEach((btn) => {
    btn.onclick = () => {
      goView(btn.dataset.view);
      root
        .querySelectorAll('.sites button')
        .forEach((o) => o.setAttribute('aria-current', String(o === btn)));
    };
  });
  // the theme toggle lives on the page; re-read tokens when it flips
  listen(window, 'lab:theme', readTokens);

  function hull(pts) {
    if (pts.length < 3) return pts;
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [],
      up = [];
    for (const q of p) {
      while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0)
        lo.pop();
      lo.push(q);
    }
    for (const q of p.reverse()) {
      while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0)
        up.pop();
      up.push(q);
    }
    lo.pop();
    up.pop();
    return lo.concat(up);
  }

  // ---- draw ----
  function drawSolid(s) {
    for (const f of s.faces) {
      ctx.beginPath();
      f.p.forEach((p, i) => {
        const [x, y] = proj(...p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      const col = scaled(CUR.fill[f.f] || CUR.fill.body, f.s ?? 1);
      ctx.fillStyle = f.alpha ? rgba(col, f.alpha) : rgb(col);
      ctx.fill();
      if (f.alpha === undefined) {
        ctx.strokeStyle = rgb(CUR.line[s.lk] || CUR.line.line);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (s.lines.length) {
      ctx.beginPath();
      for (const [a, b] of s.lines) {
        const p = proj(...a),
          q = proj(...b);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.strokeStyle = rgb(CUR.line[s.lk] || CUR.line.line);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (s.pool) {
      const [x, y, r, glow] = s.pool;
      const c = proj(x, y, 0);
      const g = ctx.createRadialGradient(
        c[0],
        c[1],
        0,
        c[0],
        c[1],
        r * cam.zoom,
      );
      g.addColorStop(0, rgba(CUR.fill.lamp, 0.22 * glow + theme.dusk * 0.12));
      g.addColorStop(1, rgba(CUR.fill.lamp, 0));
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.scale(1, 0.5);
      ctx.translate(-c[0], -c[1]);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c[0], c[1], r * cam.zoom, 0, 7);
      ctx.fill();
      ctx.restore();
    }
    if (s.ent && (s.ent === selected || s.ent === hovered)) {
      const h = hulls.find((k) => k.ent === s.ent);
      if (h) {
        ctx.beginPath();
        h.pts.forEach((p, i) =>
          i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]),
        );
        ctx.closePath();
        ctx.strokeStyle = rgb(CUR.line.live);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  let last = performance.now(),
    acc = 0,
    cardTick = 0;
  function loop(now) {
    step(now);
    animationFrame(loop);
  }
  function step(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    if (!sim.paused) simStep(dt);
    // dusk from the hour: dark between 19:00 and 06:00
    const h = sim.hour;
    const n =
      h >= 19
        ? Math.min(1, (h - 19) / 1.6)
        : h < 6
          ? 1
          : h < 7.6
            ? 1 - (h - 6) / 1.6
            : 0;
    shade(n);
    document.documentElement.classList.toggle('after-dark', n > 0.5);
    if (goal) {
      cam.zoom += (goal.zoom - cam.zoom) * 0.14;
      cam.x += (goal.x - cam.x) * 0.14;
      cam.y += (goal.y - cam.y) * 0.14;
      if (
        Math.abs(goal.zoom - cam.zoom) < 0.05 &&
        Math.abs(goal.x - cam.x) < 0.02
      )
        goal = null;
    }
    solids = STATIC.concat(buildDynamic()).sort((a, b) => a.key - b.key);
    hulls = solids
      .map((s) => ({ ent: s.ent, pts: s.ent ? hullOf(s) : null }))
      .filter((x) => x.pts && x.pts.length >= 3);
    ctx.clearRect(0, 0, W, H);
    for (const s of solids) drawSolid(s);
    clockEl.textContent = hhmm(sim.hour);
    phaseEl.textContent =
      n > 0.5 ? t('plate.night') : n > 0.05 ? t('plate.dusk') : '';
    acc += dt;
    cardTick += dt;
    if (acc > 0.25) {
      acc = 0;
      const runs =
        (sim.lights['light-a'].run ? 1 : 0) +
        (sim.lights['light-b'].run ? 1 : 0) +
        (sim.cent.task ? 1 : 0);
      readout.textContent = t('plate.readout', {
        state: sim.paused ? t('plate.paused') : t('plate.live'),
        ents: Object.keys(ENT).length,
        runs,
        sse: sim.sse,
      });
    }
    if (cardTick > 0.3) {
      cardTick = 0;
      refreshCard();
    }
  }
  animationFrame(loop);

  // ---- API for the landing page ----
  return {
    state: () => ({
      hour: sim.hour,
      dusk: theme.dusk,
      lights: sim.lights,
      sensors: sim.sensors,
      cent: sim.cent,
      sse: sim.sse,
      t: sim.t,
    }),
    act: (id, act) => {
      const a = (ENT[id].acts || []).find((x) => x.id === act);
      if (a) a.run();
    },
  };
}

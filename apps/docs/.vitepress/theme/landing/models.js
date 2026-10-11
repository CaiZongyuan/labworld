/* The parts. Every model is written in the kernel's coordinates and then dressed with
   flat linework laid onto its own faces — panel seams, grilles, handles, graduations,
   digits and labels — which is what carries the hairline drawing language. */

import { TOP, LEFT, RIGHT, facesOf } from './geo.js';

/* ---------------- the room ---------------- */
export function room(b, W, H) {
  b.slab(
    [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ],
    0,
    'ground',
    null,
    'detail',
  );
  const grid = [];
  for (let x = 1.5; x < W; x += 1.5) grid.push([x, 0, x, H]);
  for (let y = 1.5; y < H; y += 1.5) grid.push([0, y, W, y]);
  b.lines(TOP(0, 0, 0.002), grid.flat(), 'faint');

  // a safety walkway to the door: a lighter band with diagonal hazard hatching
  const wx0 = W - 5.3,
    wx1 = W - 3.7;
  b.poly(
    [
      [wx0, 0],
      [wx1, 0],
      [wx1, H],
      [wx0, H],
    ],
    'road',
    0.004,
  );
  const hz = [];
  for (let y = 0.5; y < H; y += 0.62)
    hz.push(wx0 + 0.06, y, wx1 - 0.06, y - 0.44);
  b.lines(TOP(0, 0, 0.008), hz, 'faint');
  b.lines(TOP(0, 0, 0.008), [wx0, 0, wx0, H, wx1, 0, wx1, H], 'detail');
  // floor drain with a grating
  b.cylZ(2.6, 16.2, 0.004, 0.3, 0.03, 'dark', null, 14);
  const dg = [];
  for (let i = 0; i < 5; i++)
    dg.push([2.34, 15.96 + i * 0.13, 2.86, 15.96 + i * 0.13]);
  b.lines(TOP(0, 0, 0.04), dg.flat(), 'detail');

  // the two far walls, cut low as in a section drawing, with the door gap between them
  const door = [W - 4.6, W - 2.4];
  const w1 = b.put(0, 0, 0, door[0], 0.3, 1.2, 'n');
  w1.key = -900;
  const w2 = b.put(door[1], 0, 0, W - door[1], 0.3, 1.2, 'n');
  w2.key = -900;
  const f1 = facesOf(0, 0, 0, door[0], 0.3, 1.2);
  b.lines(f1.left, [0, 0.16, door[0], 0.16, 0, 1.04, door[0], 1.04], 'detail'); // skirting + high line
  const g1 = [];
  for (let x = 1.5; x < door[0]; x += 1.5) g1.push([x, 0.16, x, 1.04]);
  b.lines(f1.left, g1.flat(), 'faint');
  const w3 = b.put(0, 0, 0, 0.3, H, 1.2, 'n');
  w3.key = -800;
  const f2 = facesOf(0, 0, 0, 0.3, H, 1.2);
  b.lines(f2.right, [0, 0.16, H, 0.16, 0, 1.04, H, 1.04], 'detail');
  const g2 = [];
  for (let y = 1.5; y < H; y += 1.5) g2.push([y, 0.16, y, 1.04]);
  b.lines(f2.right, g2.flat(), 'faint');

  // glazing along the left wall, with mullions and a head rail
  for (let y = 1.4; y < H - 2.6; y += 3.6) {
    const pane = b.put(0.02, y, 0.52, 0.16, 2.7, 0.58, 'w');
    pane.key = -700 + y;
    b.lines(RIGHT(0.18, y + 2.7, 1.1), [0, 0.29, 2.7, 0.29], 'koline');
    b.lines(
      RIGHT(0.18, y + 2.7, 1.1),
      [0.9, 0, 0.9, 0.58, 1.8, 0, 1.8, 0.58],
      'faint',
    );
  }
  // the doorway: jambs, a head, a vision panel and a sign over the opening
  b.put(door[0] - 0.05, 0, 0, 0.16, 0.36, 2.2, 'k').key = -690;
  b.put(door[1] - 0.11, 0, 0, 0.16, 0.36, 2.2, 'k').key = -690;
  b.put(door[0] - 0.05, 0, 2.2, door[1] - door[0] + 0.16, 0.36, 0.16, 'k').key =
    -690;
  const glass = b.put(door[0] + 0.1, 0.06, 1.3, 1.9, 0.2, 0.7, 'w');
  glass.key = -690;
  b.rect(LEFT(door[0] + 0.1, 0.26, 2.0), 0.1, 0.08, 1.7, 0.5, 'detail');
  b.lines(LEFT(door[0] + 0.1, 0.26, 2.0), [0.1, 0.33, 1.8, 0.33], 'faint');
  b.rect(LEFT(door[0] + 0.5, 0.3, 2.62), 0, 0, 1.0, 0.26, 'koline');

  // services: a pipe rack over the bench line with drops into socket boxes
  const rz = 2.8;
  b.put(3.0, 4.5, rz, 13.0, 0.14, 0.13, 'panel');
  b.put(3.0, 4.86, rz, 13.0, 0.14, 0.13, 'panel');
  b.lines(
    TOP(3.0, 4.52, rz + 0.14),
    [0, 0.07, 13, 0.07, 0, 0.42, 13, 0.42],
    'faint',
  );
  for (let x = 3.5; x < 15.6; x += 1.7) {
    b.put(x, 4.52, rz - 0.03, 0.05, 0.1, 0.46, 'dark');
    b.put(x - 0.16, 4.42, rz - 0.5, 0.36, 0.1, 0.32, 'n');
    const f = facesOf(x - 0.16, 4.42, rz - 0.5, 0.36, 0.1, 0.32);
    b.rect(f.left, 0.05, 0.07, 0.12, 0.12, 'detail');
    b.rect(f.left, 0.2, 0.07, 0.12, 0.12, 'detail');
    b.lines(f.left, [0.05, 0.25, 0.31, 0.25], 'faint');
  }
  // a whiteboard on the left wall: a sketched layout and a legend
  b.put(0.3, 8.6, 1.34, 0.06, 2.7, 1.06, 'k');
  const wf = RIGHT(0.36, 11.3, 2.4);
  b.rect(wf, 0.15, 0.15, 1.0, 0.66, 'detail');
  b.lines(
    wf,
    [
      0.15, 0.4, 1.15, 0.4, 0.65, 0.15, 0.65, 0.81, 1.35, 0.3, 2.4, 0.3, 1.35,
      0.5, 2.15, 0.5, 1.35, 0.7, 2.4, 0.7,
    ],
    'detail',
  );
  b.lines(wf, [0.25, 0.92, 0.9, 0.92], 'faint');
  return b;
}

/* ---------------- a lab bench ---------------- */
export function bench(b, x, y, len = 3.2, id = null) {
  const dep = 0.95,
    top = 0.9;
  b.shadow(x + len / 2, y + dep / 2, len * 0.56, dep * 0.62);
  for (const [lx, ly] of [
    [x + 0.1, y + 0.1],
    [x + len - 0.24, y + 0.1],
    [x + 0.1, y + dep - 0.24],
    [x + len - 0.24, y + dep - 0.24],
  ]) {
    b.put(lx, ly, 0.05, 0.13, 0.13, top - 0.05, 'panel', id);
    b.put(lx - 0.02, ly - 0.02, 0, 0.17, 0.17, 0.05, 'dark', id);
  }
  b.put(x + 0.12, y + 0.14, 0.24, len - 0.38, 0.05, 0.05, 'panel', id);
  b.put(x + 0.12, y + dep - 0.19, 0.24, len - 0.38, 0.05, 0.05, 'panel', id);
  // a drawer bank under the counter
  const bx = x + 0.3,
    by = y + 0.12,
    bw = 1.05,
    bd = dep - 0.24,
    bh = top - 0.16;
  b.put(bx, by, 0.1, bw, bd, bh, 'n', id);
  const bf = facesOf(bx, by, 0.1, bw, bd, bh);
  for (let i = 1; i < 3; i++)
    b.lines(bf.left, [0.04, (i * bh) / 3, bw - 0.04, (i * bh) / 3], 'detail');
  for (let i = 0; i < 3; i++) {
    const cy = ((i + 0.5) * bh) / 3;
    b.lines(bf.left, [bw * 0.3, cy, bw * 0.7, cy], 'koline'); // handle
    b.rect(bf.left, 0.07, cy - 0.06, 0.22, 0.12, 'faint');
  } // label plate
  b.cols(bf.right, 0.08, 0.1, bh - 0.2, 0.16, 4, 'faint');
  // a sink with a drainer and a gooseneck tap
  const sx = x + len - 1.12;
  b.put(sx, y + 0.16, top - 0.03, 0.68, 0.62, 0.07, 'k', id);
  const tf0 = facesOf(sx, y + 0.16, top - 0.03, 0.68, 0.62, 0.07);
  b.rect(tf0.top, 0.05, 0.05, 0.36, 0.52, 'koline');
  b.cols(tf0.top, 0.46, 0.06, 0.5, 0.07, 3, 'faint');
  b.put(sx + 0.3, y + 0.05, top + 0.04, 0.07, 0.07, 0.32, 'k', id);
  b.cyl([sx + 0.335, y + 0.085, top + 0.36], [0, 0.28, 0], 0.03, 'k', id, 8);
  b.put(sx + 0.31, y + 0.33, top + 0.3, 0.05, 0.05, 0.07, 'dark', id);
  // the worktop, with an upstand and a chamfer line
  b.put(x - 0.05, y - 0.05, top, len + 0.1, dep + 0.1, 0.06, 'k', id);
  b.put(x - 0.05, y - 0.09, top, len + 0.1, 0.08, 0.22, 'k', id);
  const tf = facesOf(x - 0.05, y - 0.05, top, len + 0.1, dep + 0.1, 0.06);
  b.lines(tf.left, [0, 0.025, len + 0.1, 0.025], 'koline');
  b.lines(tf.right, [0, 0.025, dep + 0.1, 0.025], 'koline');
  // a reagent shelf on bracket gussets
  b.put(x + 0.18, y + 0.06, top + 0.78, len - 0.6, 0.36, 0.05, 'k', id);
  b.lines(
    facesOf(x + 0.18, y + 0.06, top + 0.78, len - 0.6, 0.36, 0.05).left,
    [0, 0.05, len - 0.6, 0.05],
    'koline',
  );
  for (const ex of [x + 0.34, x + len - 0.72]) {
    b.put(ex, y + 0.08, top + 0.5, 0.05, 0.32, 0.28, 'panel', id);
    b.lines(LEFT(ex, y + 0.4, top + 0.78), [0.02, 0.26, 0.3, 0.02], 'faint');
  }
  // a waste bin under the counter
  b.put(x + len - 0.46, y + dep + 0.12, 0, 0.36, 0.32, 0.44, 'panel', id);
  b.rect(
    facesOf(x + len - 0.46, y + dep + 0.12, 0, 0.36, 0.32, 0.44).left,
    0.05,
    0.08,
    0.26,
    0.06,
    'detail',
  );
  return { top: top + 0.06, id };
}

/* ---------------- glassware and small ware ---------------- */
export function beaker(b, x, y, z, r = 0.11, h = 0.28, id = null) {
  b.cylZ(x, y, z, r, h, 'g', id, 14);
  b.cylZ(x, y, z + h - 0.015, r * 1.06, 0.018, 'k', id, 14); // rim
  b.cylZ(x, y, z + 0.015, r * 0.93, h * 0.45, 'g', id, 14); // charge
  const g = [];
  for (let i = 1; i < 4; i++)
    g.push([x + r * 0.5, z + (i * h) / 4.4, x + r * 0.95, z + (i * h) / 4.4]);
  b.lines(
    RIGHT(x + r * 0.72, y + r * 0.72, z + h),
    g
      .map((q) => [
        q[0] - (x + r * 0.72),
        q[1] - (z + h),
        q[2] - (x + r * 0.72),
        q[3] - (z + h),
      ])
      .flat(),
    'detail',
  );
  return b;
}
export function flask(b, x, y, z, id = null) {
  b.cylZ(x, y, z, 0.17, 0.09, 'g', id, 14);
  b.cone(x, y, z + 0.09, 0.17, 0.05, 0.19, 'g', id, 14);
  b.cylZ(x, y, z + 0.28, 0.045, 0.11, 'g', id, 10);
  b.cylZ(x, y, z + 0.38, 0.058, 0.022, 'k', id, 10);
  b.lines(
    RIGHT(x + 0.1, y + 0.08, z + 0.26),
    [0.0, 0.0, 0.05, 0.0, 0.0, 0.06, 0.04, 0.06],
    'detail',
  );
  return b;
}
export function tubeRack(b, x, y, z, n = 6, id = null) {
  b.put(x, y, z, 0.52, 0.17, 0.05, 'k', id);
  b.put(x, y, z + 0.17, 0.52, 0.17, 0.035, 'k', id);
  for (const ex of [x + 0.02, x + 0.46])
    b.put(ex, y + 0.02, z + 0.05, 0.04, 0.13, 0.12, 'panel', id);
  for (let i = 0; i < n; i++) {
    const tx = x + 0.07 + i * (0.38 / (n - 1));
    b.cylZ(tx, y + 0.085, z + 0.06, 0.027, 0.2, 'g', id, 8);
    b.cylZ(tx, y + 0.085, z + 0.06, 0.022, 0.07, 'v', id, 8);
  }
  return b;
}
export function petri(b, x, y, z, n = 4, id = null) {
  for (let i = 0; i < n; i++)
    b.cylZ(x, y, z + i * 0.03, 0.135, 0.026, 'g', id, 14);
  b.cylZ(x, y, z + n * 0.03, 0.14, 0.009, 'k', id, 14);
  return b;
}
export function reagentBottle(b, x, y, z, h = 0.24, tone = 'k', id = null) {
  b.cylZ(x, y, z, 0.075, h, tone, id, 12);
  b.cylZ(x, y, z + h, 0.034, 0.055, 'dark', id, 8);
  b.rect(
    RIGHT(x + 0.055, y + 0.055, z + h * 0.72),
    0,
    0,
    0.09,
    h * 0.45,
    'detail',
  );
  b.lines(
    RIGHT(x + 0.055, y + 0.055, z + h * 0.72),
    [0.012, h * 0.1, 0.075, h * 0.1, 0.012, h * 0.2, 0.06, h * 0.2],
    'faint',
  );
  return b;
}
export function monitor(b, x, y, z, id = null) {
  b.put(x + 0.17, y + 0.1, z, 0.14, 0.12, 0.02, 'dark', id);
  b.put(x + 0.21, y + 0.13, z + 0.02, 0.06, 0.06, 0.2, 'panel', id);
  b.put(x, y + 0.06, z + 0.22, 0.48, 0.06, 0.31, 'n', id);
  b.fill(LEFT(x, y + 0.12, z + 0.53), 0.03, 0.03, 0.42, 0.25, 'glass');
  b.rect(LEFT(x, y + 0.12, z + 0.53), 0.03, 0.03, 0.42, 0.25, 'koline');
  b.rows(LEFT(x + 0.06, y + 0.12, z + 0.24), 0, 0, 0.34, 0.05, 4, 'faint');
  b.put(x + 0.03, y + 0.14, z - 0.02, 0.44, 0.3, 0.022, 'k', id);
  b.rows(
    LEFT(x + 0.03, y + 0.44, z - 0.015),
    0.04,
    0.004,
    0.36,
    0.06,
    3,
    'detail',
  );
  return b;
}

/* ---------------- the imported asset: an industrial microscope ---------------- */
export function microscope(b, x, y, z, id = null) {
  b.shadow(x + 0.22, y + 0.2, 0.36, 0.26);
  b.put(x, y, z, 0.46, 0.38, 0.05, 'dark', id);
  b.put(x + 0.02, y + 0.02, z + 0.05, 0.42, 0.34, 0.03, 'k', id);
  b.put(x + 0.32, y + 0.07, z + 0.08, 0.13, 0.25, 0.44, 'n', id);
  const pf = facesOf(x + 0.32, y + 0.07, z + 0.08, 0.13, 0.25, 0.44);
  b.lines(pf.left, [0.02, 0.08, 0.11, 0.08, 0.02, 0.36, 0.11, 0.36], 'faint');
  b.put(x + 0.08, y + 0.09, z + 0.17, 0.28, 0.21, 0.022, 'k', id); // stage
  b.rect(TOP(x + 0.08, y + 0.09, z + 0.195), 0.06, 0.05, 0.16, 0.11, 'koline'); // slide
  b.put(x + 0.06, y + 0.11, z + 0.196, 0.05, 0.04, 0.016, 'dark', id);
  b.put(x + 0.3, y + 0.17, z + 0.196, 0.05, 0.04, 0.016, 'dark', id);
  b.prism(
    [
      [x + 0.36, y + 0.17, z + 0.52],
      [x + 0.36, y + 0.17, z + 0.26],
      [x + 0.36, y + 0.22, z + 0.22],
      [x + 0.36, y + 0.22, z + 0.52],
    ],
    [0.07, 0, 0],
    'k',
    id,
  );
  b.cylZ(x + 0.21, y + 0.19, z + 0.25, 0.06, 0.05, 'panel', id, 12); // nosepiece
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1;
    b.cyl(
      [
        x + 0.21 + Math.cos(a) * 0.038,
        y + 0.19 + Math.sin(a) * 0.038,
        z + 0.25,
      ],
      [0, 0, -0.1],
      0.019,
      'k',
      id,
      8,
    );
  }
  b.cylZ(x + 0.21, y + 0.19, z + 0.3, 0.022, 0.17, 'g', id, 10); // body tube
  b.cyl([x + 0.22, y + 0.2, z + 0.47], [0.07, 0, 0.11], 0.03, 'k', id, 10); // eyepiece
  b.cylZ(x + 0.13, y + 0.03, z + 0.11, 0.055, 0.032, 'dark', id, 12); // focus knobs
  b.cylZ(x + 0.13, y + 0.36, z + 0.11, 0.055, 0.032, 'dark', id, 12);
  b.circle(x + 0.13, y + 0.03, z + 0.145, 0.034, 'detail', id, 12);
  b.circle(x + 0.13, y + 0.36, z + 0.145, 0.034, 'detail', id, 12);
  b.put(x + 0.05, y + 0.15, z + 0.02, 0.07, 0.09, 0.06, 'panel', id); // illuminator
  b.rect(
    TOP(x + 0.05, y + 0.15, z + 0.082),
    0.012,
    0.022,
    0.045,
    0.045,
    'koline',
  );
  return b;
}

/* ---------------- the centrifuge ---------------- */
export function centrifuge(b, x, y, id = null) {
  const w = 1.4,
    d = 1.2,
    h = 1.0;
  b.shadow(x + w / 2, y + d / 2, w * 0.62, d * 0.66);
  for (const [fx, fy] of [
    [x + 0.1, y + 0.1],
    [x + w - 0.26, y + 0.1],
    [x + 0.1, y + d - 0.26],
    [x + w - 0.26, y + d - 0.26],
  ])
    b.put(fx, fy, 0, 0.16, 0.16, 0.07, 'dark', id);
  b.put(x, y, 0.07, w, d, h - 0.24, 'n', id);
  const f = facesOf(x, y, 0.07, w, d, h - 0.24);
  b.lines(
    f.left,
    [0.05, (h - 0.24) * 0.6, w - 0.05, (h - 0.24) * 0.6],
    'detail',
  ); // lid seam
  b.rect(f.left, 0.1, 0.1, w - 0.55, (h - 0.24) * 0.42, 'faint'); // access plate
  b.lines(
    f.left,
    [0.14, (h - 0.24) * 0.19, w - 0.6, (h - 0.24) * 0.19],
    'faint',
  );
  b.cols(f.right, 0.12, 0.16, (h - 0.24) * 0.34, 0.11, 7, 'detail'); // vent slots
  b.rect(f.right, 0.08, (h - 0.24) * 0.6, w * 0.6, 0.12, 'faint'); // type plate
  // the lid, with a round window, a handle and a latch
  b.put(x + 0.03, y + 0.03, h - 0.17, w - 0.06, d - 0.06, 0.17, 'k', id);
  const lf = facesOf(x + 0.03, y + 0.03, h - 0.17, w - 0.06, d - 0.06, 0.17);
  b.rect(lf.left, 0, 0.03, w - 0.06, 0.04, 'koline');
  b.rect(lf.right, 0, 0.03, d - 0.06, 0.04, 'koline');
  b.cylZ(x + w / 2, y + d / 2, h, 0.36, 0.022, 'g', id, 18);
  b.circle(x + w / 2, y + d / 2, h + 0.026, 0.36, 'koline', id, 22);
  b.circle(x + w / 2, y + d / 2, h + 0.026, 0.29, 'faint', id, 20);
  b.put(
    x + w / 2 - 0.17,
    y + d - 0.12,
    h - 0.03,
    0.34,
    0.09,
    0.06,
    'panel',
    id,
  );
  b.put(x + 0.1, y + d - 0.14, h - 0.05, 0.16, 0.1, 0.1, 'dark', id); // latch
  // the control panel, sloped across the front
  b.prism(
    [
      [x + 0.05, y + d, h - 0.22],
      [x + w - 0.05, y + d, h - 0.22],
      [x + w - 0.05, y + d, 0.32],
      [x + 0.05, y + d, 0.32],
    ],
    [0, -0.26, 0.18],
    'panel',
    id,
  );
  const cf = LEFT(x + 0.05, y + d - 0.26, h - 0.13);
  b.fill(cf, 0.08, 0.05, 0.66, 0.22, 'glass');
  b.rect(cf, 0.08, 0.05, 0.66, 0.22, 'koline');
  b.rows(cf, 0.13, 0.1, 0.56, 0.055, 3, 'faint');
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 4; c++)
      b.rect(cf, 0.82 + c * 0.11, 0.05 + r * 0.11, 0.08, 0.08, 'detail');
  b.rect(cf, 0.82, 0.29, 0.2, 0.09, 'koline'); // start
  b.rect(cf, 1.05, 0.29, 0.2, 0.09, 'detail'); // stop
  return { cx: x + w / 2, cy: y + d / 2, z: h + 0.02 };
}
// the rotor: a hub, a ring and six buckets that swing out as the speed rises
export function rotor(b, cx, cy, z, angle, rpmFrac, live) {
  b.cylZ(cx, cy, z - 0.03, 0.46, 0.06, 'k', null, 20);
  b.circle(cx, cy, z + 0.045, 0.38, live ? 'live' : 'detail', null, 24);
  b.cylZ(cx, cy, z + 0.03, 0.1, 0.1, 'panel', null, 12);
  b.circle(cx, cy, z + 0.135, 0.07, 'detail', null, 12);
  for (let i = 0; i < 6; i++) {
    const a = angle + (i * Math.PI) / 3,
      r = 0.3 + rpmFrac * 0.06;
    const bx = cx + Math.cos(a) * r,
      by = cy + Math.sin(a) * r,
      tilt = rpmFrac * 0.14;
    b.seg(
      [cx + Math.cos(a) * 0.11, cy + Math.sin(a) * 0.11, z + 0.12],
      [bx, by, z + 0.07],
      'detail',
    );
    b.cylZ(bx, by, z + 0.05, 0.058, 0.06, 'k', null, 8);
    b.cyl(
      [bx, by, z + 0.11],
      [Math.sin(a) * tilt, -Math.cos(a) * tilt, 0.17],
      0.046,
      'g',
      null,
      8,
    );
  }
  return b;
}

/* ---------------- a temperature sensor on a post ---------------- */
export function sensor(b, x, y, id = null) {
  b.shadow(x, y, 0.28, 0.2);
  b.put(x - 0.13, y - 0.13, 0, 0.26, 0.26, 0.035, 'dark', id);
  b.put(x - 0.05, y - 0.05, 0.035, 0.1, 0.1, 1.02, 'panel', id);
  b.lines(
    LEFT(x - 0.05, y + 0.05, 1.055),
    [
      0.015, 0.2, 0.085, 0.2, 0.015, 0.55, 0.085, 0.55, 0.015, 0.85, 0.085,
      0.85,
    ],
    'faint',
  );
  b.put(x - 0.17, y - 0.14, 1.055, 0.34, 0.28, 0.21, 'n', id);
  const f = facesOf(x - 0.17, y - 0.14, 1.055, 0.34, 0.28, 0.21);
  b.fill(LEFT(x - 0.15, y + 0.14, 1.24), 0.03, 0.03, 0.3, 0.13, 'glass');
  b.rect(LEFT(x - 0.15, y + 0.14, 1.24), 0.03, 0.03, 0.3, 0.13, 'koline');
  b.lines(
    LEFT(x - 0.13, y + 0.14, 1.21),
    [0.04, 0.05, 0.09, 0.05, 0.12, 0.05, 0.17, 0.05, 0.2, 0.05, 0.26, 0.05],
    'detail',
  );
  b.cols(f.right, 0.05, 0.05, 0.12, 0.06, 4, 'detail'); // cooling fins
  b.rect(f.left, 0.03, 0.17, 0.28, 0.03, 'faint');
  b.put(x + 0.17, y - 0.03, 1.13, 0.06, 0.06, 0.06, 'k', id); // probe stub
  b.cyl([x + 0.22, y, 1.16], [0.15, 0, 0], 0.019, 'k', id, 8);
  b.cyl([x + 0.37, y, 1.16], [0, 0, -0.1], 0.013, 'dark', id, 6);
  const cl = []; // conduit down the back of the post
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    cl.push([x - 0.16 + Math.sin(t * 2.2) * 0.02, y - 0.12, 1.1 - t * 1.02]);
  }
  for (let i = 0; i < cl.length - 1; i++) b.seg(cl[i], cl[i + 1], 'detail');
  b.put(x - 0.25, y - 0.19, 0, 0.13, 0.16, 0.08, 'panel', id); // its floor duct
  b.rect(TOP(x - 0.25, y - 0.19, 0.0815), 0.025, 0.03, 0.08, 0.1, 'faint');
  return { x, y };
}

/* ---------------- a floor-standing luminaire ---------------- */
export function lightStand(b, x, y, id = null) {
  b.shadow(x, y, 0.36, 0.28);
  b.put(x - 0.28, y - 0.06, 0, 0.56, 0.12, 0.04, 'dark', id);
  b.put(x - 0.06, y - 0.28, 0.04, 0.12, 0.56, 0.04, 'dark', id);
  b.put(x - 0.14, y - 0.14, 0.08, 0.28, 0.28, 0.1, 'panel', id);
  b.lines(
    LEFT(x - 0.14, y + 0.14, 0.18),
    [0.04, 0.02, 0.24, 0.02, 0.04, 0.06, 0.24, 0.06],
    'faint',
  );
  b.cylZ(x, y, 0.18, 0.052, 0.86, 'k', id, 12);
  b.cylZ(x, y, 1.04, 0.068, 0.07, 'dark', id, 12); // telescoping collar
  b.cylZ(x, y, 1.11, 0.042, 0.82, 'k', id, 12);
  b.lines(
    LEFT(x - 0.042, y + 0.042, 1.93),
    [0.015, 0.1, 0.05, 0.1, 0.015, 0.25, 0.05, 0.25, 0.015, 0.4, 0.05, 0.4],
    'detail',
  );
  b.cylZ(x, y, 1.93, 0.078, 0.06, 'dark', id, 12);
  b.cyl([x, y, 1.99], [0, 0.22, 0], 0.075, 'panel', id, 12); // knuckle
  b.cyl([x, y + 0.12, 2.0], [0.52, 0.26, 0.36], 0.036, 'k', id, 10); // arm
  const hx = x + 0.52,
    hy = y + 0.38,
    hz = 2.36;
  b.cone(hx, hy, hz, 0.1, 0.28, 0.21, 'k', id, 14); // reflector
  b.circle(hx, hy, hz + 0.006, 0.26, 'koline', id, 16);
  b.cylZ(hx, hy, hz + 0.03, 0.14, 0.035, 'dark', id, 12);
  b.put(hx - 0.31, hy - 0.03, hz + 0.05, 0.025, 0.18, 0.26, 'panel', id); // barn doors
  b.put(hx + 0.285, hy - 0.03, hz + 0.05, 0.025, 0.18, 0.26, 'panel', id);
  b.cyl([hx, hy - 0.07, hz + 0.19], [0, 0.02, 0.11], 0.022, 'dark', id, 6);
  return { x: hx, y: hy, z: hz };
}
// the cone of light a live luminaire throws across the floor
export function lightCone(b, h, intensity) {
  const n = 14,
    r0 = 0.24,
    r1 = 0.95 + intensity * 1.35;
  const A = [],
    Bp = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    A.push([h.x + Math.cos(a) * r0, h.y + Math.sin(a) * r0 * 0.7, h.z - 0.03]);
    Bp.push([h.x + Math.cos(a) * r1, h.y + Math.sin(a) * r1, 0.014]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.out.push({
      ent: null,
      key: h.x + h.y - 0.4,
      faces: [
        {
          p: [A[i], A[j], Bp[j], Bp[i]],
          f: 'lamp',
          s: 1,
          alpha: intensity * 0.05,
        },
      ],
      lines: [],
      lk: 'faint',
    });
  }
  return b;
}

/* ---------------- the robot cell ---------------- */
export function robotCell(b, x, y, id = null) {
  const s = 2.7;
  b.poly(
    [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
    ],
    'road',
    0.006,
  );
  b.lines(TOP(x, y, 0.009), [0, 0, s, s, s, 0, 0, s], 'faint');
  for (const [cx, cy, dx, dy] of [
    [0, 0, 1, 1],
    [s, 0, -1, 1],
    [0, s, 1, -1],
    [s, s, -1, -1],
  ]) {
    // corner brackets
    b.lines(
      TOP(x + cx, y + cy, 0.012),
      [0, 0, dx * 0.5, 0, 0, 0, 0, dy * 0.5],
      'live',
    );
  }
  b.lines(TOP(x, y, 0.012), [0.7, 0, 2.0, 0, 0, 0.7, 0, 2.0], 'detail');

  const bx = x + 1.25,
    by = y + 1.35;
  b.shadow(bx, by, 0.62, 0.44);
  for (let i = 0; i < 3; i++) {
    const a = i * 2.094;
    b.put(
      bx + Math.cos(a) * 0.36 - 0.11,
      by + Math.sin(a) * 0.36 - 0.11,
      0,
      0.22,
      0.22,
      0.09,
      'dark',
      id,
    );
  }
  b.cylZ(bx, by, 0.09, 0.42, 0.34, 'n', id, 18);
  b.circle(bx, by, 0.44, 0.42, 'detail', id, 20);
  const bf = facesOf(bx - 0.42, by - 0.42, 0.09, 0.84, 0.84, 0.34);
  b.rect(bf.left, 0.12, 0.12, 0.28, 0.14, 'detail'); // access hatch
  b.cols(bf.right, 0.14, 0.1, 0.2, 0.1, 5, 'faint');
  b.lines(bf.left, [0.02, 0.05, 0.82, 0.05], 'faint');
  b.cylZ(bx, by, 0.43, 0.28, 0.11, 'k', id, 16); // turret
  b.lines(
    TOP(bx - 0.28, by - 0.28, 0.54),
    [0.06, 0.28, 0.5, 0.28, 0.28, 0.06, 0.28, 0.5],
    'detail',
  );
  // the infeed station the arm picks from, opposite the cart it feeds
  b.shadow(x + 2.32, y + 0.39, 0.42, 0.32);
  b.put(x + 2.0, y + 0.06, 0.44, 0.65, 0.66, 0.05, 'k', id);
  for (const [lx, ly] of [
    [x + 2.04, y + 0.1],
    [x + 2.56, y + 0.1],
    [x + 2.04, y + 0.63],
    [x + 2.56, y + 0.63],
  ])
    b.put(lx, ly, 0, 0.07, 0.07, 0.44, 'panel', id);
  const ist = facesOf(x + 2.0, y + 0.06, 0.44, 0.65, 0.66, 0.05);
  b.lines(ist.left, [0, 0.02, 0.65, 0.02], 'koline');
  b.rect(TOP(x + 2.19, y + 0.18, 0.4915), 0.02, 0.02, 0.3, 0.34, 'detail');
  b.lines(TOP(x + 2.19, y + 0.18, 0.4915), [0.02, 0.19, 0.3, 0.19], 'faint');
  // the cart it feeds: a deck on four legs riding on castors, with a push handle at one end
  b.put(x + 1.95, y + 2.0, 0.44, 0.95, 0.75, 0.05, 'k', id);
  b.lines(LEFT(x + 1.95, y + 2.75, 0.49), [0, 0.02, 0.95, 0.02], 'koline');
  b.put(x + 2.07, y + 2.12, 0.17, 0.76, 0.56, 0.03, 'panel', id); // the lower shelf
  for (const [lx, ly] of [
    [x + 2.0, y + 2.05],
    [x + 2.83, y + 2.05],
    [x + 2.0, y + 2.68],
    [x + 2.83, y + 2.68],
  ]) {
    b.put(lx, ly, 0.1, 0.07, 0.07, 0.34, 'panel', id); // the leg
    b.cyl([lx + 0.035, ly + 0.01, 0.055], [0, 0.05, 0], 0.055, 'dark', id, 8);
  } // its castor, below
  b.cyl([x + 2.92, y + 2.37, 0.49], [0, 0, 0.36], 0.024, 'k', id, 8);
  b.cyl([x + 2.92, y + 2.37, 0.85], [0, -0.36, 0], 0.024, 'k', id, 8);
  // the stack light, on a mast outside the arm's swept envelope
  const sx = x - 0.5,
    sy = y + 2.6;
  b.shadow(sx, sy, 0.15, 0.09);
  b.cylZ(sx, sy, 0, 0.13, 0.06, 'dark', id, 12);
  b.cylZ(sx, sy, 0.06, 0.045, 0.89, 'k', id, 10);
  b.cylZ(sx, sy, 0.95, 0.09, 0.07, 'panel', id, 12);
  for (let i = 0; i < 3; i++)
    b.cylZ(sx, sy, 1.02 + i * 0.14, 0.085, 0.12, 'g', id, 12);
  b.cylZ(sx, sy, 1.44, 0.055, 0.06, 'dark', id, 10);
  return { bx, by, bz: 0.54 };
}
// A SCARA arm. Each moving part owns one horizontal band, and the links, the housing and
// the quill share a single axis per joint, so nothing can ever sweep through anything:
// shoulder boss · upper link · elbow drum · fore link · wrist bearing · quill shaft ·
// palm · gripper · payload, strictly low to high.
export function robotArm(b, p, a1, a2, a3, carry) {
  const L1 = 1.05,
    L2 = 0.85;
  const j1 = [p.bx + Math.cos(a1) * L1, p.by + Math.sin(a1) * L1];
  const aw = a1 + a2,
    Lw = L2 * 0.9; // the wrist axis, on the fore link's line
  const W = [j1[0] + Math.cos(aw) * Lw, j1[1] + Math.sin(aw) * Lw];
  const z = p.bz;
  const U0 = z + 0.1,
    U1 = U0 + 0.12; // upper link plane
  const F0 = U1 + 0.1,
    F1 = F0 + 0.12; // fore link plane, clear above the upper
  const QZ = F1 + 0.16,
    PZ = F0 - 0.12; // top of the quill shaft, underside of the palm
  // a tapered plate between two joints, `w0`/`w1` half-widths, laid in the plane z0..z0+h
  const link = (ax, ay, bx2, by2, w0, w1, z0, h, tone) => {
    const a = Math.atan2(by2 - ay, bx2 - ax);
    const nx = Math.cos(a + 1.57),
      ny = Math.sin(a + 1.57);
    b.prism(
      [
        [ax + nx * w0, ay + ny * w0, z0],
        [ax - nx * w0, ay - ny * w0, z0],
        [bx2 - nx * w1, by2 - ny * w1, z0],
        [bx2 + nx * w1, by2 + ny * w1, z0],
      ],
      [0, 0, h],
      tone,
      null,
    );
    return a;
  };
  // hairlines on a link's top face, kept inside the span so no housing swallows a stray stroke
  const line = (ax, ay, bx2, by2, t0, t1, off, zz, ang, lk) => {
    const nx = Math.cos(ang + 1.57) * off,
      ny = Math.sin(ang + 1.57) * off;
    const at = (t) => [ax + (bx2 - ax) * t + nx, ay + (by2 - ay) * t + ny, zz];
    b.seg(at(t0), at(t1), lk);
  };
  const rib = (ax, ay, bx2, by2, t, hw, zz, ang) => {
    const nx = Math.cos(ang + 1.57) * hw,
      ny = Math.sin(ang + 1.57) * hw;
    const px = ax + (bx2 - ax) * t,
      py = ay + (by2 - ay) * t;
    b.seg([px - nx, py - ny, zz], [px + nx, py + ny, zz], 'faint');
  };

  b.cylZ(p.bx, p.by, z, 0.21, 0.1, 'n', null, 16); // shoulder boss
  const au = link(p.bx, p.by, j1[0], j1[1], 0.14, 0.11, U0, U1 - U0, 'k');
  for (const s of [1, -1])
    line(
      p.bx,
      p.by,
      j1[0],
      j1[1],
      0.22,
      0.78,
      0.068 * s,
      U1 + 0.003,
      au,
      'faint',
    );
  b.cylZ(j1[0], j1[1], U1, 0.13, F0 - U1, 'panel', null, 14); // elbow drum, spanning the gap
  const af = link(j1[0], j1[1], W[0], W[1], 0.11, 0.07, F0, F1 - F0, 'k');
  for (let i = 1; i < 4; i++) {
    // ribs across the fore link
    const t = i / 4;
    rib(j1[0], j1[1], W[0], W[1], t, (0.11 - 0.04 * t) * 0.6, F1 + 0.003, af);
    for (const s of [1, -1])
      line(
        j1[0],
        j1[1],
        W[0],
        W[1],
        t - 0.06,
        t + 0.06,
        0.068 * s,
        F1 + 0.003,
        af,
        'faint',
      );
  }
  b.cylZ(W[0], W[1], F0 - 0.02, 0.1, F1 - F0 + 0.04, 'panel', null, 12); // wrist bearing
  b.cylZ(W[0], W[1], F1 + 0.02, 0.055, QZ - F1 - 0.02, 'panel', null, 10); // quill shaft, out of its top
  b.cylZ(W[0], W[1], PZ, 0.1, 0.07, 'k', null, 12); // palm, hung under the bearing
  const ga = aw + a3;
  for (const s of [-1, 1]) {
    // fingers, straddling the stem
    const q = (r) => [
      W[0] + Math.cos(ga + 1.57) * r * s,
      W[1] + Math.sin(ga + 1.57) * r * s,
    ];
    b.seg([...q(0.078), PZ - 0.004], [...q(0.112), PZ - 0.155], 'detail');
  }
  {
    const A = [j1[0] - Math.cos(aw) * 0.12, j1[1] - Math.sin(aw) * 0.12]; // the service loom
    let prev = null;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10,
        s1 = Math.min(1, t * 2),
        s2 = Math.max(0, t * 2 - 1);
      const q = [
        A[0] + (j1[0] - A[0]) * s1 + (W[0] - j1[0]) * s2,
        A[1] + (j1[1] - A[1]) * s1 + (W[1] - j1[1]) * s2,
        F0 +
          0.004 +
          (QZ + 0.006 - F0 - 0.004) * t +
          Math.sin(t * Math.PI) * 0.09,
      ];
      if (prev) b.seg(prev, q, 'faint');
      prev = q;
    }
  }
  if (carry) {
    const tz = PZ - 0.24; // 0.50: just clear of the deck
    b.put(W[0] - 0.19, W[1] - 0.15, tz, 0.38, 0.3, 0.05, 'k', null);
    const f = facesOf(W[0] - 0.19, W[1] - 0.15, tz, 0.38, 0.3, 0.05);
    b.rect(f.top, 0.045, 0.045, 0.29, 0.21, 'detail');
    b.cylZ(W[0], W[1], tz + 0.05, 0.03, PZ - tz - 0.05, 'panel', null, 8);
  }
  return b;
}

/* ---------------- asset shelving ---------------- */
export function assetShelf(b, x, y, id = null) {
  const w = 0.82,
    d = 4.5,
    h = 2.3;
  b.shadow(x + w / 2, y + d / 2, w * 0.95, d * 0.55);
  for (const [ux, uy] of [
    [x, y],
    [x + w - 0.11, y],
    [x, y + d - 0.11],
    [x + w - 0.11, y + d - 0.11],
  ]) {
    b.put(ux, uy, 0, 0.11, 0.11, h, 'n', id);
    const s = [];
    for (let i = 1; i < 9; i++) s.push([0.02, i * (h / 9), 0.09, i * (h / 9)]);
    b.lines(LEFT(ux, uy + 0.11, h), s.flat(), 'faint');
  }
  for (let l = 0; l < 4; l++) {
    const z = 0.44 + l * 0.53;
    b.put(x, y, z, w, d, 0.05, 'k', id);
    b.put(x, y, z + 0.05, w, 0.035, 0.07, 'panel', id);
    const f = facesOf(x, y, z, w, d, 0.05);
    b.lines(f.left, [0, 0.05, d, 0.05], 'koline');
    b.rect(LEFT(x + 0.06, y + d, z + 0.12), 0, 0, 0.55, 0.06, 'detail');
  }
  const crate = (cx, cy, cz, cw, cd, ch, tone) => {
    b.put(cx, cy, cz, cw, cd, ch, tone, id);
    const f = facesOf(cx, cy, cz, cw, cd, ch);
    b.rect(f.top, 0.04, 0.04, cw - 0.08, cd - 0.08, 'koline');
    b.lines(
      f.left,
      [0, ch * 0.38, cw, ch * 0.38, 0, ch * 0.72, cw, ch * 0.72],
      'faint',
    );
    b.rect(f.left, cw * 0.28, ch * 0.12, cw * 0.44, ch * 0.2, 'detail');
    b.lines(
      f.left,
      [cw * 0.1, 0, cw * 0.1, ch, cw * 0.9, 0, cw * 0.9, ch],
      'faint',
    );
  };
  crate(x + 0.07, y + 0.16, 0.49, 0.68, 0.95, 0.38, 'k');
  crate(x + 0.07, y + 1.3, 0.49, 0.68, 1.15, 0.32, 'n');
  crate(x + 0.07, y + 0.3, 1.02, 0.68, 0.85, 0.36, 'n');
  crate(x + 0.07, y + 2.7, 1.55, 0.68, 1.25, 0.42, 'k');
  b.cylZ(x + 0.41, y + 3.7, 1.02, 0.17, 0.42, 'g', id, 14);
  b.cylZ(x + 0.41, y + 3.7, 1.44, 0.18, 0.03, 'k', id, 14);
  b.put(x + 0.11, y + 1.55, 1.55, 0.6, 0.95, 0.38, 'panel', id);
  b.lines(LEFT(x + 0.11, y + 2.5, 1.93), [0.06, 0.06, 0.54, 0.06], 'detail');
  return b;
}

/* ---------------- the Lab Word server ---------------- */
export function serverCabinet(b, x, y, id = null) {
  const w = 1.3,
    d = 0.98,
    h = 2.2;
  b.shadow(x + w / 2, y + d / 2, w * 0.85, d * 0.85);
  b.put(x + 0.07, y + 0.07, 0, w - 0.14, d - 0.14, 0.08, 'dark', id);
  b.put(x, y, 0.08, w, d, h - 0.18, 'n', id);
  const f = facesOf(x, y, 0.08, w, d, h - 0.18);
  b.rect(f.left, 0.07, 0.07, w - 0.14, h - 0.34, 'detail');
  const vr = [];
  for (let i = 0; i < 9; i++)
    vr.push([0.16, 0.24 + i * 0.2, w - 0.24, 0.24 + i * 0.2]);
  b.lines(f.left, vr.flat(), 'faint');
  b.rect(f.left, w - 0.28, (h - 0.34) * 0.44, 0.11, 0.34, 'koline');
  b.arc(
    TOP(x + 0.12, y + d - 0.02, 0.08 + h - 0.34),
    0.07,
    0.07,
    0.022,
    0,
    Math.PI * 2,
    'detail',
    8,
  );
  b.lines(
    f.left,
    [0.02, 0.12, 0.07, 0.12, 0.02, h - 0.4, 0.07, h - 0.4],
    'detail',
  );
  // the status bay: a screen with text lines, and a row of indicator lamps
  b.put(x + 0.12, y + d - 0.04, h - 0.68, w - 0.24, 0.06, 0.38, 'panel', id);
  const sf = LEFT(x + 0.12, y + d, h - 0.3);
  b.fill(sf, 0.03, 0.03, 0.54, 0.3, 'glass');
  b.rect(sf, 0.03, 0.03, 0.54, 0.3, 'koline');
  b.rows(sf, 0.08, 0.1, 0.44, 0.06, 4, 'detail');
  b.rect(sf, 0.63, 0.03, 0.46, 0.15, 'detail');
  b.lines(sf, [0.66, 0.23, 1.02, 0.23, 0.66, 0.3, 0.92, 0.3], 'faint');
  // top exhaust and a cable trunk to the patch panel
  b.put(x + 0.05, y + 0.05, h - 0.1, w - 0.1, d - 0.1, 0.1, 'k', id);
  b.cols(
    facesOf(x + 0.05, y + 0.05, h - 0.1, w - 0.1, d - 0.1, 0.1).top,
    0.12,
    0.1,
    d - 0.3,
    0.11,
    7,
    'detail',
  );
  const cl = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    cl.push([x + w * 0.5 - t * 0.2, y - t * (y - 0.36), 0.55 + t * 1.15]);
  }
  for (let i = 0; i < cl.length - 1; i++) b.seg(cl[i], cl[i + 1], 'detail');
  b.put(x + w * 0.5 - 0.32, 0.32, 1.62, 0.64, 0.07, 0.36, 'panel', id);
  b.rows(
    LEFT(x + w * 0.5 - 0.32, 0.39, 1.92),
    0.07,
    0.06,
    0.5,
    0.11,
    3,
    'detail',
  );
  return { x: x + 0.16, y: y + d - 0.02, z: h - 0.62 };
}

/* ---------------- people ---------------- */
export function person(b, x, y, z, gait, opts = {}) {
  const { carry = false, tone = 'k', seated = false } = opts;
  const sw = Math.sin(gait * 6.283),
    sw2 = -sw;
  const hip = seated ? 0.44 : 0.52;
  b.shadow(x, y, 0.26, 0.17);
  if (seated) {
    b.seg(
      [x - 0.06, y, z + hip],
      [x - 0.06, y + 0.26, z + hip - 0.02],
      'detail',
    );
    b.seg(
      [x + 0.06, y, z + hip],
      [x + 0.06, y + 0.26, z + hip - 0.02],
      'detail',
    );
    for (const sgn of [-1, 1])
      b.seg(
        [x + sgn * 0.06, y + 0.26, z + hip - 0.02],
        [x + sgn * 0.06, y + 0.28, z + 0.06],
        'detail',
      );
  } else
    for (const [sgn, t] of [
      [1, sw],
      [-1, sw2],
    ]) {
      const kx = x + sgn * 0.07 + t * 0.1,
        ky = y + t * 0.06;
      b.seg([x + sgn * 0.06, y, z + hip], [kx, ky, z + 0.26], 'detail');
      b.seg(
        [kx, ky, z + 0.26],
        [x + sgn * 0.06 + t * 0.14, y + t * 0.09, z + 0.03],
        'detail',
      );
      b.put(
        x + sgn * 0.06 + t * 0.11,
        y + t * 0.06 - 0.05,
        z,
        0.17,
        0.11,
        0.04,
        'dark',
        null,
      );
    }
  b.put(x - 0.16, y - 0.12, z + hip, 0.32, 0.24, 0.46, tone, null);
  const cf = facesOf(x - 0.16, y - 0.12, z + hip, 0.32, 0.24, 0.46);
  b.lines(cf.left, [0.16, 0.02, 0.16, 0.44], 'detail');
  b.rect(cf.left, 0.03, 0.08, 0.1, 0.11, 'faint');
  b.lines(cf.left, [0.16, 0.16, 0.21, 0.16, 0.16, 0.28, 0.21, 0.28], 'faint');
  b.lines(cf.right, [0.02, 0.03, 0.3, 0.03], 'detail');
  b.seg(
    [x - 0.11, y - 0.12, z + hip + 0.44],
    [x, y - 0.03, z + hip + 0.36],
    'detail',
  );
  b.seg(
    [x + 0.11, y - 0.12, z + hip + 0.44],
    [x, y - 0.03, z + hip + 0.36],
    'detail',
  );
  const arm = seated ? 0.2 : 0.1;
  for (const [sgn, t] of [
    [1, seated ? 0.6 : sw2],
    [-1, seated ? 0.55 : sw],
  ]) {
    const ex = x + sgn * 0.18 + t * arm,
      ey = y + (seated ? -0.2 : t * 0.11);
    b.seg(
      [x + sgn * 0.16, y, z + hip + 0.42],
      [ex, ey, z + hip + 0.2],
      'detail',
    );
    b.seg(
      [ex, ey, z + hip + 0.2],
      [
        x + sgn * 0.17 + t * arm * 1.3,
        ey - (seated ? 0.16 : 0),
        z + hip + (seated ? 0.02 : -0.2),
      ],
      'detail',
    );
  }
  b.cylZ(x, y, z + hip + 0.46, 0.055, 0.07, 'panel', null, 10);
  b.put(x - 0.09, y - 0.08, z + hip + 0.53, 0.18, 0.16, 0.2, 'k', null);
  const hf = facesOf(x - 0.09, y - 0.08, z + hip + 0.53, 0.18, 0.16, 0.2);
  b.lines(hf.left, [0.01, 0.16, 0.17, 0.16], 'detail');
  b.lines(hf.right, [0.04, 0.06, 0.08, 0.06], 'faint');
  if (carry) {
    b.put(x + 0.13, y + 0.1, z + hip - 0.06, 0.32, 0.24, 0.22, 'k', null);
    b.lines(
      LEFT(x + 0.13, y + 0.34, z + hip + 0.16),
      [0.04, 0.04, 0.28, 0.04],
      'detail',
    );
  }
  return b;
}

/* ---------------- props ---------------- */
export function stool(b, x, y, id = null) {
  b.cylZ(x, y, 0.56, 0.18, 0.045, 'panel', id, 14);
  b.circle(x, y, 0.61, 0.14, 'detail', id, 14);
  b.cylZ(x, y, 0.1, 0.038, 0.46, 'k', id, 10);
  for (let i = 0; i < 4; i++) {
    const a = i * 1.571;
    b.seg(
      [x + Math.cos(a) * 0.05, y + Math.sin(a) * 0.05, 0.14],
      [x + Math.cos(a) * 0.24, y + Math.sin(a) * 0.24, 0.02],
      'detail',
    );
  }
  b.circle(x, y, 0.3, 0.17, 'faint', id, 16);
  return b;
}
export function gasCylinder(b, x, y, id = null) {
  b.shadow(x, y, 0.24, 0.18);
  b.cylZ(x, y, 0, 0.15, 1.5, 'k', id, 16);
  b.cone(x, y, 1.5, 0.15, 0.055, 0.22, 'k', id, 14);
  b.cylZ(x, y, 1.7, 0.05, 0.11, 'dark', id, 10);
  b.circle(x, y, 1.76, 0.08, 'detail', id, 12);
  b.lines(
    RIGHT(x + 0.11, y + 0.11, 1.2),
    [0, 0.1, 0.15, 0.1, 0, 0.5, 0.15, 0.5],
    'faint',
  );
  for (const z of [0.5, 1.1]) {
    b.put(x - 0.21, y - 0.07, z, 0.06, 0.32, 0.1, 'panel', id);
    b.seg([x - 0.21, y + 0.09, z + 0.1], [x - 0.21, y + 0.09, z], 'detail');
  }
  b.put(x - 0.18, y - 0.18, 0, 0.36, 0.36, 0.035, 'dark', id);
  return b;
}
export function bioBin(b, x, y, id = null) {
  b.put(x, y, 0, 0.42, 0.42, 0.54, 'panel', id);
  const f = facesOf(x, y, 0, 0.42, 0.42, 0.54);
  b.put(x - 0.025, y - 0.025, 0.54, 0.47, 0.47, 0.055, 'k', id);
  b.lines(f.top, [0.1, 0.21, 0.32, 0.21, 0.21, 0.1, 0.21, 0.32], 'detail');
  b.arc(TOP(x, y, 0.6), 0.21, 0.21, 0.09, 0, Math.PI * 2, 'detail', 10);
  b.rect(f.left, 0.07, 0.09, 0.28, 0.11, 'faint');
  return b;
}
export function wallCabinet(b, x, y, id = null) {
  const w = 3.2,
    d = 0.52,
    h = 0.82,
    z = 1.5;
  b.put(x, y, z, w, d, h, 'k', id);
  const f = facesOf(x, y, z, w, d, h);
  b.lines(
    f.left,
    [0, 0.04, w, 0.04, 0, h - 0.04, w, h - 0.04, w / 2, 0.04, w / 2, h - 0.04],
    'detail',
  );
  b.lines(
    f.left,
    [
      w * 0.42,
      h * 0.5,
      w * 0.47,
      h * 0.5,
      w * 0.53,
      h * 0.5,
      w * 0.58,
      h * 0.5,
    ],
    'koline',
  );
  b.rect(f.left, 0.12, 0.12, 0.7, 0.24, 'faint');
  b.rect(f.right, 0, h - 0.1, d, 0.03, 'koline');
  b.put(x + 0.05, y - 0.04, z - 0.06, w - 0.1, 0.04, 0.06, 'panel', id);
  return b;
}
export function plant(b, x, y, id = null) {
  b.cylZ(x, y, 0, 0.27, 0.36, 'k', id, 14);
  b.cylZ(x, y, 0.36, 0.23, 0.05, 'dark', id, 14);
  for (let i = 0; i < 6; i++) {
    const a = i * 1.047;
    b.cone(
      x + Math.cos(a) * 0.1,
      y + Math.sin(a) * 0.1,
      0.41,
      0.085,
      0.012,
      0.44 + (i % 3) * 0.2,
      'gr',
      id,
      8,
    );
  }
  return b;
}

/* The modelling kernel: boxes, prisms, cylinders, cones and rings, plus face-local
   2D linework. Scene coordinates follow the iso skill: +x runs down-right, +y down-left,
   +z up, so an orthographic camera looking down (1,1,1) shows the top and the two front faces. */

import { TONE } from './theme.js';

export const C3 = Math.cos(Math.PI / 6),
  S3 = 0.5;
// the three faces the camera can ever see, addressed in their own flat 2D units
export const TOP = (x, y, z) => (u, v) => [x + u, y + v, z];
export const LEFT = (x, y, z) => (u, v) => [x + u, y, z - v]; // the +y face; pass its top-left corner
export const RIGHT = (x, y, z) => (u, v) => [x, y - u, z - v]; // the +x face; pass its top-left corner
export const facesOf = (x, y, z, w, d, h) => ({
  top: TOP(x, y, z + h),
  left: LEFT(x, y + d, z + h),
  right: RIGHT(x + w, y + d, z + h),
});

const keyOf = (pts) =>
  pts.reduce((s, p) => s + p[0] + p[1] + p[2], 0) / pts.length;
// a facet is lit by the camera axis: the top reads brightest, the left side least
const facet = (n) => (n[2] > 0.55 ? 1.12 : n[1] > n[0] ? 0.78 : 1.0);
const normalOf = (q, center) => {
  const a = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
  const b = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
  let n = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const l = Math.hypot(...n) || 1;
  n = n.map((v) => v / l);
  const cx = q.reduce((s, p) => s + p[0], 0) / q.length,
    cy = q.reduce((s, p) => s + p[1], 0) / q.length,
    cz = q.reduce((s, p) => s + p[2], 0) / q.length;
  // Orient each face away from its own solid, independently of world position.
  if (
    n[0] * (cx - center[0]) +
      n[1] * (cy - center[1]) +
      n[2] * (cz - center[2]) <
    0
  )
    n = n.map((v) => -v);
  return n;
};

export function box(x, y, z, w, d, h, tone = 'n', ent) {
  const [bk, dk, lk] = TONE[tone],
    x1 = x + w,
    y1 = y + d,
    z1 = z + h;
  const P = (X, Y, Z) => [X, Y, Z];
  return {
    ent,
    key: x + w / 2 + (y + d / 2) + (z + h / 2),
    faces: [
      {
        p: [P(x, y, z1), P(x1, y, z1), P(x1, y1, z1), P(x, y1, z1)],
        f: dk,
        s: 1.12,
      },
      {
        p: [P(x, y1, z), P(x1, y1, z), P(x1, y1, z1), P(x, y1, z1)],
        f: bk,
        s: 0.78,
      },
      {
        p: [P(x1, y, z), P(x1, y1, z), P(x1, y1, z1), P(x1, y, z1)],
        f: bk,
        s: 1.0,
      },
    ],
    lines: [
      [
        [x, y, z1],
        [x1, y, z1],
      ],
      [
        [x1, y, z1],
        [x1, y1, z1],
      ],
      [
        [x1, y1, z1],
        [x, y1, z1],
      ],
      [
        [x, y1, z1],
        [x, y, z1],
      ],
      [
        [x, y1, z],
        [x1, y1, z],
      ],
      [
        [x1, y1, z],
        [x1, y, z],
      ],
      [
        [x, y1, z],
        [x, y1, z1],
      ],
      [
        [x1, y1, z],
        [x1, y1, z1],
      ],
      [
        [x1, y, z],
        [x1, y, z1],
      ],
    ],
    lk,
  };
}
// any flat polygon swept along e: brackets, arms, tapered housings, handles
export function prism(pts, e, tone = 'n', ent) {
  const [bk, dk, lk] = TONE[tone];
  const A = pts,
    B = pts.map((p) => [p[0] + e[0], p[1] + e[1], p[2] + e[2]]);
  const all = [...A, ...B];
  const center = [0, 1, 2].map(
    (axis) => all.reduce((sum, point) => sum + point[axis], 0) / all.length,
  );
  const faces = [],
    lines = [];
  const face = (q) => {
    const n = normalOf(q, center);
    if (n[0] + n[1] + n[2] <= 0.02) return; // turned away from the camera
    faces.push({ p: q, f: n[2] > 0.55 ? dk : bk, s: facet(n) });
  };
  face(A);
  face(B);
  for (let i = 0; i < A.length; i++) {
    const j = (i + 1) % A.length;
    const q = [A[i], A[j], B[j], B[i]];
    face(q);
    lines.push([A[i], A[j]], [B[i], B[j]]);
    const normal = normalOf(q, center);
    if (normal[0] + normal[1] + normal[2] > 0.02) lines.push([A[i], B[i]]);
  }
  return { ent, key: keyOf(all), faces, lines, lk };
}
export function cylZ(cx, cy, z, r, h, tone = 'n', ent, n = 14) {
  const [bk, dk, lk] = TONE[tone];
  const at = (i, t) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z + t];
  };
  const faces = [
    { p: Array.from({ length: n }, (_, i) => at(i, h)), f: dk, s: 1.12 },
  ];
  const lines = Array.from({ length: n }, (_, i) => [
    at(i, h),
    at((i + 1) % n, h),
  ]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = at(i, 0),
      b = at(j, 0);
    const mx = (a[0] + b[0]) / 2 - cx,
      my = (a[1] + b[1]) / 2 - cy; // outward radial normal of this facet
    if (mx + my > 0.001) {
      faces.push({
        p: [a, b, [b[0], b[1], z + h], [a[0], a[1], z + h]],
        f: bk,
        s: mx > my ? 1.0 : 0.78,
      });
      lines.push([a, b], [a, [a[0], a[1], z + h]]);
    }
  }
  return { ent, key: cx + cy + z + h / 2, faces, lines, lk };
}
// a cylinder about any axis, for pipes, rods, rollers and knobs
export function cyl(c, dir, r, tone = 'n', ent, n = 12) {
  const L = Math.hypot(...dir),
    u = dir.map((v) => v / L);
  // two vectors spanning the plane across the axis
  const ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const p = [
    u[1] * ref[2] - u[2] * ref[1],
    u[2] * ref[0] - u[0] * ref[2],
    u[0] * ref[1] - u[1] * ref[0],
  ];
  const pl = Math.hypot(...p);
  const e1 = p.map((v) => v / pl);
  const e2 = [
    u[1] * e1[2] - u[2] * e1[1],
    u[2] * e1[0] - u[0] * e1[2],
    u[0] * e1[1] - u[1] * e1[0],
  ];
  const at = (i, t) => {
    const a = (i / n) * Math.PI * 2,
      ca = Math.cos(a) * r,
      sa = Math.sin(a) * r;
    return [
      c[0] + e1[0] * ca + e2[0] * sa + u[0] * t,
      c[1] + e1[1] * ca + e2[1] * sa + u[1] * t,
      c[2] + e1[2] * ca + e2[2] * sa + u[2] * t,
    ];
  };
  return prism(
    Array.from({ length: n }, (_, i) => at(i, 0)),
    dir,
    tone,
    ent,
  );
}
// truncated cone: reflectors, funnels, tube tips, valve wheels
export function cone(cx, cy, z, r0, r1, h, tone = 'n', ent, n = 14) {
  const [bk, dk, lk] = TONE[tone];
  const at = (i, t, r) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z + t];
  };
  const A = Array.from({ length: n }, (_, i) => at(i, 0, r0)),
    B = Array.from({ length: n }, (_, i) => at(i, h, r1));
  const faces = [{ p: B, f: dk, s: 1.12 }],
    lines = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const q = [A[i], A[j], B[j], B[i]];
    const nrm = normalOf(q, [cx, cy, z + h / 2]);
    if (nrm[0] + nrm[1] + nrm[2] > 0.02) {
      faces.push({ p: q, f: bk, s: nrm[0] > nrm[1] ? 1.0 : 0.78 });
      lines.push([A[i], A[j]], [A[i], B[i]]);
    }
    lines.push([B[i], B[j]]);
  }
  return { ent, key: cx + cy + z + h / 2, faces, lines, lk };
}
export function slab(pts, z, f, ent, lk = 'detail') {
  const lines = [];
  for (let i = 0; i < pts.length; i++)
    lines.push([
      [pts[i][0], pts[i][1], z],
      [pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1], z],
    ]);
  // a ground polygon spans the whole plate: it must sort by its nearest edge, not its middle
  return {
    ent,
    key: pts.reduce((m, p) => Math.min(m, p[0] + p[1]), 1e9) + z,
    faces: [{ p: pts.map((p) => [p[0], p[1], z]), f, s: 1 }],
    lines,
    lk,
  };
}
export function seg(a, b, lk = 'line', ent) {
  return {
    ent,
    key: (a[0] + b[0]) / 2 + (a[1] + b[1]) / 2 + (a[2] + b[2]) / 2,
    faces: [],
    lines: [[a, b]],
    lk,
  };
}
export function poly(pts, f, ent, z = 0) {
  const p = pts.map((q) => [q[0], q[1], z]);
  // ground decals span the plate, so they sort by their nearest edge like the floor does
  return {
    ent,
    key: pts.reduce((m, q) => Math.min(m, q[0] + q[1]), 1e9) + z,
    faces: [{ p, f, s: 1 }],
    lines: [],
    lk: 'detail',
  };
}
// a circle lying flat on the ground or on a face
export function circle(cx, cy, z, r, lk = 'line', ent, n = 24) {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
  });
  return {
    ent,
    key: cx + cy + z,
    faces: [],
    lines: pts.map((p, i) => [p, pts[(i + 1) % n]]),
    lk,
  };
}

/* ---- Builder: accumulates one model's solids and draws flat linework onto its faces ---- */
export class B {
  constructor(ent = null, bias = 0) {
    this.out = [];
    this.ent = ent;
    this.bias = bias;
  }
  add(s) {
    if (s.ent === undefined || s.ent === null) s.ent = this.ent;
    s.key += this.bias;
    this.out.push(s);
    return s;
  }
  box(x, y, z, w, d, h, tone, ent) {
    return this.add(
      box(x, y, z, w, d, h, tone || this.tone || 'n', ent || this.ent),
    );
  }
  put(x, y, z, w, d, h, tone, ent) {
    return this.add(
      box(x, y, z, w, d, h, tone || this.tone || 'n', ent || this.ent),
    );
  }
  cylZ(...a) {
    return this.add(cylZ(...a));
  }
  prism(...a) {
    return this.add(prism(...a));
  }
  cyl(...a) {
    return this.add(cyl(...a));
  }
  cone(...a) {
    return this.add(cone(...a));
  }
  slab(...a) {
    return this.add(slab(...a));
  }
  circle(...a) {
    return this.add(circle(...a));
  }
  seg(a, b, lk = 'line') {
    this.add(seg(a, b, lk, this.ent));
    return this;
  }
  poly(pts, f, z = 0) {
    this.add(poly(pts, f, this.ent, z));
    return this;
  }
  // 2D segments in a face's own units, laid on that face
  lines(M, segs, lk = 'detail') {
    const pairs = [];
    for (let i = 0; i < segs.length; i += 4)
      pairs.push([M(segs[i], segs[i + 1]), M(segs[i + 2], segs[i + 3])]);
    if (!pairs.length) return this;
    const flat = pairs.flat();
    this.add({
      faces: [],
      lines: pairs,
      lk,
      key: flat.reduce((s, p) => s + p[0] + p[1] + p[2], 0) / flat.length,
    });
    return this;
  }
  rect(M, u, v, w, h, lk = 'detail') {
    return this.lines(
      M,
      [
        u,
        v,
        u + w,
        v,
        u + w,
        v,
        u + w,
        v + h,
        u + w,
        v + h,
        u,
        v + h,
        u,
        v + h,
        u,
        v,
      ],
      lk,
    );
  }
  fill(M, u, v, w, h, f) {
    const p = [M(u, v), M(u + w, v), M(u + w, v + h), M(u, v + h)];
    this.add({
      faces: [{ p, f, s: 1 }],
      lines: [],
      lk: 'detail',
      key: p.reduce((s, q) => s + q[0] + q[1] + q[2], 0) / p.length,
    });
    return this;
  }
  rows(M, u, v, w, gap, n, lk = 'detail') {
    const s = [];
    for (let i = 0; i < n; i++) {
      const y = v + i * gap;
      s.push(u, y, u + w, y);
    }
    return this.lines(M, s, lk);
  }
  cols(M, u, v, h, gap, n, lk = 'detail') {
    const s = [];
    for (let i = 0; i < n; i++) {
      const x = u + i * gap;
      s.push(x, v, x, v + h);
    }
    return this.lines(M, s, lk);
  }
  arc(M, cu, cv, r, a0, a1, lk = 'detail', n = 16) {
    const s = [];
    for (let i = 0; i < n; i++) {
      const p = a0 + ((a1 - a0) * i) / n,
        q = a0 + ((a1 - a0) * (i + 1)) / n;
      s.push(
        cu + Math.cos(p) * r,
        cv + Math.sin(p) * r,
        cu + Math.cos(q) * r,
        cv + Math.sin(q) * r,
      );
    }
    return this.lines(M, s, lk);
  }
  // a soft pool of light on the floor under a live luminaire
  pool(cx, cy, r, glow, ent) {
    this.out.push({
      ent,
      key: cx + cy + 0.01,
      pool: [cx, cy, r, glow],
      faces: [],
      lines: [],
      lk: 'faint',
    });
    return this;
  }
  // soft contact shadow, so objects sit on the floor instead of floating over it
  shadow(cx, cy, rx, ry = rx * 0.55, n = 18) {
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    });
    this.out.push({
      ent: null,
      key: cx + cy - 0.6,
      faces: [{ p: pts.map((p) => [p[0], p[1], 0.005]), f: 'shade', s: 0.6 }],
      lines: [],
      lk: 'faint',
    });
    return this;
  }
}

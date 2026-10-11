/* Tokens → materials, and the day/night blend. The map reads the page's CSS custom
   properties, so one source of truth drives both the plate and the page around it. */

export const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const FILL_TOK = {
  ground: '--ground',
  road: '--road',
  body: '--body',
  deck: '--deck',
  ko: '--ko',
  kod: '--ko-deck',
  glass: '--glass',
  window: '--window',
  lamp: '--lamp',
  live: '--live',
  sand: '--sand',
  grass: '--grass',
  panel: '--panel',
  shade: '--road',
  hazard: '--ko',
};
const LINE_TOK = {
  line: '--line',
  detail: '--detail',
  koline: '--ko-line',
  live: '--live',
  faint: '--edge',
};

// Night is one palette for both themes: the day colours slide toward it after dusk.
const NIGHT_HEX = {
  fill: {
    ground: '#0e0f10',
    road: '#0a0b0b',
    body: '#111213',
    deck: '#141516',
    ko: '#8c9093',
    kod: '#999da0',
    glass: '#08090a',
    window: '#e9ebec',
    lamp: '#f4f5f5',
    live: '#f4f5f5',
    sand: '#141516',
    grass: '#0c0d0e',
    panel: '#101112',
    shade: '#0a0b0b',
    hazard: '#8c9093',
  },
  line: {
    line: '#33373a',
    detail: '#202325',
    koline: '#3d4144',
    live: '#f4f5f5',
    faint: '#1d1f21',
  },
};

const hex2rgb = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};
export const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
export const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
// a facet multiplier: the two visible sides of a solid read apart without leaving the flat-fill language
export const scaled = (c, k) =>
  k === 1 ? c : c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));

const NIGHT = { fill: {}, line: {} };
for (const g in NIGHT_HEX)
  for (const k in NIGHT_HEX[g]) NIGHT[g][k] = hex2rgb(NIGHT_HEX[g][k]);

export const DAY = { fill: {}, line: {} };
export const CUR = { fill: {}, line: {} };
export const theme = { dusk: 0 };

export function readTokens() {
  for (const k in FILL_TOK)
    DAY.fill[k] = hex2rgb(css(FILL_TOK[k]) || '#888888');
  for (const k in LINE_TOK)
    DAY.line[k] = hex2rgb(css(LINE_TOK[k]) || '#888888');
  shade(theme.dusk, true);
}
// windows and lamps come on early in the dusk and go off late in the dawn
export function shade(n, force) {
  if (!force && Math.abs(n - theme.dusk) < 0.002) return;
  theme.dusk = n;
  const lit = Math.min(1, n * 1.8);
  for (const k in DAY.fill) {
    const t = k === 'window' || k === 'lamp' || k === 'live' ? lit : n;
    CUR.fill[k] = mix(DAY.fill[k], NIGHT.fill[k] || DAY.fill[k], t);
  }
  for (const k in DAY.line)
    CUR.line[k] = mix(DAY.line[k], NIGHT.line[k] || DAY.line[k], n);
}

// [side fill, top fill, edge line] for each material story
export const TONE = {
  n: ['body', 'deck', 'line'], // ordinary equipment
  k: ['ko', 'kod', 'koline'], // knockout: pale metal / white ware
  g: ['glass', 'glass', 'line'], // glassware and screens
  w: ['window', 'window', 'line'], // lit glazing
  l: ['lamp', 'lamp', 'line'], // a lamp that is on
  v: ['live', 'live', 'live'], // reserved for what is live
  gr: ['grass', 'grass', 'line'],
  dark: ['shade', 'body', 'detail'], // recesses, rubber, shadows
  panel: ['panel', 'body', 'detail'],
};

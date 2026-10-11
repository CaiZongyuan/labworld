import { startLab } from './lab.js';
import { TERMS } from './i18n.js';
import { createLifecycle } from './lifecycle.js';

export function startLanding(root, t, toggleTheme) {
  const lifecycle = createLifecycle();
  const { listen, animationFrame, timeout, interval, observe } = lifecycle;
  try {
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => [...root.querySelectorAll(s)];
    const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------------- boot the plate ---------------- */
    const LAB = startLab($('.plate'), t, lifecycle);

    /* ---------------- light or dark: one toggle, two buttons ---------------- */
    $('#theme').onclick = toggleTheme;
    $('#mode').onclick = toggleTheme;

    /* ---------------- top nav shadow ---------------- */
    const nav = $('#topnav');
    listen(
      window,
      'scroll',
      () => nav.classList.toggle('scrolled', scrollY > 24),
      { passive: true },
    );

    /* ---------------- marquee: the domain vocabulary, in the page's language ---------------- */
    function buildMarquee() {
      const zh = document.documentElement.lang === 'zh-CN';
      const half = TERMS.map((p, i) => {
        const w = zh ? p[1] : p[0];
        return `<span>${i % 3 === 0 ? `<b>${w}</b>` : w}</span>`;
      }).join('');
      $('#marquee').innerHTML = half + half;
    }
    buildMarquee();

    /* ---------------- reveal on scroll ---------------- */
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          if (e.target.matches('.counters')) runCounters(e.target);
          io.unobserve(e.target);
        }),
      { threshold: 0.18, rootMargin: '0px 0px -6% 0px' },
    );
    $$('.rv, .rv-line, .timeline .ev, .counters').forEach((el) =>
      observe(io, el),
    );

    /* ---------------- counters ---------------- */
    function runCounters(box) {
      box.querySelectorAll('b[data-count]').forEach((b) => {
        const target = +b.dataset.count,
          suf = b.dataset.suffix || '';
        if (REDUCED) {
          b.textContent = target.toLocaleString('en-US') + suf;
          return;
        }
        const t0 = performance.now(),
          dur = 1400;
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / dur),
            e = 1 - Math.pow(1 - p, 3);
          b.textContent = Math.round(target * e).toLocaleString('en-US') + suf;
          if (p < 1) animationFrame(tick);
        };
        animationFrame(tick);
      });
    }

    /* ---------------- terminal typing ---------------- */
    const termLines = () => [
      ['p', '$ '],
      ['c', 'git clone https://github.com/CaiZongyuan/labworld.git'],
      ['p', '\n'],
      ['p', '$ '],
      ['c', 'cd labworld'],
      ['p', '\n'],
      ['p', '$ '],
      ['c', 'pnpm install --frozen-lockfile'],
      ['p', '\n'],
      ['p', '$ '],
      ['c', 'pnpm dev'],
      ['p', '\n'],
      ['p', t('start.ready')],
      ['p', t('start.open')],
      ['c', 'http://127.0.0.1:5173/register'],
      ['p', t('start.first')],
    ];
    const termEl = $('#term');
    function typeTerm() {
      const lines = termLines();
      let i = 0,
        j = 0,
        out = '';
      const step = () => {
        if (i >= lines.length) {
          termEl.innerHTML = out + '<span class="caret"></span>';
          return;
        }
        const [kind, text] = lines[i];
        j++;
        const chunk = text.slice(0, j);
        termEl.innerHTML =
          out +
          (kind === 'c'
            ? `<span class="c">${chunk}</span>`
            : chunk.replace(/\n/g, '<br>')) +
          '<span class="caret"></span>';
        if (j >= text.length) {
          out +=
            kind === 'c'
              ? `<span class="c">${text}</span>`
              : text.replace(/\n/g, '<br>');
          i++;
          j = 0;
        }
        timeout(
          step,
          REDUCED
            ? 0
            : text.length > 20 && j === 1
              ? 260
              : 14 + Math.random() * 26,
        );
      };
      step();
    }
    const tio = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            typeTerm();
            tio.disconnect();
          }
        }),
      { threshold: 0.4 },
    );
    observe(tio, termEl);

    /* ---------------- live device cards, wired to the same sim ---------------- */
    const hist = [];
    const devs = {
      light: { el: $('#dev-light'), id: 'light-b' },
      sensor: { el: $('#dev-sensor'), id: 'sensor-a' },
      cent: { el: $('#dev-cent'), id: 'centrifuge' },
    };
    for (const k in devs) {
      devs[k].el.querySelectorAll('.foot button').forEach((b) => {
        b.onclick = () => {
          LAB.act(devs[k].id, b.dataset.act);
          syncDevs();
        };
      });
      devs[k].cv = devs[k].el.querySelector('canvas');
      devs[k].cx = devs[k].cv.getContext('2d');
    }
    function sizeViz() {
      for (const k in devs) {
        const c = devs[k].cv,
          r = c.getBoundingClientRect();
        const d = Math.min(2, devicePixelRatio || 1);
        c.width = r.width * d;
        c.height = r.height * d;
        devs[k].cx.setTransform(d, 0, 0, d, 0, 0);
        devs[k].w = r.width;
        devs[k].h = r.height;
      }
    }
    listen(window, 'resize', sizeViz);
    sizeViz();

    const cssv = (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    function vizLight(d, st) {
      const g = d.cx,
        L = st.lights['light-b'];
      g.clearRect(0, 0, d.w, d.h);
      const on = L.run && L.obs > 0.02;
      const cx = d.w / 2,
        cy = d.h * 0.42;
      if (on) {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, d.h * 0.75);
        gr.addColorStop(0, `rgba(244,245,245,${0.35 * L.obs})`);
        gr.addColorStop(1, 'rgba(244,245,245,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, d.w, d.h);
      }
      g.strokeStyle = cssv('--page-line');
      g.lineWidth = 1;
      g.strokeRect(cx - 22, cy - 6, 44, 12);
      g.beginPath();
      g.moveTo(cx, cy + 6);
      g.lineTo(cx, d.h - 14);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 14, d.h - 14);
      g.lineTo(cx + 14, d.h - 14);
      g.stroke();
      g.fillStyle = on ? cssv('--page-live') : cssv('--page-line');
      g.fillRect(cx - 18, cy - 2, 36 * L.obs, 4);
    }
    function vizSensor(d) {
      const g = d.cx;
      g.clearRect(0, 0, d.w, d.h);
      g.strokeStyle = cssv('--page-edge');
      g.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo(0, (d.h * i) / 4);
        g.lineTo(d.w, (d.h * i) / 4);
        g.stroke();
      }
      if (hist.length < 2) return;
      const min = 17,
        max = 26;
      g.beginPath();
      hist.forEach((v, i) => {
        const x = (i / (hist.length - 1)) * d.w,
          y = d.h - ((v - min) / (max - min)) * d.h;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.strokeStyle = cssv('--page-live');
      g.stroke();
      const last = hist[hist.length - 1];
      const y = d.h - ((last - min) / (max - min)) * d.h;
      g.fillStyle = cssv('--page-live');
      g.beginPath();
      g.arc(d.w - 2, y, 2.5, 0, 7);
      g.fill();
      g.fillStyle = cssv('--page-ink');
      g.font = '10px DM Mono, monospace';
      g.fillText(`${last.toFixed(2)} °C`, 8, 14);
    }
    function vizCent(d, st) {
      const g = d.cx,
        c = st.cent;
      g.clearRect(0, 0, d.w, d.h);
      const cx = d.w / 2,
        cy = d.h / 2,
        R = Math.min(d.w, d.h) * 0.34;
      g.strokeStyle = cssv('--page-line');
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, R, 0, 7);
      g.stroke();
      const frac = Math.min(1, c.rpm / c.target);
      g.strokeStyle = cssv('--page-live');
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      g.stroke();
      const a = (st.t * (0.4 + frac * 6)) % (Math.PI * 2);
      g.strokeStyle = cssv('--page-live');
      g.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const t = a + (i * Math.PI * 2) / 3;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(t) * R * 0.8, cy + Math.sin(t) * R * 0.8);
        g.stroke();
      }
      g.fillStyle = cssv('--page-ink');
      g.font = '10px DM Mono, monospace';
      g.textAlign = 'center';
      g.fillText(`${Math.round(c.rpm)} rpm`, cx, d.h - 6);
      g.textAlign = 'left';
    }
    function syncDevs() {
      const st = LAB.state();
      const L = st.lights['light-b'];
      const q = (sel, v) => {
        const el = devs.light.el.querySelector(sel);
        if (el) el.textContent = v;
      };
      devs.light.el.classList.toggle('on', L.run);
      q('[data-f="run"]', L.run ? t('plate.live') : t('v.stopped'));
      q(
        '[data-f="pending"]',
        L.pending ? `${Math.round(L.pending.val * 100)} %` : t('v.none'),
      );
      q('[data-f="obs"]', `${Math.round(L.obs * 100)} %`);
      devs.light.el.querySelector('[data-act="toggle"]').textContent = L.run
        ? t('act.stop')
        : t('act.start');
      devs.light.el
        .querySelector('[data-act="toggle"]')
        .setAttribute('aria-pressed', String(L.run));

      const s = st.sensors['sensor-a'];
      devs.sensor.el.classList.add('on');
      devs.sensor.el.querySelector('[data-f="val"]').textContent = s.last
        ? `${s.last.v} ${s.last.unit}`
        : '—';
      devs.sensor.el.querySelector('[data-f="ago"]').textContent = s.last
        ? t('v.ago', { n: (st.t - s.last.at).toFixed(1) })
        : '—';
      if (s.last && (!hist.length || hist[hist.length - 1] !== s.last.v)) {
        hist.push(s.last.v);
        if (hist.length > 90) hist.shift();
      }

      const c = st.cent;
      devs.cent.el.classList.toggle('on', !!c.task);
      devs.cent.el.querySelector('[data-f="state"]').textContent = t(
        `cs.${c.state}`,
      );
      devs.cent.el.querySelector('[data-f="rpm"]').textContent = Math.round(
        c.rpm,
      );
      devs.cent.el.querySelector('[data-f="temp"]').textContent =
        `${c.temp.toFixed(1)} °C`;
    }
    interval(() => {
      syncDevs();
      vizLight(devs.light, LAB.state());
      vizSensor(devs.sensor, LAB.state());
      vizCent(devs.cent, LAB.state());
    }, 200);
    syncDevs();

    /* ---------------- hero head fades as the plate takes over ---------------- */
    const heroHead = $('.hero-head');
    listen(
      window,
      'scroll',
      () => {
        const h = heroHead.offsetHeight || 1;
        const p = Math.min(1, scrollY / h);
        heroHead.style.opacity = String(1 - p * 0.9);
        heroHead.style.transform = `translateY(${p * -18}px)`;
      },
      { passive: true },
    );

    return lifecycle.dispose;
  } catch (error) {
    lifecycle.dispose();
    throw error;
  }
}

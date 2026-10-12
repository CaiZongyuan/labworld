<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useData, withBase } from 'vitepress';
import { translate } from './landing/i18n.js';
import { startLanding } from './landing/page.js';
import './landing/styles.css';

const { lang, isDark } = useData();
const isEnglish = computed(() => lang.value === 'en');
const t = (key, vars) => translate(isEnglish.value ? 'en' : 'zh', key, vars);
const root = ref();
let dispose;
function syncTheme() {
  window.dispatchEvent(new Event('lab:theme'));
}
onMounted(() => {
  syncTheme();
  dispose = startLanding(root.value, t, () => {
    isDark.value = !isDark.value;
  });
});
watch(isDark, syncTheme, { flush: 'post' });
onBeforeUnmount(() => {
  dispose?.();
  document.documentElement.classList.remove('after-dark');
});
</script>

<template>
  <div class="labworld-landing" ref="root" :key="lang">
    <header class="topnav" id="topnav">
      <a class="brand" href="#top">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        >
          <path d="M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5"></path>
        </svg>
        LAB WORLD
      </a>
      <nav>
        <a href="#devices" v-html="t('nav.devices')"></a>
        <a href="#provenance" v-html="t('nav.provenance')"></a>
        <a href="#product" v-html="t('nav.product')"></a>
        <a href="#architecture" v-html="t('nav.architecture')"></a>
        <a href="#start" v-html="t('nav.start')"></a>
        <a
          class="keep"
          href="https://github.com/CaiZongyuan/labworld"
          target="_blank"
          rel="noopener"
          >GitHub</a
        >
        <span class="navctl">
          <a
            id="lang"
            class="docs-locale-link"
            :href="withBase(isEnglish ? '/' : '/en/')"
            :aria-label="isEnglish ? '中文' : 'English'"
            >{{ isEnglish ? '中文' : 'EN' }}</a
          >
          <button
            id="mode"
            :aria-label="t('nav.modeAria')"
            :title="t('nav.mode')"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            >
              <circle cx="8" cy="8" r="5"></circle>
              <path
                d="M8 3a5 5 0 0 0 0 10z"
                fill="currentColor"
                stroke="none"
              ></path>
            </svg>
          </button>
        </span>
      </nav>
    </header>
    <main>
      <div class="hero-head">
        <div class="wrap">
          <div class="eyebrow rv" v-html="t('hero.eyebrow')"></div>
          <h1 class="rv" style="--d: 0.05s" v-html="t('hero.h1')"></h1>
          <div class="hero-meta">
            <p
              class="lede muted rv"
              style="--d: 0.12s"
              v-html="t('hero.lede')"
            ></p>
            <div class="cta rv" style="--d: 0.18s">
              <a
                class="btn solid"
                href="https://github.com/CaiZongyuan/labworld"
                target="_blank"
                rel="noopener"
              >
                <svg viewBox="0 0 16 16">
                  <path
                    d="M8 1.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.45-.14.45-.31v-1.2c-1.82.4-2.2-.77-2.2-.77-.3-.76-.73-.96-.73-.96-.6-.4.04-.4.04-.4.66.05 1.01.68 1.01.68.59 1.01 1.54.72 1.91.55.06-.43.23-.72.42-.88-1.46-.17-3-.73-3-3.25 0-.72.26-1.31.68-1.77-.07-.17-.3-.84.06-1.75 0 0 .55-.17 1.8.67a6.2 6.2 0 0 1 3.28 0c1.25-.84 1.8-.67 1.8-.67.36.91.13 1.58.07 1.75.42.46.67 1.05.67 1.77 0 2.53-1.54 3.08-3 3.24.24.2.45.61.45 1.22v1.81c0 .18.12.38.46.31A6.5 6.5 0 0 0 8 1.5Z"
                  ></path>
                </svg>
                <span v-html="t('hero.github')"></span
              ></a>
              <a
                class="btn"
                :href="withBase(isEnglish ? '/en/docs/' : '/docs/')"
              >
                <svg viewBox="0 0 16 16">
                  <path
                    d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v7.5a1.2 1.2 0 0 0-1.2-1.2h-4.3ZM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v7.5a1.2 1.2 0 0 1 1.2-1.2h4.3Z"
                  ></path>
                </svg>
                <span v-html="t('hero.docs')"></span
              ></a>
            </div>
          </div>
        </div>
      </div>
      <div class="plate" id="top">
        <figure>
          <div class="cap">
            <span class="brand">
              <svg
                class="mark"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              >
                <path d="M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5"></path>
              </svg>
              <b>Lab World</b>
              <span class="cap"
                ><span v-html="t('plate.fig')"></span> ·
                <span id="clock">08:00</span><span id="phase"></span
              ></span>
            </span>
            <nav
              class="sites"
              aria-label="Places"
              :aria-label="isEnglish ? 'Places' : '视角'"
            >
              <button
                data-view="lab"
                aria-current="true"
                v-html="t('plate.site.lab')"
              ></button>
              <button
                data-view="benches"
                v-html="t('plate.site.benches')"
              ></button>
              <button
                data-view="devices"
                v-html="t('plate.site.devices')"
              ></button>
              <button data-view="robot" v-html="t('plate.site.robot')"></button>
              <button
                data-view="assets"
                v-html="t('plate.site.assets')"
              ></button>
            </nav>
          </div>
          <div class="stage">
            <canvas
              id="view"
              tabindex="0"
              role="img"
              :aria-label="t('plate.aria')"
            ></canvas>
            <div class="tools">
              <button
                id="zoomIn"
                :aria-label="t('plate.zoomIn')"
                :title="t('plate.zoomIn')"
              >
                <svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"></path></svg>
              </button>
              <button
                id="zoomOut"
                :aria-label="t('plate.zoomOut')"
                :title="t('plate.zoomOut')"
              >
                <svg viewBox="0 0 16 16"><path d="M3 8h10"></path></svg>
              </button>
              <button
                id="home"
                :aria-label="t('plate.home')"
                :title="t('plate.home')"
              >
                <svg viewBox="0 0 16 16">
                  <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5"></path>
                </svg>
              </button>
              <span class="gap"></span>
              <button
                id="pause"
                aria-pressed="false"
                :aria-label="t('plate.pause')"
                :title="t('plate.pause')"
              >
                <svg viewBox="0 0 16 16">
                  <path d="M5.5 3.5v9M10.5 3.5v9"></path>
                </svg>
              </button>
              <button
                id="theme"
                :aria-label="t('plate.theme')"
                :title="t('plate.theme')"
              >
                <svg viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r="5"></circle>
                  <path d="M8 3a5 5 0 0 0 0 10z" fill="currentColor"></path>
                </svg>
              </button>
              <button
                id="time"
                :aria-label="t('plate.skip')"
                :title="t('plate.skip')"
              >
                <svg viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r="5.5"></circle>
                  <path d="M8 4.8V8l2.2 1.6"></path>
                </svg>
              </button>
            </div>
            <div class="tag hover" id="tagHover" hidden=""></div>
            <div class="tag" id="tagSel" hidden=""></div>
            <aside
              class="card"
              id="card"
              role="region"
              hidden=""
              :aria-label="t('plate.cardAria')"
            >
              <div class="head">
                <span id="cardKind"></span
                ><button
                  id="cardClose"
                  :aria-label="t('plate.close')"
                  :title="t('plate.close')"
                >
                  ×
                </button>
              </div>
              <div class="title" id="cardTitle"></div>
              <div class="cap muted" id="cardDef"></div>
              <div class="status" id="cardStatus"></div>
              <div class="bar" id="cardBar" hidden="">
                <span v-html="t('plate.progress')"></span>
                <div><i></i></div>
              </div>
              <dl id="cardRows"></dl>
              <div class="foot" id="cardFoot"></div>
            </aside>
          </div>
          <div class="cap">
            <span v-html="t('plate.hint')"></span>
            <span class="hi" id="readout">loading</span>
          </div>
        </figure>
      </div>
      <p class="demo-note wrap">
        {{
          isEnglish
            ? 'Interactive illustration · simulated data in this browser; no connection to your Lab.'
            : '交互示意 · 数据仅在当前浏览器内模拟，未连接你的 Lab。'
        }}
      </p>
      <div class="marquee" aria-hidden="true">
        <div class="track" id="marquee"></div>
      </div>
      <section id="product">
        <div class="wrap split">
          <div class="stick">
            <div class="eyebrow rv" v-html="t('product.eyebrow')"></div>
            <h2 class="rv" v-html="t('product.h2')"></h2>
            <p
              class="lede muted rv"
              style="--d: 0.08s"
              v-html="t('product.lede')"
            ></p>
            <svg
              class="rv"
              style="--d: 0.16s"
              viewBox="0 0 320 150"
              width="100%"
              height="150"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              aria-hidden="true"
            >
              <rect x="120" y="52" width="80" height="46" rx="6"></rect>
              <text
                x="160"
                y="78"
                text-anchor="middle"
                font-size="9"
                letter-spacing="2"
                fill="currentColor"
                stroke="none"
              >
                {{ t('diagram.server') }}
              </text>
              <rect x="14" y="10" width="66" height="26" rx="5"></rect>
              <text
                x="47"
                y="26"
                text-anchor="middle"
                font-size="8"
                letter-spacing="1.5"
                fill="currentColor"
                stroke="none"
              >
                {{ t('diagram.browser') }}
              </text>
              <rect x="240" y="10" width="66" height="26" rx="5"></rect>
              <text
                x="273"
                y="26"
                text-anchor="middle"
                font-size="8"
                letter-spacing="1.5"
                fill="currentColor"
                stroke="none"
              >
                {{ t('diagram.desktop') }}
              </text>
              <rect x="14" y="114" width="66" height="26" rx="5"></rect>
              <text
                x="47"
                y="130"
                text-anchor="middle"
                font-size="8"
                letter-spacing="1.5"
                fill="currentColor"
                stroke="none"
              >
                {{ t('diagram.agents') }}
              </text>
              <rect x="240" y="114" width="66" height="26" rx="5"></rect>
              <text
                x="273"
                y="130"
                text-anchor="middle"
                font-size="8"
                letter-spacing="1.5"
                fill="currentColor"
                stroke="none"
              >
                {{ t('diagram.electron') }}
              </text>
              <path
                d="M80 26h40v26M240 26h-40v26M80 124h40v-26M240 124h-40v-26"
              ></path>
              <circle r="2.5" fill="currentColor" stroke="none">
                <animateMotion
                  dur="3s"
                  repeatCount="indefinite"
                  path="M80 26h40v26"
                ></animateMotion>
              </circle>
              <circle r="2.5" fill="currentColor" stroke="none">
                <animateMotion
                  dur="3.6s"
                  repeatCount="indefinite"
                  path="M200 98v26h40"
                ></animateMotion>
              </circle>
              <circle r="2.5" fill="currentColor" stroke="none">
                <animateMotion
                  dur="4.2s"
                  repeatCount="indefinite"
                  path="M80 124h40v-26"
                ></animateMotion>
              </circle>
            </svg>
          </div>
          <div class="stack">
            <article class="panel rv">
              <div class="idx" v-html="t('product.p1.idx')"></div>
              <h3 v-html="t('product.p1.h3')"></h3>
              <p class="muted" v-html="t('product.p1.p')"></p>
            </article>
            <article class="panel rv" style="--d: 0.06s">
              <div class="idx" v-html="t('product.p2.idx')"></div>
              <h3 v-html="t('product.p2.h3')"></h3>
              <p class="muted" v-html="t('product.p2.p')"></p>
            </article>
            <article class="panel rv" style="--d: 0.12s">
              <div class="idx" v-html="t('product.p3.idx')"></div>
              <h3 v-html="t('product.p3.h3')"></h3>
              <p class="muted" v-html="t('product.p3.p')"></p>
            </article>
            <article class="panel rv" style="--d: 0.18s">
              <div class="idx" v-html="t('product.p4.idx')"></div>
              <h3 v-html="t('product.p4.h3')"></h3>
              <p class="muted" v-html="t('product.p4.p')"></p>
            </article>
          </div>
        </div>
      </section>
      <section
        id="devices"
        style="
          background: var(--page-panel);
          border-block: 1px solid var(--page-edge);
        "
      >
        <div class="wrap">
          <div class="eyebrow rv" v-html="t('devices.eyebrow')"></div>
          <h2 class="rv" v-html="t('devices.h2')"></h2>
          <p
            class="lede muted rv"
            style="--d: 0.08s"
            v-html="t('devices.lede')"
          ></p>
          <div class="devices" style="margin-top: 34px">
            <div class="dev rv" id="dev-light">
              <span class="pulse"></span>
              <div class="top">
                <span class="name" v-html="t('ent.lightB')"></span
                ><span class="kind">light · 1.0</span>
              </div>
              <div class="viz"><canvas></canvas></div>
              <div class="rows">
                <div>
                  <span v-html="t('row.run')"></span><b data-f="run">—</b>
                </div>
                <div>
                  <span v-html="t('row.pending')"></span
                  ><b data-f="pending">none</b>
                </div>
                <div>
                  <span v-html="t('row.observation')"></span
                  ><b data-f="obs">—</b>
                </div>
              </div>
              <div class="foot">
                <button data-act="toggle" v-html="t('act.start')"></button>
                <button data-act="full" v-html="t('act.set100')"></button>
              </div>
            </div>
            <div class="dev rv" id="dev-sensor" style="--d: 0.08s">
              <span class="pulse"></span>
              <div class="top">
                <span class="name" v-html="t('ent.sensorA')"></span
                ><span class="kind">sensor · 1.0</span>
              </div>
              <div class="viz"><canvas></canvas></div>
              <div class="rows">
                <div>
                  <span v-html="t('row.value')"></span><b data-f="val">—</b>
                </div>
                <div>
                  <span v-html="t('row.source')"></span
                  ><b data-f="src">sim.thermal.a</b>
                </div>
                <div>
                  <span v-html="t('row.observed')"></span><b data-f="ago">—</b>
                </div>
              </div>
              <div class="foot">
                <span
                  class="cap muted"
                  style="align-self: center"
                  v-html="t('devices.note')"
                ></span>
              </div>
            </div>
            <div class="dev rv" id="dev-cent" style="--d: 0.16s">
              <span class="pulse"></span>
              <div class="top">
                <span class="name" v-html="t('ent.cent')"></span
                ><span class="kind">centrifuge · 1.0</span>
              </div>
              <div class="viz"><canvas></canvas></div>
              <div class="rows">
                <div>
                  <span v-html="t('row.state')"></span
                  ><b data-f="state">idle</b>
                </div>
                <div>
                  <span v-html="t('row.rpm')"></span><b data-f="rpm">0</b>
                </div>
                <div>
                  <span v-html="t('row.chamber')"></span><b data-f="temp">—</b>
                </div>
              </div>
              <div class="foot">
                <button data-act="start" v-html="t('act.startTask')"></button>
                <button data-act="cancel" v-html="t('act.cancel')"></button>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="provenance">
        <div class="wrap split">
          <div class="stick">
            <div class="eyebrow rv" v-html="t('prov.eyebrow')"></div>
            <h2 class="rv" v-html="t('prov.h2')"></h2>
            <p
              class="lede muted rv"
              style="--d: 0.08s"
              v-html="t('prov.lede')"
            ></p>
          </div>
          <div class="panel flow rv">
            <div class="row">
              <div class="node" v-html="t('prov.n1')"></div>
              <div class="wire"><i></i></div>
              <div class="node" v-html="t('prov.n2')"></div>
            </div>
            <div class="lbl" v-html="t('prov.l1')"></div>
            <div class="row">
              <div class="node" v-html="t('prov.n3')"></div>
              <div class="wire back"><i></i></div>
              <div class="node" v-html="t('prov.n4')"></div>
            </div>
            <div class="lbl" v-html="t('prov.l2')"></div>
            <div class="row">
              <div class="node" v-html="t('prov.n5')"></div>
              <div class="wire"><i></i></div>
              <div class="node" v-html="t('prov.n6')"></div>
            </div>
            <div class="lbl" v-html="t('prov.l3')"></div>
          </div>
        </div>
      </section>
      <section style="padding-top: 0">
        <div class="wrap">
          <div class="eyebrow rv" v-html="t('real.eyebrow')"></div>
          <h2 class="rv" v-html="t('real.h2')"></h2>
          <figure class="shot rv" style="--d: 0.08s; margin: 26px 0 0">
            <div class="bar">
              <span v-html="t('real.bar1')"></span
              ><span v-html="t('real.bar2')"></span>
            </div>
            <img
              loading="lazy"
              width="1440"
              height="1000"
              :alt="t('real.alt')"
              :src="withBase('/lab-foundation-v1.png')"
            />
            <figcaption v-html="t('real.caption')"></figcaption>
          </figure>
        </div>
      </section>
      <section style="padding-top: 0">
        <div class="wrap">
          <div class="eyebrow rv" v-html="t('assets.eyebrow')"></div>
          <h2 class="rv" v-html="t('assets.h2')"></h2>
          <p
            class="lede muted rv"
            style="--d: 0.08s"
            v-html="t('assets.lede')"
          ></p>
          <div class="assets" style="margin-top: 30px">
            <div class="asset rv">
              <img
                data-name="bench"
                :src="withBase('/landing/icons/bench.png')"
                :alt="t('assets.alt', { n: t('asset.bench') })"
              /><span>bench · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.05s">
              <img
                data-name="centrifuge"
                :src="withBase('/landing/icons/centrifuge.png')"
                :alt="t('assets.alt', { n: t('asset.centrifuge') })"
              /><span>centrifuge · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.1s">
              <img
                data-name="light"
                :src="withBase('/landing/icons/light.png')"
                :alt="t('assets.alt', { n: t('asset.light') })"
              /><span>light · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.15s">
              <img
                data-name="robot"
                :src="withBase('/landing/icons/robot.png')"
                :alt="t('assets.alt', { n: t('asset.robot') })"
              /><span>robot · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.2s">
              <img
                data-name="sensor"
                :src="withBase('/landing/icons/sensor.png')"
                :alt="t('assets.alt', { n: t('asset.sensor') })"
              /><span>sensor · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.25s">
              <img
                data-name="labware"
                :src="withBase('/landing/icons/labware.png')"
                :alt="t('assets.alt', { n: t('asset.labware') })"
              /><span>labware · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.3s">
              <img
                data-name="model"
                :src="withBase('/landing/icons/model.png')"
                :alt="t('assets.alt', { n: t('asset.model') })"
              /><span>model · 1.0</span>
            </div>
            <div class="asset rv" style="--d: 0.35s">
              <img
                data-name="environment"
                :src="withBase('/landing/icons/environment.png')"
                :alt="t('assets.alt', { n: t('asset.environment') })"
              /><span>environment · 1.0</span>
            </div>
          </div>
        </div>
      </section>
      <section
        id="architecture"
        style="
          background: var(--page-panel);
          border-block: 1px solid var(--page-edge);
        "
      >
        <div class="wrap split">
          <div class="stick">
            <div class="eyebrow rv" v-html="t('arch.eyebrow')"></div>
            <h2 class="rv" v-html="t('arch.h2')"></h2>
            <p
              class="lede muted rv"
              style="--d: 0.08s"
              v-html="t('arch.lede')"
            ></p>
          </div>
          <div class="timeline">
            <div class="ev rv">
              <div class="when" v-html="t('arch.t1.when')"></div>
              <h3 v-html="t('arch.t1.h3')"></h3>
              <p class="muted" v-html="t('arch.t1.p')"></p>
            </div>
            <div class="ev rv" style="--d: 0.06s">
              <div class="when" v-html="t('arch.t2.when')"></div>
              <h3 v-html="t('arch.t2.h3')"></h3>
              <p class="muted" v-html="t('arch.t2.p')"></p>
            </div>
            <div class="ev rv" style="--d: 0.12s">
              <div class="when" v-html="t('arch.t3.when')"></div>
              <h3 v-html="t('arch.t3.h3')"></h3>
              <p class="muted" v-html="t('arch.t3.p')"></p>
            </div>
            <div class="ev rv" style="--d: 0.18s">
              <div class="when" v-html="t('arch.t4.when')"></div>
              <h3 v-html="t('arch.t4.h3')"></h3>
              <p class="muted" v-html="t('arch.t4.p')"></p>
            </div>
          </div>
        </div>
      </section>
      <section>
        <div class="wrap">
          <div class="eyebrow rv" v-html="t('budget.eyebrow')"></div>
          <h2 class="rv" v-html="t('budget.h2')"></h2>
          <p
            class="lede muted rv"
            style="--d: 0.08s"
            v-html="t('budget.lede')"
          ></p>
          <div class="counters rv" style="--d: 0.14s; margin-top: 30px">
            <div>
              <b data-count="1000">0</b><span v-html="t('budget.c1')"></span>
            </div>
            <div>
              <b data-count="1000">0</b><span v-html="t('budget.c2')"></span>
            </div>
            <div>
              <b data-count="24" data-suffix=" h">0</b
              ><span v-html="t('budget.c3')"></span>
            </div>
            <div>
              <b data-count="30" data-suffix=" d">0</b
              ><span v-html="t('budget.c4')"></span>
            </div>
            <div>
              <b data-count="400" data-suffix=" KiB">0</b
              ><span v-html="t('budget.c5')"></span>
            </div>
            <div>
              <b data-count="10">0</b><span v-html="t('budget.c6')"></span>
            </div>
          </div>
        </div>
      </section>
      <section id="start" style="padding-top: 0">
        <div class="wrap split">
          <div class="stick">
            <div class="eyebrow rv" v-html="t('start.eyebrow')"></div>
            <h2 class="rv" v-html="t('start.h2')"></h2>
            <p
              class="lede muted rv"
              style="--d: 0.08s"
              v-html="t('start.lede')"
            ></p>
            <p
              class="muted rv"
              style="--d: 0.14s; font-size: 13px"
              v-html="t('start.note')"
            ></p>
          </div>
          <div class="term rv">
            <div class="bar">
              <i></i><i></i><i></i><span>labworld · zsh</span>
            </div>
            <pre id="term"></pre>
          </div>
        </div>
      </section>
    </main>

    <!-- ============ hero ============ -->

    <!-- ============ marquee ============ -->

    <!-- ============ one process ============ -->

    <!-- ============ devices ============ -->

    <!-- ============ provenance ============ -->

    <!-- ============ real product ============ -->

    <!-- ============ asset library ============ -->

    <!-- ============ architecture / migration ============ -->

    <!-- ============ budgets ============ -->

    <!-- ============ quickstart ============ -->

    <footer>
      <div class="wrap">
        <div class="grid">
          <div>
            <h4>Lab World</h4>
            <p
              class="muted"
              style="font-size: 13px; margin: 0"
              v-html="t('foot.tagline')"
            ></p>
          </div>
          <div>
            <h4 v-html="t('foot.project')"></h4>
            <ul>
              <li>
                <a
                  href="https://github.com/CaiZongyuan/labworld"
                  target="_blank"
                  rel="noopener"
                  v-html="t('foot.repository')"
                ></a>
              </li>
              <li>
                <a
                  href="https://github.com/CaiZongyuan/labworld/issues"
                  target="_blank"
                  rel="noopener"
                  v-html="t('foot.issues')"
                ></a>
              </li>
              <li>
                <a
                  href="https://github.com/CaiZongyuan/labworld/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener"
                  v-html="t('foot.mit')"
                ></a>
              </li>
              <li>
                <a :href="withBase((isEnglish ? '/en/' : '/') + 'blog/')">{{
                  isEnglish ? 'Blog' : '博客'
                }}</a>
              </li>
              <li>
                <a
                  :href="withBase((isEnglish ? '/en/' : '/') + 'downloads/')"
                  >{{ isEnglish ? 'Downloads' : '下载' }}</a
                >
              </li>
            </ul>
          </div>
          <div>
            <h4 v-html="t('foot.docs')"></h4>
            <ul>
              <li>
                <a
                  v-html="t('foot.site')"
                  :href="withBase(isEnglish ? '/en/docs/' : '/docs/')"
                ></a>
              </li>
              <li>
                <a
                  v-html="t('foot.guides')"
                  :href="withBase(isEnglish ? '/en/docs/' : '/docs/')"
                ></a>
              </li>
              <li>
                <a
                  href="https://github.com/CaiZongyuan/labworld/blob/main/CONTEXT.md"
                  target="_blank"
                  rel="noopener"
                  v-html="t('foot.vocab')"
                ></a>
              </li>
            </ul>
          </div>
          <div>
            <h4 v-html="t('foot.credits')"></h4>
            <ul>
              <li v-html="t('foot.credit1')"></li>
              <li v-html="t('foot.credit2')"></li>
              <li v-html="t('foot.credit3')"></li>
            </ul>
          </div>
        </div>
        <div class="fine">
          <span v-html="t('foot.fine1')"></span
          ><span v-html="t('foot.fine2')"></span>
        </div>
      </div>
    </footer>
  </div>
</template>

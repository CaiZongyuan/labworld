<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import DocsLocaleSwitch from './DocsLocaleSwitch.vue';
import DocsAppearanceSwitch from './DocsAppearanceSwitch.vue';

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #nav-bar-content-before>
      <DocsLocaleSwitch class="docs-locale-nav" />
    </template>
    <template #nav-bar-content-after>
      <DocsAppearanceSwitch class="docs-appearance-nav" />
    </template>
    <template #nav-screen-content-before>
      <DocsLocaleSwitch class="docs-locale-screen" />
    </template>
    <template #nav-screen-content-after>
      <DocsAppearanceSwitch class="docs-appearance-screen" />
    </template>
  </Layout>
</template>

<style>
/* The pills ride VitePress's own breakpoints: the bar shows them from
   960px (between 960 and 1279 there is no hamburger and no default
   appearance control, so these are the only settings there), and the
   nav screen — rendered only while the hamburger is open — carries them
   below that. The screen instances keep their DOM position before the
   menu: the narrow-screen keyboard walk in tests/docs depends on it. */
.docs-locale-nav,
.docs-appearance-nav {
  /* The switches' own scoped root styles set display on the same
     elements; these breakpoint rules must win over them. */
  display: none !important;
}
@media (min-width: 960px) {
  .docs-locale-nav,
  .docs-appearance-nav {
    display: inline-flex !important;
  }
}
.docs-locale-screen {
  display: inline-flex !important;
  padding: 0 24px 8px;
}
.docs-appearance-screen {
  display: flex !important;
  justify-content: center;
  padding: 8px 24px 0;
}
/* Below 960px these screen copies are the only language and theme
   controls, so they carry the 44px touch-target floor (design.md §5);
   the .VPNavScreen prefix also lifts the specificity over the switches'
   own scoped compact styles. */
.VPNavScreen .docs-locale-screen .docs-locale-link {
  padding: 0 1.1rem;
  min-height: 44px;
}
.VPNavScreen .docs-appearance-screen .docs-appearance-option {
  width: 44px;
  height: 44px;
}
.VPNavScreen .docs-appearance-screen .docs-appearance-option svg {
  width: 18px;
  height: 18px;
}
</style>

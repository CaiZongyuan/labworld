<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

// The language switcher pairs chapters through the `counterpart` value the
// renderer writes into every page's frontmatter. Pages without a
// translation fall back to the other locale's documentation entry, so the
// switch never lands on a page that does not exist. It renders as a
// single pill showing the other locale's name; the accessible name stays
// exactly "English"/"中文" (e2e and the built-site check both key on it,
// and the class-before-href attribute order is part of the built-site
// contract in scripts/check-docs-build.mjs).
const { frontmatter, lang } = useData();
const isEnglish = computed(() => lang.value === 'en');
const counterpart = computed(() =>
  withBase(String(frontmatter.value.counterpart ?? '/')),
);
</script>

<template>
  <div
    class="docs-locale-switch"
    role="group"
    :aria-label="isEnglish ? 'Switch language' : '切换语言'"
  >
    <a
      class="docs-locale-link"
      :href="counterpart"
      :lang="isEnglish ? 'zh-CN' : 'en'"
      :title="isEnglish ? '切换到简体中文' : 'Switch to English'"
      >{{ isEnglish ? '中文' : 'English' }}</a
    >
  </div>
</template>

<style scoped>
.docs-locale-switch {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
.docs-locale-link {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.85rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
  color: var(--vp-c-text-1);
  font-size: 14px;
  line-height: 1.4;
  text-decoration: none;
}
.docs-locale-link:hover {
  border-color: var(--vp-c-text-3);
  background: var(--vp-c-bg-soft);
}
.docs-locale-link:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}
</style>

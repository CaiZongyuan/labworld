<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useData } from 'vitepress';

// VitePress already stores the appearance as 'auto' | 'light' | 'dark'
// under one key, and its pre-paint inline script resolves 'auto' against
// prefers-color-scheme before first paint. This control exposes that
// native three-state contract instead of the default light/dark toggle,
// which cannot express "follow the system".
const STORAGE_KEY = 'vitepress-theme-appearance';

type Appearance = 'auto' | 'light' | 'dark';

// The three states in keyboard order; the labels double as the e2e names.
const OPTIONS: { value: Appearance; labelZh: string; labelEn: string }[] = [
  { value: 'auto', labelZh: '跟随系统', labelEn: 'Follow system' },
  { value: 'light', labelZh: '浅色', labelEn: 'Light' },
  { value: 'dark', labelZh: '深色', labelEn: 'Dark' },
];

const { lang, isDark } = useData();
const zh = computed(() => lang.value !== 'en');
const selected = ref<Appearance>('auto');

// The bar and the nav screen render their own copy of this control; the
// storage event — which every write path below dispatches, directly or
// through VueUse — keeps their active segments (and other tabs) in sync.
const syncFromStorage = () => {
  const stored = localStorage.getItem(STORAGE_KEY);
  selected.value = stored === 'light' || stored === 'dark' ? stored : 'auto';
};

onMounted(() => {
  syncFromStorage();
  window.addEventListener('storage', syncFromStorage);
});
onBeforeUnmount(() => {
  window.removeEventListener('storage', syncFromStorage);
});

function choose(next: Appearance) {
  selected.value = next;
  if (next === 'auto') {
    // Keep the live store at 'auto' the same way @vueuse/core keeps its
    // own copies in sync: write the key, then dispatch the storage event
    // its listener reads. The resolved class then follows the OS without
    // a reload, and the stored 'auto' survives one.
    localStorage.setItem(STORAGE_KEY, 'auto');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: 'auto',
        storageArea: localStorage,
      }),
    );
  } else {
    // isDark is the writable store: assigning it persists the value and
    // applies the html class.
    isDark.value = next === 'dark';
  }
}
</script>

<template>
  <div
    class="docs-appearance-switch"
    role="group"
    :aria-label="zh ? '外观模式' : 'Appearance mode'"
  >
    <button
      v-for="option in OPTIONS"
      :key="option.value"
      type="button"
      class="docs-appearance-option"
      :class="{ 'is-active': selected === option.value }"
      :aria-pressed="selected === option.value"
      :aria-label="zh ? option.labelZh : option.labelEn"
      :title="zh ? option.labelZh : option.labelEn"
      @click="choose(option.value)"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <template v-if="option.value === 'auto'">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </template>
        <template v-else-if="option.value === 'light'">
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          />
        </template>
        <template v-else>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </template>
      </svg>
    </button>
  </div>
</template>

<style scoped>
.docs-appearance-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
}
.docs-appearance-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.docs-appearance-option:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}
.docs-appearance-option.is-active {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.docs-appearance-option:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}
.docs-appearance-option svg {
  width: 15px;
  height: 15px;
}
</style>

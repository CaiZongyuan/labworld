import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { server } from './server';

// jsdom has no layout or scrolling; Router navigation is still real.
window.scrollTo = () => {};

// App-level tests pin the interface language to zh: device detection and
// switching are covered by the preferences suite, and every assertion here
// reads the zh catalog. Clearing in afterEach keeps suites independent.
// (Key mirrors LOCALE_STORAGE_KEY in packages/views preferences.)
beforeEach(() => {
  window.localStorage.setItem('labos-threejs.locale', 'zh');
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  server.resetHandlers();
});
afterAll(() => server.close());

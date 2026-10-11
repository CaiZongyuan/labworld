import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PerformancePanel } from './view-controls';
import type { RenderMetrics } from './viewport-state';
import { PreferencesProvider } from '../shell/preferences';
import { AppMessagesProvider } from '../shell/messages';
import { labApp } from './app';

test('performance counts and completed-render provenance stay on the same sampled record through React display commits', () => {
  window.localStorage.setItem('labos-threejs.locale', 'en');
  const sample: RenderMetrics = {
    sampledAt: 22865.6,
    completedRenderFrame: 163,
    fps: 30,
    frameMs: 1000 / 30,
    calls: 3,
    triangles: 86,
    geometries: 15,
    textures: 4,
    heapMiB: null,
  };
  const panel = (metrics: RenderMetrics) => (
    <PreferencesProvider>
      <AppMessagesProvider app={labApp}>
        <PerformancePanel metrics={metrics} />
      </AppMessagesProvider>
    </PreferencesProvider>
  );
  const view = render(panel(sample));
  const record = screen.getByRole('complementary', { name: 'Performance' });
  expect(record).toHaveAttribute('data-sampled-at', '22865.6');
  expect(record).toHaveAttribute('data-completed-render-frame', '163');
  expect(record).toHaveAttribute('data-geometries', '15');
  expect(record).toHaveAttribute('data-textures', '4');
  expect(
    within(record).getByText('Geometries').nextElementSibling,
  ).toHaveTextContent('15');
  view.rerender(panel(sample));
  expect(record).toHaveAttribute('data-sampled-at', '22865.6');
  const next = {
    ...sample,
    sampledAt: 26901.6,
    completedRenderFrame: 197,
    textures: 5,
  };
  view.rerender(panel(next));
  expect(record).toHaveAttribute('data-sampled-at', '26901.6');
  expect(record).toHaveAttribute('data-completed-render-frame', '197');
  expect(record).toHaveAttribute('data-geometries', '15');
  expect(record).toHaveAttribute('data-textures', '5');
  expect(
    within(record).getByText('Textures').nextElementSibling,
  ).toHaveTextContent('5');
});

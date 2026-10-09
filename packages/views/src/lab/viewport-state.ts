import type { ModelInfo } from './catalog';
import type { ModelErrorKey } from './glb';

export type ViewSettings = {
  dark: boolean;
  grid: boolean;
  rotate: boolean;
  intensity: number;
  fit: number;
  reset: number;
};
export type ViewStatus = {
  renderedId: string | null;
  info: ModelInfo | null;
  loading: boolean;
  error: ModelErrorKey | null;
};
export type RenderMetrics = {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  heapMiB: number | null;
};

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
  /** Browser monotonic time when these renderer counters were sampled. */
  sampledAt: number;
  /** gl.info frame of the preceding completed render, read at default useFrame priority. */
  completedRenderFrame: number;
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  heapMiB: number | null;
};

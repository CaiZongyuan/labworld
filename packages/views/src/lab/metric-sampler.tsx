import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { RenderMetrics } from './viewport-state';

export function MetricSampler({
  onMetrics,
}: {
  onMetrics: (metrics: RenderMetrics) => void;
}) {
  const sample = useRef({ elapsed: 0, frames: 0 });
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const canvas = gl.domElement as HTMLCanvasElement & {
      getRenderMetricProgress?: () => unknown;
    };
    const inspect = () => ({
      elapsed: sample.current.elapsed,
      frames: sample.current.frames,
      frame: gl.info.render.frame,
      triangles: gl.info.render.triangles,
    });
    canvas.getRenderMetricProgress = inspect;
    return () => {
      if (canvas.getRenderMetricProgress === inspect)
        delete canvas.getRenderMetricProgress;
    };
  }, [gl]);
  useFrame(({ gl }, delta) => {
    sample.current.elapsed += delta;
    sample.current.frames++;
    if (sample.current.elapsed < 0.6) return;
    const fps = sample.current.frames / sample.current.elapsed;
    const memory = (
      performance as Performance & { memory?: { usedJSHeapSize?: number } }
    ).memory;
    const heap = memory?.usedJSHeapSize;
    onMetrics({
      sampledAt: performance.now(),
      completedRenderFrame: gl.info.render.frame,
      fps,
      frameMs: 1000 / fps,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      heapMiB:
        typeof heap === 'number' && Number.isFinite(heap)
          ? heap / 1024 / 1024
          : null,
    });
    sample.current = { elapsed: 0, frames: 0 };
  });
  return null;
}

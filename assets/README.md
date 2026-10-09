# Lab Rendering Assets

Source and runtime files are separate. Original glTF, geometry and 1k JPEG textures are in `source/industrial-microscope/`. The unchanged model is packed into `apps/web/public/lab-assets/models/industrial-microscope.glb`.

| Asset                                  | Author       | License | Source                                        |
| -------------------------------------- | ------------ | ------- | --------------------------------------------- |
| Industrial Microscope                  | Lukas Walzer | CC0-1.0 | https://polyhaven.com/a/industrial_microscope |
| Studio Small 03 (1k HDR and thumbnail) | Greg Zaal    | CC0-1.0 | https://polyhaven.com/a/studio_small_03       |

The microscope GLB is 2,454,784 bytes, with 16,598 triangles, two meshes, one material and three textures. The HDR is 1,686,299 bytes. [Poly Haven's license](https://polyhaven.com/license) permits reuse and redistribution.

Draco and Basis decoders come from Three.js 0.186.1 and retain upstream README records. Meshopt uses the installed Three.js module. All rendering resources are hosted locally.

Lab owns these assets, `packages/views/src/lab/`, its assembly in `apps/web/src/app-examples.tsx`, tests in `apps/web/src/lab.test.tsx`, and the paired `docs/guides/lab-viewer` guide. This declares ownership, not an example-removal command.

# Lab Viewer Experience Preview v1

Status: the user accepted v1 on 2026-10-01 and explicitly requested direct implementation without another preview. Their final correction replaces Knowledge in the sidebar with an Asset Library. The preview remains design evidence; product integration is underway.

## Agreed Scope

Lab is the primary business entry and the default page after login. Knowledge is a feature inherited from the template. Current work focuses on the Three.js presentation layer: a preset example plus browser file-picker/drag-drop GLB import, automatic framing, camera orbit/zoom/pan, click selection and renderer metrics. The first version inspects one model; five asset types and a static scene configuration follow later. Real device data and scene placement editing are outside this iteration.

The Asset Library manages the bundled preset and imported GLB files within the signed-in user's current browser session. Users can search the catalog, open a model in Lab, and remove local entries. It is a Lab capability with its own models and routes. Existing knowledge document routes and backend data retain their original meaning; the main business navigation becomes Lab plus Asset Library.

See the [presentation plan](../plans/lab-viewer-m0.md), [glossary](../../CONTEXT.md) and [product boundary decision](../adr/0005-lab-digital-twin-on-saas-foundation.md).

## Preview

- URL: <http://127.0.0.1:5190/prototype/lab-viewer>.
- Version directory: `.scratch/lab-viewer/v1/`; run from the repository root with `pnpm --dir .scratch/lab-viewer/v1 dev`.
- The actual application shell, shared UI components and production tokens surround the new viewport. The separate bottom bar identifies the preview and controls simulated loading, import-failure and empty states.
- The 3D model, HDR lighting, local imports, selection, camera controls and renderer metrics run in the real browser. The signed-in member and template navigation destinations are simulated; the preview uses no application backend.
- The drawer, resizable sidebar, language and appearance controls use the existing shell. Desktop has a right inspector; narrow screens keep the canvas above a scrollable inspector and use compact performance information.

Browser imports are session-only. The minimum input is glTF 2.0 GLB with its resources embedded; external dependencies produce a clear error while retaining the previous usable model. GPU time is not sampled in this preview and displays unavailable. Renderer object counts and JS heap are explicitly different metrics.

## Asset Evidence

The preset is [Poly Haven Industrial Microscope](https://polyhaven.com/a/industrial_microscope), by Lukas Walzer, [CC0](https://polyhaven.com/license). The anonymous 1k glTF source was downloaded and packed with glTF Transform NodeIO 4.5.1 into an embedded GLB without simplifying geometry or recompressing textures. Runtime file: 2,454,784 bytes, 16,598 triangles, two meshes, one material and three textures.

The environment is [Studio Small 03](https://polyhaven.com/a/studio_small_03), by Greg Zaal, CC0, hosted locally as a 1k HDR (1,686,299 bytes). Model sources, provenance and local Draco/Basis decoder files are retained with the preview. The previous Sketchfab candidate requiring account authentication is no longer the preset acquisition dependency.

## Validation Boundary

The preview's browser verification checks actual GLB/HDR rendering and canvas pixels, file-picker/drag-drop loading, selection, camera movement, invalid/missing-resource recovery, resource counts during repeated imports, responsive viewports and the existing theme/language controls. Screenshots and the actual run report live in the version's `evidence/` directory.

The browser environment uses headless Chromium with SwiftShader software rendering. FPS observations describe that environment and are not a GPU performance acceptance result. The screenshot preview retains the WebGL drawing buffer for pixel inspection. Its isolated build is not evidence of production lazy loading or compliance with the application's existing bundle budgets.

Repeated-import checks exposed contact-shadow resources being recreated with each model. The preview now keeps that shadow rig mounted with stable offscreen resources and scales its parent to the model. The resource regression check is retained alongside the preview.

## Captured Evidence

The complete preview, runtime/source assets, dependency lockfile, verification scripts, screenshots and SHA-256 manifest are captured locally on `preview/lab-viewer-v1`, commit `9439a1de78c5433795d22a03e3e6086540832794`. The capture preserves the original design evidence; v1 was subsequently accepted with the Asset Library correction recorded above. Product integration validation remains separate.

The final browser run passed all twelve recorded checks with no page errors: GLB/HDR and canvas pixels, selection, camera movement, auto-rotation/reset, file-picker import, invalid/external-resource recovery, drag/drop, repeated-import resource counts, three responsive sizes, and theme/language controls. Viewports include 1440 x 900, 1920 x 1080, 390 x 844 and 320 x 740. The isolated Vite build also passed; its 440.35 KiB gzip entry remains a preview measurement, not a production bundle-budget result.

## Feedback And Implementation

Record the accepted version and concrete visual/interaction corrections here. Preserve v1 when preparing v2. Product implementation follows the existing experience-design and engineering flow, using the accepted experience as evidence and the agreed public test interfaces; rewrite the prototype into owned Lab code and verify the actual application against it.

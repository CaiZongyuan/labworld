# Run The Lab Viewer Preview

Goal: inspect equipment, import a GLB and check camera controls, selection and failure recovery. This guide covers the accepted isolated v1 preview; record production Lab integration acceptance separately.

## Prerequisites And Version

Use Node, pnpm, desktop Chrome and a local `.scratch/lab-viewer/v1/`. The local `preview/lab-viewer-v1` branch preserves the complete version at `9439a1de78c5433795d22a03e3e6086540832794`. It is outside the main branch's source tree. A main-only checkout cannot run these commands. The preview branch is currently local; check online availability after publication.

With the version directory present, run from the repository root:

```bash
pnpm --dir .scratch/lab-viewer/v1 install --frozen-lockfile
pnpm --dir .scratch/lab-viewer/v1 dev
```

Open <http://127.0.0.1:5190/prototype/lab-viewer>. If the port is occupied, use Vite's reported address. No API or database is required and no production application data is written.

If the local branch exists but the directory is absent, create a separate worktree:

```bash
git worktree add ../lab-word-preview preview/lab-viewer-v1
pnpm --dir ../lab-word-preview/.scratch/lab-viewer/v1 install --frozen-lockfile
pnpm --dir ../lab-word-preview/.scratch/lab-viewer/v1 dev
```

## Observe A Complete Operation

1. On first load, expect a microscope and environment lighting instead of a blank canvas.
2. Orbit, zoom and pan, then focus/reset. Select the equipment to inspect static information; click empty space to clear selection.
3. Select or drop a self-contained glTF 2.0 `.glb`. The new model is centered and framed automatically.
4. Import an invalid file or GLB with missing external resources. Expect explicit feedback and the previous usable model. A subsequent valid import should work.
5. Inspect FPS, draw calls, triangles and resource counts. JS heap and GPU timing differ from object counts; unavailable measurements are marked unavailable.

Files stay in the current browser session without server upload. Refresh does not guarantee recovery of imports. v1 inspects one model at a time and has no placement editor.

## Assets And Evidence

The preset is Poly Haven's [Industrial Microscope](https://polyhaven.com/a/industrial_microscope), by Lukas Walzer, CC0. The environment is [Studio Small 03](https://polyhaven.com/a/studio_small_03), by Greg Zaal, CC0. Sources and runtime GLB/HDR files are preserved with the preview.

Prior Chromium/SwiftShader checks cover rendering, imports, selection, camera and recovery. Software-rendering FPS is not GPU acceptance, and preview bundle size is not production budget evidence. The [experience record](../ui/lab-viewer-experience.md)documents scope and evidence.

Identity and template navigation are simulated, and the v1 visual experience is accepted. The user's correction makes Lab and Asset Library the main business navigation while retaining legacy knowledge routes. Production routing, import lifecycle and [public validation](../testing/t01-feedback-loop.md)still await acceptance. See [product architecture](../architecture/lab-word.md).

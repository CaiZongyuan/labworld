# Use Lab And The Asset Library

Goal: inspect equipment in the application, import a local GLB and reopen it from the asset library. Lab uses the existing identity and shell; 3D code loads with the page.

## Application

From the repository root:

```bash
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/lab>. Sign in or register at `/register`; both login and registration land on Lab. `just dev` starts services and runs migrations against existing development data, not an isolated test environment.

1. The Lab entry creates and opens persistent laboratories with an object directory, scene and Inspector. Follow the [persistent Lab and objects tutorial](../tutorials/persistent-world.md) for registration.
2. Open the bundled industrial microscope from the asset library to preview it at `/lab/asset`. Orbit, zoom and pan. Fit preserves the viewing direction and reset restores the original direction. Click the model to select it, or empty space to clear selection.
3. Select or drop a self-contained glTF 2.0 `.glb`; it is centered and framed while preserving its scale.
4. In Asset library, provide name, source, license and version when importing. Publish, search by name or filename, open in Lab, or confirm deletion of an unreferenced asset.
5. Invalid imports show feedback and preserve the previous usable model; a valid retry recovers.

The catalog and GLB bytes persist on the server and can be reopened after a reload or in another browser. The preset remains available. Built-in definitions expose specifications, capabilities and state structures. Backend lighting programs and temperature sensors are implemented. Read the [lighting tutorial](../tutorials/backend-lights.en.md) and [continuous temperature tutorial](../tutorials/continuous-temperature.en.md). The [persistent assets tutorial](../tutorials/persistent-assets.en.md) covers Member/Agent imports, failure recovery and the file lifecycle. Legacy document and knowledge-base URLs retain their meaning. FPS, draw calls, triangles, object counts and available JS heap are observed live. GPU timing is not sampled and object counts do not measure GPU memory bytes.

Start at the [assembly](../../apps/web/src/app-examples.tsx), [Lab contribution](../../packages/views/src/lab/app-example.tsx) and [viewer](../../packages/views/src/lab/lab-view.tsx). The [asset record](../../assets/README.md) retains originals, runtime files and licenses.

```bash
pnpm exec vitest run apps/web/src/lab.test.tsx
pnpm typecheck
node scripts/perf-bundle.mjs
```

Page checks cover the catalog, navigation, import feedback and removal. WebGL, camera, selection and resource lifetime require browser verification. Background server logs must live outside the application's watched directory to avoid console/file-watch reload loops.

## Historical v1 Preview

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

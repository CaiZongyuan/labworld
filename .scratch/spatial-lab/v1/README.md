# Lab Word Spatial Workspace Preview v1

Status: delivered for review; visual direction and interactions are awaiting user feedback.

Question: does a scene-led laboratory workspace make inspection and device operation clearer than the current permanent directory, inspector and history layout?

The user's references are the WareTrack video at `.scratch/design/DilumSanjaya-2106426962738880879-01.mp4` and the feel of Tesla's vehicle interface. This version follows the agreed direction with one coherent layout. It retains Lab Word's vocabulary, shared components, semantic colors and lower-left account entry. The new composition is proposed design evidence, not an approved replacement for the production interface.

## Open

<http://127.0.0.1:5193/prototype/spatial-lab>

From the repository root:

```bash
pnpm --dir .scratch/spatial-lab/v1 dev
```

Vite selects another port if 5193 is occupied; use the address printed by Vite.

In this workspace, `node_modules` links to the existing isolated preview dependencies. For a fresh checkout, install the repository dependencies and then install this preview's dependencies:

```bash
pnpm install --frozen-lockfile
pnpm --dir .scratch/spatial-lab/v1 install --ignore-workspace
pnpm --dir .scratch/spatial-lab/v1 dev
```

No API, login, database or physical equipment is required.

## Critical Journey

1. Open the laboratory overview. Orbit, zoom, switch to top view and restore the full scene.
2. Select a centrifuge in the scene, through its label or through the object directory. The selection and device panel stay connected. Double-click or use the locate command to focus it.
3. Set target RPM, temperature and duration. Start a task. Actual observations approach their targets before timed operation begins.
4. Stop the task. Observe deceleration, a cancelled result and an idle device. Start another task and let it complete. The two centrifuges have independent state.
5. Inspect the sensor, adjust lighting, open the device records and expand the laboratory history.
6. Switch to layout editing. Move the selected object with the Three.js transform control or coordinate inputs. Save or discard the draft. Registered location stays separate from three-dimensional placement.
7. Open the asset library, name a new object and add it to the same laboratory. The empty scenario supports adding the first object.
8. Inspect the mobile layout. The scene stays above the device panel; centrifuge commands stay at the bottom of that panel.

The separate preview toolbar offers 1x, 10x and 30x simulated time; normal, disconnected, empty, loading, device-failure, save-conflict and read-only scenarios; and reset. These controls are outside the evaluated product surface.

## Actual And Simulated

Actual browser behavior: Three.js geometry, lights, shadows, equipment selection, pointer orbit, zoom, smooth focus, layout transforms, form validation, responsive panel placement, keyboard operation, shared Base UI components, Lucide tools and existing raster asset thumbnails.

Simulated behavior: equipment observations, independent centrifuge tasks, lighting commands, sensor history, identity and permissions, connection loss and recovery, layout save and conflict handling, asset registration and event records. All state lives in browser memory. Reload clears it. The accelerated device model is an illustration of the existing task phases, not a physical dynamics model.

Offline display freezes the last visible observations while the in-memory simulator continues. Reconnection reveals the latest state. A disconnected command is disabled. The robot has descriptive capabilities but no executable operation. All equipment is explicitly identified as simulated.

The preview does not call application APIs. Save does not persist to a server or browser storage. No physical-device integration, GLB import, real multi-user conflict resolution or server history service is included in this design probe. The temperature chart is generated from the same deterministic simulated temperature curve as the sensor reading.

## Verification

```bash
node .scratch/spatial-lab/v1/inspect-preview.mjs
node node_modules/typescript/bin/tsc --project .scratch/spatial-lab/v1/tsconfig.json
pnpm --dir .scratch/spatial-lab/v1 build
```

`evidence/inspection.json` records the completed browser inspection. Screenshots cover the overview, selected device, running/completed/cancelled tasks, records, assets, recovery scenarios, 390px mobile and 320px dark appearance. Canvas pixel samples check that the scene is populated and that pointer orbit changes the actual canvas. The inspection also checks label overlap, page overflow, visible mobile actions, image loading, browser errors and absence of application API requests.

Chromium uses ANGLE SwiftShader. This is visual and interaction evidence; it is not a target-hardware performance measurement or production acceptance.

v1 remains intact after delivery. Feedback will produce v2. Production implementation and its required engineering checks follow experience acceptance.

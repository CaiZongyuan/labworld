# Digital Twin Foundation — Experience Preview v1

Question: can a user build a laboratory, inspect independent entities, operate virtual devices and understand their results within the accepted Lab Word workspace?

This is a disposable, isolated experience preview. One coherent layout follows the accepted application shell and the repository experience-design workflow. Product implementation must use the accepted experience as evidence and build the actual persistence, device runtime and API through the normal engineering flow.

## Open

<http://127.0.0.1:5191/prototype/lab-foundation>

Run from the repository root:

```bash
pnpm --dir .scratch/lab-foundation/v1 dev
```

The current workspace already has dependencies available. On a fresh checkout, install the repository dependencies first, then install the preview's pinned dependencies:

```bash
cd .scratch/lab-foundation/v1
pnpm install --ignore-workspace --frozen-lockfile
pnpm dev
```

No API, database service, account or physical device is required. The initial view contains two centrifuges, a temperature sensor, a light, a robot, two benches and a beaker. Browser preferences follow the existing shell; the first visit defaults to Chinese.

## Try the journey

1. Select **离心机 01 / Centrifuge 01**. Start a run. RPM and temperature approach their targets before the timer starts. The second centrifuge stays independent.
2. Stop the task and watch deceleration. The task becomes cancelled and the device returns to idle. A normal run ends as completed. The separate preview bar defaults to **30× time** so a ten-minute run can be reviewed quickly; 1× and 120× are also available.
3. Select the light and toggle power or brightness. Select the sensor to see continuous readings. The robot exposes descriptive, unimplemented capabilities.
4. Use **添加对象 / Add entity**, choose an asset and name the new entity. In **编辑布局 / Edit layout**, drag it on the real 3D canvas, rotate it, or duplicate it as an independent instance.
5. Open **属性 / Properties**. Coordinates change the visual placement; **更新登记位置 / Update registered location** changes the explicitly recorded relationship. These are independent actions.
6. Save the Lab, then refresh the browser. Layout, entities, relationships and imported model bytes are restored from this preview's separate browser database.
7. Open **Agent 客户端 / Agent client** in the preview bar. Query the world, create a light, or issue Start/Stop to a centrifuge. The same world and event history update with Agent attribution.
8. Use the preview scenario selector to inspect empty, loading, disconnected, save-conflict, expired-session, runtime-restart and failure states. The restart case keeps task results and requires an explicit program start.

**F** focuses the selected object. Pointer orbit, wheel zoom, top view and camera reset work in the actual WebGL scene. On narrow screens the scene sits above the inspector and the directory opens as an overlay. The existing shell provides theme, language and navigation controls.

## Real and simulated

Real browser behavior:

- React application shell, shared shadcn/Base UI components, Lucide icons and production semantic colors.
- Three.js/R3F rendering, raycast selection, pointer placement, camera movement, state-driven rotor and light visuals.
- GLB parsing, independent scene instances, metadata/relationship editing, actual IndexedDB save and refresh recovery.
- Device state machines, input rejection, busy handling, task results and the same browser-owned state for user and Agent actions.

Simulated capabilities and limits:

- Identity, network connection, server snapshots, API requests and device programs are simulated entirely in the browser. There is no production or physical-device connection.
- The Agent panel is a preview tool, not a deployed HTTP API. The browser's visible observations freeze during simulated disconnection; the internal simulator continues and reconnect publishes its latest state.
- The preview stores **layout and model resources only** in the `PROTOTYPE-lab-foundation-v1` IndexedDB database. Runs and event history are in-memory and reset on actual reload. Closing the browser stops this local simulator; the real product's server-owned lifecycle is represented by the scenario controls, not implemented here.
- Saving demonstrates local persistence, not multi-user server persistence. Conflict recovery is a controlled scenario and does not prove real concurrent editing.
- The 24-hour observation and 30-day history labels express the accepted product policy. This preview retains a bounded event sample and does not implement a history service or retention cleanup.
- Imported self-contained, uncompressed GLBs can create static model entities. Full decoder support, replacement of a device's model and semantic mappings for arbitrary imported geometry remain implementation work; existing product loading code is the reference.
- Built-in geometry is procedural illustrative geometry created for this preview, not manufacturer CAD or a physical simulation. RPM animation communicates state and is not a physical motion model.

The separate bottom bar keeps time acceleration, fault injection, resetting and the Agent client outside the product surface being evaluated. Prototype state stays on this browser origin and never calls the application backend.

## Validation and evidence

```bash
node .scratch/lab-foundation/v1/inspect-preview.mjs
node node_modules/typescript/bin/tsc --project .scratch/lab-foundation/v1/tsconfig.json
pnpm --dir .scratch/lab-foundation/v1 build
```

Run these from the repository root. `evidence/inspection.json` records 19 passing browser checks and screenshots. Three additional targeted checks in `evidence/lifecycle-inspection.json` cover archive guards and discovery, referenced-asset deletion, and usable English registration at 320px. Both runs recorded no page errors. Chromium uses SwiftShader software rendering: screenshots and pixel checks establish visible behavior, not target-GPU performance. The standalone build is not a production bundle-budget result; the normal Vite large-chunk advisory remains visible.

The initial inspector layout required an explicit column direction for this isolated composition. Pixel inspection waits for the renderer-owned canvas to be initialized before obtaining its WebGL context: creating a context earlier would prevent the renderer's requested drawing-buffer settings from taking effect and invalidate pixel evidence. The final inspection distinguishes task outcome from device state and verifies that copied visual instances remain separate entities.

The approved design input is captured alongside this preview as `design-input.md`. `capture-preview.mjs` preserves the version and evidence in the local `preview/lab-foundation-v1` branch without changing the user's current branch or index. Feedback produces v2; v1 remains the original review artifact.

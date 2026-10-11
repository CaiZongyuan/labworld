# View representations and locate an object

<script setup>
import { withBase } from 'vitepress';
</script>

Goal: inspect the registered space, keep the camera during selection, and deliberately locate an object.

## Starting state and source

Complete [Spatial workbench](spatial-workbench.md). Keep the same persistent Lab and its two objects. Use the current checkout containing this chapter. A Member needs a valid session. Agent writes use the same public interfaces with an active `lab:full` key.

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab> and choose your Lab. Viewing and framing do not save Placement. Registering objects, starting programs and changing appearances write development data.

The [viewport](../../packages/views/src/lab/world-viewport.tsx) renders the actual World. [Native geometry](../../packages/views/src/lab/builtin-models.ts), [camera framing](../../packages/views/src/lab/camera-framing.ts) and [priority labels](../../packages/views/src/lab/world-labels.tsx) own this chapter's changes. [Lab ownership](../../packages/server/src/lab/ownership.json) reserves the shared representation metadata for Lab consumers.

## Keep the view and then locate

1. Orbit or zoom the canvas.
2. Select either object through its model, label or directory.

   Selection retains the camera position and target. Panels and viewport resizing also retain that pose. The available area changes the projection.

3. Choose **Fit model**.

   The camera frames the active Scene Node. Without an active node, this command frames the full layout.

4. Choose **Frame full layout** to include all visible representations.
5. Choose **Top view** to inspect Placement from above.
6. Double-click an object's model or label name.

   This explicitly locates that node again. Orbit input interrupts a framing transition. The operating system's reduced-motion preference makes framing immediate and disables orbit damping.

To observe a live device, register a built-in sensor and select **Start program** under **Operations**. Wait for its actual observation. Its label updates while the camera keeps its pose. Continue with [device details](device-details.md) for targets, Commands and Task results.

## Read labels and native models

<img :src="withBase('/lab-spatial-representations-v1.png')" alt="Registered native objects and actual virtual-program observations at 1600×1000" />

These eight objects come from isolated verification of the actual Node/Web application. The server supplies identities and observations; devices use virtual programs. Representations describe benches, devices and vessels. The image establishes no room identity or measured room dimensions.

Labels prioritize selected objects, active Tasks and key readings, in that order. They avoid one another and the actual opaque panels and tools. An offscreen selected object offers **Locate**. The sensor's **Recent minute** action opens its historical view when the trend chapter is available.

Current readings use the same connection, Binding, Run, type, source-time, quality and freshness checks as Operations. Last reported values remain distinct. Stopping a source retains the last light appearance. Invalid or offline rotor readings stop current motion. The Robot's static articulation does not prove physical movement or control.

Native benches, devices and beakers have separate geometry and materials per instance. The existing Environment remains a location marker. A grid or an empty Lab does not establish a room identity or measured room dimensions.

## Use the shared dimensions

The generated [representation profiles](../../packages/contracts/src/lab-representations.ts) freeze native bounds and support heights. The renderer owns their [generator](../../scripts/generate-lab-representations.mjs).

Use this data import from Lab code under `packages/views/src/lab` or `packages/server/src/lab`. Those workspace packages already declare the contracts dependency.

```ts
import { labRepresentationProfiles } from '@labos-threejs/contracts/lab-representations';

const bench = labRepresentationProfiles.profiles.bench;
// bounds.size is [width, height, depth] in metres.
// bench.bounds.size is [2.8, 0.96, 1.25].
// bench.worktopHeight is 0.96 above the node's support plane.
```

Placement position uses metres, rotation uses radians, and scale is a positive multiplier. Native origins use a base support plane at Y=0. A GLB retains its original units and scale. Its placement anchor uses the bounding-box X/Z centre and minimum Y. File bounds remain the source for imported dimensions.

These dimensions describe representations. They are not manufacturer measurements. Changing a view or appearance does not change Entity identity or Registered Location. Templates must use these profiles or the actual chosen file bounds.

## Recover an appearance failure

1. Publish a valid GLB through **Asset Library** with its name, source, licence and version.
2. Choose that representation through the object's existing **Replace appearance** action.
3. If a replacement GLB fails to load, inspect the error. The last usable GLB remains visible.
4. Restore access or publish a corrected file, then choose a valid representation.

The recovered appearance keeps the same Entity, Task and Run. Pending replacements and cancelled loads do not replace a usable model with a partial file. See [appearance replacement](entity-lifecycle.md) for asset references and archiving.

## Verify and continue

```bash
pnpm representations:check
LAB_WORD_MIGRATION_DESKTOP=false node scripts/e2e-suite.mjs tests/e2e/lab-spatial-representation.spec.ts
LAB_WORD_MIGRATION_DESKTOP=false node scripts/e2e-suite.mjs tests/e2e/lab-spatial-models.spec.ts
```

The first command checks generated dimensions against native vertices. The browser command uses isolated Node/Web services, accounts and data. It checks public camera pixels, labels, explicit framing and agreed viewport sizes. It does not use the active development Lab. Functional and visual acceptance remain separate checks.

Continue with [Operate devices through the same Entity detail](device-details.md).

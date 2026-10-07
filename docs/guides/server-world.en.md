# Register Worlds and Layouts with the Node Server

Goal: create a persistent Lab, register independent Entities, share a representation, then save a layout and recover from 409. Complete [Node digital assets](server-assets.en.md) first. Prepare a Member and an active `lab:full` Agent key. You need Node 24, pnpm, and Linux or Windows. `pnpm dev` requires no Docker. Run commands from the repository root. They write development data.

## Register and Find the Same Identity

Open <http://127.0.0.1:5173/lab>, select **Create Lab**, and enter `Identity lab`. Register two `robot · 1.0` objects named `Robot A` and `Robot B`. The directory and Inspector show separate Entity UUIDs. Node and Lab UUIDs are also independent.

Select a Robot in the directory or click its appearance in the canvas. The Inspector should show that object. After a reload, use **Open Lab** to read the persistent world. The registration dialog can use the uploaded GLB. Two Entities may share one representation. One Entity may have several Scene Nodes with independent Placements.

Static bench, model and Robot objects have no Binding, Run or Observation. Robot capabilities are declarations and cannot execute. Simulated lights, sensors and centrifuges retain their binding metadata, Node now runs these device programs. A ready World response has `X-Lab-Runtime: ready`; subscriptions also report runtime_status. Continue with [Node devices](server-devices.en.md). Placement and instance configuration cannot stand in for device observations.

Run the same registration business with an Agent:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
# Optional: export LAB_ID=<existing-lab-uuid>
# Optional: export LAB_REPRESENTATION_ID=<representation-uuid-from-asset-import>
node examples/lab/register-static-world.mjs
```

The script submits an invalid definition version and confirms that World stays unchanged. It then registers two Robots and queries `kind=robot&capability=robot.pick&state=unknown`. Output contains independent Entity UUIDs, node UUIDs and declared capabilities. Run and Observation remain null; the executable set is empty. An existing Lab keeps its objects. Repeated registration creates another Entity.

<<< ../../examples/lab/register-static-world.mjs

## Edit, Register Relationships and Recover from Conflict

Register a bench with `bench · 1.0` and a beaker with `labware · 1.0`. Select the beaker, enter **Edit layout**, change position, rotation or scale, then select **Save layout**. Position uses meters; rotation uses radians. Register **Located in** the bench and save again. The relationship has manual source, actor and time. A coordinate change alone does not establish physical movement.

Sign in as another Member in an independent browser. Open the same Lab and enter layout editing on both pages. Save the second page first. Saving the first returns `409 lab.layout_conflict` and retains its draft. Select **Reload and keep draft**, compare the new layout, then **Retry save**. You can explicitly discard the draft. Conflict preserves page drafts; save before reloading the page.

The Agent script verifies save, conflict, invalid-cycle rollback, copying, multiple representations and removing/restoring nodes:

```bash
node examples/lab/edit-layout.mjs
```

<<< ../../examples/lab/edit-layout.mjs

`PUT /api/v1/lab/labs/{lab_id}/layout` accepts `expected_version`, the complete `nodes` array and optional complete `relationships`. Omission or null retains relationships; `[]` clears them. The server writes manual provenance. Saving unchanged relationship facts preserves the original actor and time. Contains and located-in share an acyclic graph and one-container rule. Simulates requires a simulated source and physical target of the same definition. Cross-Lab references and invalid graphs return 400 and roll back all changes.

Removing a node retains its unplaced Entity. **Copy as independent instance** creates another Entity and node with the source definition snapshot, configuration and appearance. It retains empty Run and Observation. Copy uses the layout version check and does not copy history or execute a program.

## Limits, Sources and Checks

A Lab has at most 1000 Entities, 1000 Scene Nodes and 1000 relationships. Layout input is limited to 512 KiB; ordinary JSON remains limited to 16 KiB. Configuration JSON is limited to 8192 bytes. Position and rotation absolute values are at most 10000. Scale is 0.001–1000. World `kind/capability/state` filters apply consistently to Entities, nodes, referenced assets and relationships. Use `state=unknown` for absent observations.

[World use cases](../../packages/server/src/lab/world/use-cases.ts), [layout transactions](../../packages/server/src/lab/world/layout.ts), [relationship rules](../../packages/server/src/lab/relationships/domain.ts) and the [definition catalog](../../packages/server/src/lab/world/catalog.json) own these facts. World uses an actual SQL JSON aggregate. The complete request budget is 10 SQL statements, including authentication and BEGIN/COMMIT. It does not query each Entity separately.

```bash
node --test --experimental-strip-types tests/server/lab-world.test.ts tests/server/lab-capacity.test.ts tests/server/lab-budgets.test.ts
pnpm contracts:m1:check
```

The isolated desktop browser supplement runs on Linux:

```bash
pnpm exec playwright install chromium
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

It uses the real Node server, Vite, existing Web/SDK and WebGL. It checks asset deep links, visible scene pixels, selection and conflict drafts in two browsers. It records and cleans owned processes and temporary data; the printed directory retains evidence. It does not start the old service. The official SDK source and default application composition switch remain later migration work. Node now implements device, synchronization and history contracts. HTTP types and errors come from the [generated API](site:reference/api.md). Lab ownership is recorded in the `vnext` field of [module.json](../../crates/app/src/modules/lab/module.json).

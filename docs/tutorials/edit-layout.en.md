# Edit Layout and Register Location

Place a beaker, explicitly register it on a bench, and keep a draft after another browser saves first. Copying an object, adding another representation, and removing a representation verify identity and recovery separately.

## Starting Version and Changes

Use the common version specified in the [complete journey](complete-foundation.en.md). Complete [persistent Lab and objects](persistent-world.en.md) and [backend lighting](backend-lights.en.md) first. Run commands from the repository root. Browser operations and the script write development data.

Sources: [layout HTTP](../../crates/app/src/modules/lab/layout.rs), [relationships](../../crates/app/src/modules/lab/relationships.rs), [migration](../../migrations/0022_lab_relationships.sql), [placement Inspector](../../packages/views/src/lab/layout-editor.tsx), [relationship form](../../packages/views/src/lab/relationship-panel.tsx), [real 3D transforms](../../packages/views/src/lab/world-viewport.tsx), and [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). [Lab ownership](../../crates/app/src/modules/lab/module.json) lists the tables, contracts, checks, and tutorial.

## Place and Register in the Browser

```bash
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/lab>, sign in as a Member, and create `Layout lab`. Register `North bench` from `bench · 1.0` and `Beaker A` from `labware · 1.0`, using the built-in appearance.

1. Select the beaker and switch to **Edit layout**. Use Move, Rotation, or Scale and drag an axis in the canvas, or enter numbers in the Inspector. Positions use m, rotations use rad, and scales are multipliers. Inputs support Tab and arrow keys; tools and save controls support focus and Enter.
2. Set `X=0, Y=0.9, Z=0.2` and **Save layout**. There is still no registered relationship. Graphic coordinates do not establish that physical material moved.
3. Under **Registered relationships**, choose **Located in** and `North bench`, click **Register relationship**, then save. The relationship shows **Manually registered**, its actor, and its registration time.
4. Change X and save again. The same bench and provenance remain registered. When selecting the bench, you can explicitly register that it **Contains** the beaker. An object has one spatial container; both spatial kinds participate in cycle checks.
5. Register simulated and physical Robots from the same definition. Select the simulated Robot, choose **Simulates** and the physical object, then save. Entity identities stay separate; physical objects still have no executable Binding.

Furniture, locations, and Labware can be spatial containers. Self-references, cross-Lab references, invalid containment cycles, and invalid simulation correspondence return 400, roll back all changes, and keep the page draft for correction. Simulation correspondence points from a simulated object to a physical object of the same definition. To change a relationship's meaning, remove it and explicitly register a new relationship.

## Distinguish Objects and Nodes

**Copy as independent instance** immediately creates a new Entity and node, retaining the frozen definition, configuration, and object appearance. Relationships, observations, and program runs are not copied. Save the current draft before copying. A new device has its own Binding and requires an explicit program start.

**Add another representation** creates a node draft in edit mode while retaining the Entity id. Choose **Edit node** to transform that specific representation. After saving, one Entity can have multiple independent Placements. The existing runtime-view representation command also uses the same business rules and persists immediately.

**Remove node** only removes the representation from the draft. After saving, identity and registered relationships remain. Enable **Unplaced objects only** in the directory, find the object, add a representation, and save. Imported model metadata stays with the object, allowing the original model to load again.

## Create a Conflict in Two Browsers

1. Sign in as another Member in an independent browser or private window and open the same Lab. Enter edit mode in both pages. Change the beaker X in the first page and the bench X in the second.
2. Save the second page first. Saving the first returns `409 lab.layout_conflict` and **Layout changed; draft retained**. The beaker input still contains your value.
3. Choose **Reload and keep draft** to read the latest comparable version and merge local changes. Unchanged nodes and nodes added by the other editor remain. If both editors changed the same node, an explicit retry uses your local node draft.
4. Choose **Retry save**. Refresh the other browser to see both changes. Another conflict retains the draft again. You can explicitly **Discard draft and reload** to adopt the server layout.

Switching Labs or runtime view retains each Lab's draft in this page. Unsaved drafts are kept only in the current page; save before leaving or refreshing. Cross-browser restoration uses server-saved results.

Start a light, change its coordinates in edit mode, then toggle power. Subscriptions update the device snapshot while keeping the coordinate draft. Saving retains the Run and observation. Layout saves do not submit runtime data, and observations do not increment `layout_version`.

## Use the Same Operations as an Agent

Obtain an active `lab:full` API key in settings. Set `LAB_ID` to continue the previous Lab. Without it, the script creates a Lab. It adds a bench, beaker and simulated/physical Robots. It checks conflicts, rejected cycles, independent copies, multiple representations and remove/restore.

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/edit-layout.mjs
```

Expected output contains Lab, original beaker, independent-copy UUIDs, the layout version, and relationships with `source=manual`, `registered_by`, and `registered_at`. Open that Lab in the browser to inspect the same saved results. The credential is not printed.

Complete requests:

<<< ../../examples/lab/edit-layout.mjs

`PUT /api/v1/lab/labs/{lab_id}/layout` accepts `expected_version`, the complete node array, and an optional complete relationship array. Nodes contain `id/entity_id/representation_id/placement`; relationships contain `id/source_id/target_id/kind`. Omit relationships to preserve them; `[]` explicitly removes all relationships. The server records manual provenance; clients cannot supply actor or registration time. Existing relationship ids retain their meaning.

`POST .../entities/{entity_id}/copies` accepts `expected_version/name/placement` and returns a new Entity. Session writes require CSRF; Agents use an active Bearer credential. Members and Agents share the full Lab business rules. Layout payloads are limited to 512 KiB, with at most 1000 nodes and 1000 relationships. Position/rotation absolute values are at most 10000; scales range from 0.001 to 1000.

## Verify and Continue

```bash
node scripts/test-backend.mjs --test lab_world --test lab_devices
pnpm test:frontend apps/web/src/lab-world.test.tsx
node scripts/e2e.mjs tests/e2e/lab-layout.spec.ts
```

HTTP checks use the real Router and isolated PostgreSQL. Page tests replace only HTTP with MSW. Browser checks use real application services, independent contexts, and WebGL pointers. Continue with [reliable synchronization and recovery](reliable-sync.md) to observe one world from two browsers and an Agent and verify connection recovery and revocation.

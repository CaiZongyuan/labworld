# Create a Lab and Independent Objects

Goal: register two independent Entities from one definition, find the same identities in the browser and World API, and distinguish a Robot's declared capabilities from executable actions.

## Starting Version and Changes

Start at `e6f80f5`, after [persistent digital assets](persistent-assets.md): server assets, the built-in definition catalog and a `lab:full` Agent credential exist. This chapter implements [Issue #3](https://github.com/CaiZongyuan/labworld/issues/3). Use a checkout containing this implementation. Run commands at the repository root; browser registration and the script below write to the development database.

Sources: [World HTTP](../../crates/app/src/modules/lab/world.rs), [persistent model migration](../../migrations/0019_lab_world.sql), [workbench](../../packages/views/src/lab/world-view.tsx), [multi-object scene](../../packages/views/src/lab/world-viewport.tsx) and [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). [Lab ownership](../../crates/app/src/modules/lab/module.json) declares tables, contracts, tests and tutorials. Identity, CSRF, files and audit remain Core public capabilities.

## Register Two Objects in the Browser

```bash
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/lab>, sign in as an ordinary Member, click **Create Lab**, enter `Identity lab`, then create it.

1. Click **Register object**, choose `Collaborative robot arm · 1.0`, built-in appearance and simulated identity, name it `Robot A`, then click **Register**.
2. Register `Robot B` using the same definition version. The directory has two entries and the scene has two separate representations.
3. Click each directory entry or robot in the canvas. The Inspector shows different Entity UUIDs and the same `robot · 1.0` definition. Directory checkboxes select multiple objects; Shift-click in the canvas extends selection too.
4. Click **Configure object**, change its name and label, and save. Instance configuration does not rewrite its definition, Placement or observations.
5. Click **Add representation of this object**. A new node UUID appears while the Entity UUID remains unchanged. Registering another object creates a new Entity.
6. Reload, or sign in as another Member in a separate browser and select `Identity lab` in **Open Lab**. Objects, definition snapshots, nodes and basic placements return.

The Robot declares `move/pick/place`, but Binding implementation and current executability are both “No”. Without observations, it shows **Unknown · No observation**. Choosing “Physical object · Not connected” creates a separate identity without connecting any physical protocol. Relationships and device programs follow in later stages.

Upload a GLB in the asset library, then select it under **Appearance** during registration. One asset can serve two independent objects; representation, file, node and Entity UUIDs remain separate. Deleting a referenced asset returns 409 and its file stays available. **Open in Lab** in the library previews the file at `/lab/asset`; it does not register an Entity.

## Query the Same World as an Agent

Create an active `lab:full` credential in Settings > API keys. This script creates a new Lab and two Robots. To use an existing Lab, set `LAB_ID` to the Lab UUID in the Inspector.

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
# Optional: export LAB_ID=<existing-lab-uuid>
node examples/lab/register-world.mjs
```

Expect one Lab UUID, two different Entity UUIDs, independent node UUIDs, three declared capabilities and an empty executable capability list. Reopen that Lab in the browser to see the same objects. The script queries and compares the World and actually calls `robot.pick`, verifying a 422 refusal leaves the world unchanged.

Complete executable requests:

<<< ../../examples/lab/register-world.mjs

`GET /api/v1/lab/labs/{lab_id}/world` returns the Lab layout version, Entities, nodes and their referenced assets. Combine `kind`, `capability` and `state=unknown` filters. No runtime Binding exists yet, so all objects lack observations; other state filters return an empty set. `kind` uses the definition catalog category. Configuration is an instance JSON object with an 8192-byte limit; names have at most 120 characters; a Lab has at most 1000 Entities and 1000 nodes. The Lab list defaults to 50 entries per page, accepts `limit` from 1–100 and uses `next_cursor` to continue; the browser offers “Load more”. Placement uses meters, radians and positive scale. Registration persists a basic arrangement; interactive editing follows later.

## Failure and Recovery

Register with a nonexistent `definition_version` or `representation_id`. HTTP returns `400 lab.invalid_reference`; no Entity or node appears, and the layout version stays unchanged. Retry with a version and representation from the catalog. A temporary browser service failure retains the name, definition and appearance in the registration dialog. Repeating a successful registration creates another object, so do not blindly repeat an uncertain request.

Referenced asset deletion returns `409 lab.asset_in_use`; use an unreferenced asset to verify deletion. Robot actions return `422 lab.capability_not_implemented`, and retrying does not enable execution. Missing CSRF, invalid Bearer and revoked keys reject writes. Obtain an active credential before continuing.

## Verify and Continue

```bash
node scripts/test-backend.mjs --test lab_world --test lab_assets
pnpm exec vitest run apps/web/src/lab-world.test.tsx apps/web/src/lab.test.tsx
node scripts/e2e.mjs tests/e2e/lab.spec.ts
```

HTTP uses the real Router and isolated PostgreSQL, with real object storage for files. Components replace only HTTP with MSW. Browsers use real GLB/WebGL for directory/canvas identity, cross-context recovery, compressed loading and resource isolation. [Issue #4](https://github.com/CaiZongyuan/labworld/issues/4) adds independent backend light programs, commands and observations. Layout and instance configuration in this chapter never stand in for measured runtime state.

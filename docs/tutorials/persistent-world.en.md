# Create a Lab and Independent Objects

The Node entry provides static Entities, nodes, World and layouts. Execution and actions remain in migration. Continue with [Node World](../guides/server-world.en.md) and its static registration script.

Goal: register two independent Entities from one definition, find the same identities in the browser and World API, and distinguish a Robot's declared capabilities from executable actions.

## Starting Version and Changes

Use the common version specified in the [complete journey](complete-foundation.en.md). Complete [persistent digital assets](persistent-assets.en.md) first. You need server assets, the built-in definition catalog and a `lab:full` Agent credential. Run commands from the repository root. Browser registration and the script write development data.

Sources: [World HTTP](../../packages/server/src/lab/world/use-cases.ts), [persistent model migration](../../packages/server/migrations/0000_baseline.sql), [workbench](../../packages/views/src/lab/world-view.tsx), [multi-object scene](../../packages/views/src/lab/world-viewport.tsx) and [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). [Lab ownership](../../packages/server/src/lab/ownership.json) declares tables, contracts, tests and tutorials. Identity, CSRF, files and audit remain Core public capabilities.

## Register Two Objects in the Browser

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab>, sign in as an ordinary Member, click **Create Lab**, enter `Identity lab`, then create it.

1. Click **Register object**, choose `Collaborative robot arm · 1.0`, built-in appearance and simulated identity, name it `Robot A`, then click **Register**.
2. Register `Robot B` using the same definition version. The directory has two entries and the scene has two separate representations.
3. Click each directory entry or robot in the canvas. The Inspector shows different Entity UUIDs and the same `robot · 1.0` definition. Directory checkboxes select multiple objects; Shift-click in the canvas extends selection too.
4. Click **Configure object**, change its name and label, and save. Instance configuration does not rewrite its definition, Placement or observations.
5. Click **Add representation of this object**. A new node UUID appears while the Entity UUID remains unchanged. Registering another object creates a new Entity.
6. Reload, or sign in as another Member in a separate browser and select `Identity lab` in **Open Lab**. Objects, definition snapshots, nodes and basic placements return.

The Robot declares `move/pick/place`. Binding implementation and current executability are both “No”. Without observations, it shows **Unknown · No observation**. **Physical object · Not connected** creates a separate identity without connecting a physical protocol. See [layout relationships](edit-layout.en.md) for implemented registration. Lighting programs are in the [next chapter](backend-lights.en.md).

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

`GET /api/v1/lab/labs/{lab_id}/world` returns the world version, Lab layout version, Entities, nodes, referenced assets and relationships. Combine `kind`, `capability` and `state=unknown` filters. This chapter's Robots have no runtime Binding or observations. Once lights report, `state=true/false` filters reported power. `kind` uses the definition catalog category. Instance configuration is a JSON object, limited to 8192 bytes. Names have at most 120 characters. A Lab has at most 1000 Entities and 1000 nodes. The Lab list defaults to 50 entries per page. It accepts `limit` from 1–100 and uses `next_cursor` to continue. The browser offers **Load more**. Placement uses meters, radians and positive scale. Registration persists a basic arrangement. See [layout editing](edit-layout.en.md) for implemented interactive controls.

## Failure and Recovery

Register with a nonexistent `definition_version` or `representation_id`. HTTP returns `400 lab.invalid_reference`; no Entity or node appears, and the layout version stays unchanged. Retry with a version and representation from the catalog. A temporary browser service failure retains the name, definition and appearance in the registration dialog. Repeating a successful registration creates another object, so do not blindly repeat an uncertain request.

Referenced asset deletion returns `409 lab.asset_in_use`; use an unreferenced asset to verify deletion. Robot actions return `422 lab.capability_not_implemented`, and retrying does not enable execution. Missing CSRF, invalid Bearer and revoked keys reject writes. Obtain an active credential before continuing.

## Verify and Continue

```bash
node scripts/test-backend.mjs --test lab_world --test lab_assets
pnpm exec vitest run apps/web/src/lab-world.test.tsx apps/web/src/lab.test.tsx
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab.spec.ts
```

HTTP uses the real Router and isolated PostgreSQL, with real object storage for files. Components replace only HTTP with MSW. Browsers use real GLB/WebGL for directory/canvas identity, cross-context recovery, compressed loading and resource isolation. Continue with [backend lighting control](backend-lights.md) for independent programs, commands and observations. Layout and instance configuration never stand in for measured runtime state.

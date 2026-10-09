# Import Your First Persistent Digital Asset

Goal: a normal Member saves a GLB and its metadata, a new browser and a real Agent read the same asset, and a failed import recovers.

## Starting Version And Changes

Use the Foundation V1 checkout specified in the [complete journey](complete-foundation.en.md). Keep the same version throughout the chapters. Asset, representation and file identities are separate. They use the existing file lifecycle. Run commands from the repository root. Uploads write development data.

The complete change lives in [Lab asset operations](../../crates/app/src/modules/lab/assets.rs), the [migration](../../migrations/0018_lab_assets.sql), [built-in definitions](../../crates/app/src/modules/lab/definitions.json), the [asset library](../../packages/views/src/lab/asset-library.tsx) and [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). Lab's [module.json](../../crates/app/src/modules/lab/module.json) declares ownership. Core provides public file and identity interfaces.

## Save A Model In The Browser

```bash
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/assets> and sign in as a normal Member. On a new deployment, register the Owner first, then a second account. Choose **Import GLB**, select `tests/fixtures/lab/cube.glb`, fill in name, source, license and version, and select **Publish asset**. The page displays this deployment's actual upload limit; defaults and settings are in the [generated configuration reference](site:reference/config.md). Unknown source or license may be left blank and appears as “Unspecified”.

After publication the catalog lists the file. Open it in Lab to see the one-meter cube. Reload, close the page, or sign in as another Member in a different browser and reopen the entry. Its original scale and bytes remain available. Names, versions and stable `file_id` values live on the server; short-lived signed URLs are obtained only when downloading.

Before publication the server decodes Draco, Meshopt, Basis, embedded images and data URIs and validates geometry data. The page also displays the decoded-resource limit. Models above that limit are refused rather than allowing unbounded decoding memory. Original compressed bytes remain unchanged.

Filter built-in definitions by category. Inspect specifications, capability parameters, state structures and interface support. Lights, sensors and centrifuges have implemented virtual programs. The later chapters show how to start them. Robot actions remain declared but unimplemented. A declaration does not make an action executable.

## Import And Read As An Agent

In application settings, create an **API key** with the `lab:full` scope. Members and Agents use the same asset operations. Session mutations require CSRF; Bearer mutations check key scope and lifetime.

From the repository root, set the development API address and enter your own key at the hidden prompt:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
export LAB_UPLOAD_KEY=first-cube-import
LAB_ASSET_NAME='Agent cube' LAB_ASSET_SOURCE='Generated test geometry' \
  LAB_ASSET_LICENSE=CC0 node examples/lab/import-asset.mjs tests/fixtures/lab/cube.glb
```

The script prints the asset id, representation id, stable file id, actual size and SHA-256. It has already read the metadata through GET, downloaded the bytes and checked the hash. Reload the browser catalog to find **Agent cube**. Repeating the same `LAB_UPLOAD_KEY` and metadata returns the same asset. Use a new key for changed input; otherwise the API returns 409.

The complete request sequence is executable source:

<<< ../../examples/lab/import-asset.mjs

## Failure And Recovery

1. Create any text file named `broken.glb` and select it in the asset library. Expect invalid-GLB feedback while the previous usable model and published catalog remain available.
2. Select and publish a valid `cube.glb` again. The server also checks format, references, data ranges and the scene graph. An Agent upload with external dependencies or invalid GLB returns 422 without publishing an asset.
3. A temporary upload or publication failure preserves metadata in the import dialog. Retry continues the same request. Expired or revoked credentials cannot publish; obtain a valid credential before retrying. Existing object cleanup reclaims abandoned uploads and deleted files.
4. Rename an asset or confirm deletion. A business reference prevents deletion with 409. An already issued download capability may remain usable until object cleanup runs; catalog deletion and previously issued capabilities have different lifetimes.

## Validation And Next Stage

```bash
node scripts/test-backend.mjs --test lab_assets
pnpm exec vitest run apps/web/src/lab.test.tsx
node scripts/e2e.mjs tests/e2e/lab.spec.ts
```

HTTP checks use isolated PostgreSQL and real object storage. Page tests replace only HTTP with MSW. Browser checks cover another context, a real Agent, GLB/WebGL, and Draco, Meshopt and Basis decoding.

Continue with the [persistent Lab and objects tutorial](persistent-world.md) to build Labs and separate Entity and Scene Node identities using these stable assets. The `/lab/asset` single-model preview in this chapter does not create lab objects or placement relationships.

# Save Digital Assets with the Node Server

Goal: publish a GLB as a Member, read the same original bytes as an Agent, then verify recovery after refusal. You need Node 24, pnpm, and Linux or Windows. Run commands from the repository root. They write the development directory you select.

Start `pnpm dev` using the [service foundation guide](server-foundation.en.md). The Node server provides persistent assets, Labs, Entities, Scene Nodes and layouts. Device execution, business subscriptions and history remain in migration. The source switch for the complete generated SDK is pending.

## Save the First Model

Open <http://127.0.0.1:5173/assets>. In a new directory, register an Owner, then a second account as a Member. Select **Import GLB**, choose `tests/fixtures/lab/cube.glb`, enter the name, source, license and version, then select **Publish asset**.

When the asset appears, select **Open in Lab**. The `/lab/asset` deep link opens the viewer directly. After a reload, reopen the saved model from the asset library. Asset selection currently stays within the page. This entry previews an asset. See [Node World and layout](server-world.en.md) to register an Entity. File, representation and asset have separate UUIDs. The download URL is a temporary capability.

## Save and Read with an Agent

Create a key with `lab:full` on the **API keys** page. Run these commands in Bash and enter the key at the hidden prompt:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
export LAB_UPLOAD_KEY=node-first-cube
LAB_ASSET_NAME='Node cube' LAB_ASSET_LICENSE=CC0 \
  node examples/lab/import-asset.mjs tests/fixtures/lab/cube.glb
```

The script returns asset, representation and file UUIDs. It downloads the original bytes and checks SHA-256. Keep credentials and signed URLs out of logs. The same `LAB_UPLOAD_KEY` and input return the same upload and asset. Change the key when changing input; otherwise the server returns 409.

<<< ../../examples/lab/import-asset.mjs

Members and Agents use the same HTTP interfaces. Session writes require Cookie, trusted Origin and CSRF. Agents use an active Bearer with `lab:full`. Completion rechecks the original credential after validation. Revocation or expiry during validation prevents publication.

## Verify Refusal and Recovery

Complete a GLB with a missing scene or corrupt pixel stream. The server returns `422 files.upload_rejected` and preserves the asset directory. That upload continues to return 422. Retry a corrected file with a new key. An upload without PUT returns `410 files.upload_expired` after expiry. An expired download URL refuses bytes. Obtain another URL through the authorized API to recover.

A temporarily unavailable codec or storage returns 503. Retry the same upload after recovery. Ready files use their persisted size and digest. Lowering `FILE_MAX_BYTES` rejects new oversized start inputs and replay of an original oversized start input. Completion and download of an existing ready file still read the original bytes.

Assets support rename and deletion. An Entity or node reference prevents deletion with `409 lab.asset_in_use`. Remove the references you own before retrying. Each maintenance pass checks at most 50 logical files and 100 directory entries. Rejected and expired upload bytes retire while terminal metadata and the original refusal remain. Representations, pins and unknown foreign keys continue to protect bytes.

## Sources, Limits and Checks

[Lab upload use cases](../../packages/server/src/lab/assets/use-cases.ts) own authorization, idempotency, GLB validation, representations and business audit. [Core FileService](../../packages/server/src/core/files/use-cases.ts) owns signatures, immutable bytes and logical references. [Lab composition](../../packages/server/src/lab/assets/composition.ts) declares only upload receipts as provisional metadata. It cannot waive logical deletion checks. Core does not depend on Lab.

The server uses shipped WASM, Basis and Meshopt codecs. Installation and startup require no Rust. It decodes Draco, Meshopt, Basis, embedded images and data URIs. The default upload limit is 20 MiB. Decoded resources and image allocations have separate 256 MiB rules. These rules do not cap total WASM heap, scratch space or process RSS. See [codec provenance and optional rebuilding](../../packages/server/codecs/README.md).

```bash
node --test --experimental-strip-types tests/server/lab-assets.test.ts tests/server/lab-assets-recovery.test.ts tests/server/lab-asset-gc.test.ts
pnpm contracts:baseline:check
```

Checks use real Node HTTP, the embedded database and owned temporary directories. They verify refusal, retry, exact bytes and cleanup without opening your development data. Recursive API checks generate isolated contracts from [Zod routes](../../packages/server/src/lab/assets/routes.ts) and confirm that the official SDK stays unchanged. Continue with [Node World and layout](server-world.en.md).

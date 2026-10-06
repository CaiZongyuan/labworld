# Publish files and business references

Use FileService in a real Application use case. Keep files, business records, references and audit within the required commit boundary. First complete the [platform guide](server-platform.md). You need an existing `FoundationContext`, `AuthPolicy` and initialized `FileService`. [runtime.ts](../../apps/server/src/runtime.ts) owns the actual composition.

The current service registers signed byte routes at `/objects/:id`. It has no generic file JSON API. The operations below are server capabilities for real Application handlers. Lab owns GLB rules and business routes. Their migration is still pending.

## Start an upload and send bytes

In the Application handler, get an actor with `requireAccess(context, auth, headers, requestId, 'lab:full', true)`. The request already uses Core HTTP operation metering. Call `service.start(tx, actor, input)` inside an existing `DbSession`.

`input` is `UploadInput`: `file_name`, `content_type`, `size` and a 64-digit hexadecimal `sha256`. `size` is the actual byte count. Read source bytes and calculate the digest outside the database transaction. The result contains `upload_id`, state and an `upload` capability.

Send raw bytes with the capability's complete URL, method and headers. Do not assemble the URL yourself.

```ts
if (!capability.upload) throw new Error('No pending upload');
const response = await fetch(capability.upload.url, {
  method: capability.upload.method,
  headers: capability.upload.headers,
  body: bytes,
});
if (response.status !== 204) throw new Error('Upload failed');
```

A successful PUT returns 204. The service checks the byte limit and SHA-256 while streaming, then saves staging bytes. The business cannot use the file yet. A wrong digest returns 400 and does not publish a file. Send correct bytes again to recover. An expired URL returns 410. Start a new upload.

## Validate the same immutable bytes and publish

The complete minimal adapter is [attach-file.ts](../examples/attach-file.ts). It accepts the real business validator, publication callback and logical reference. It creates no simulated Lab table or new JSON route.

<<< ../examples/attach-file.ts

`validate(candidate)` runs after digest, declared size and generic format checks. `candidate.read()` reads the same verified immutable bytes that were just adopted. Validation holds the hash's file lock, outside a database transaction. Stream the content and apply the business budget. Throw `PublicFailure` to retain its status and code. Unknown errors return 503. Validators must avoid database writes and irreversible side effects.

`publish(tx, file, transitioned)` runs in the final database transaction. Write business records and audit here. The example then calls `pin` in the same `tx`, linking the file to `ownerType` and `ownerId`. Core commits ready state, candidate and `files.complete` audit together. Callback or audit failure rolls them back. Adopted physical bytes can remain for later cleanup.

Retrying a ready file still verifies actual bytes and runs the callback. `transitioned: false` means this call did not change pending to ready. The business must handle its own replay and avoid duplicate business results. Core records completion audit only for an actual state transition.

The final transaction rechecks the exact original session or key and its eligibility. Logout, revocation, expiry or creator deactivation during I/O prevent publication with that actor. Obtain a fresh valid credential and use the business recovery path. An old actor does not become a new authorization.

## Download, release and clean up

After authorization, call `service.download(tx, actor, fileId)` inside a `DbSession`. `DownloadCapability` contains a GET URL, headers, deadline and file metadata. GET 200 returns the original bytes. HEAD with the same GET capability returns 403. Request a fresh download capability after expiry. A signed URL permits its holder to read bytes until expiry. Credential revocation denies later publication and new capabilities. It does not automatically revoke previously issued URLs.

When deleting or replacing a reference, call `service.release(tx, fileId, reference)` in the same transaction. Call `dispose` to delete a logical file explicitly. Existing pins or real foreign-key consumers return 409. Remove the business references you own, then retry. One hash can belong to several logical files. Releasing one does not delete another file's bytes.

The Core file scheduler retries deleting intents, expired staging and orphan objects. Cleanup processes at most 50 logical files per call. Rescan processes 100 directory entries and advances a cursor. Directory discovery still reads and sorts every name. This does not guarantee constant latency. Unknown name formats, active files, pins and actual foreign-key references remain.

Bytes and staging live in `LAB_WORD_DATA_DIR/blobs`. The stable signing key lives in `secrets/file-signing-key`. Initialization writes and syncs a temporary key, then publishes it with a no-overwrite link. Ordinary failure removes that temporary file. Force-kill can leave a private temporary file. Startup preserves an existing valid key. An unknown short key refuses startup and is never overwritten automatically. Previously issued signatures survive a same-directory process restart until their original deadline. This is not a power-loss durability guarantee.

## Verify refusal and recovery

Run from the repository root:

```bash
pnpm typecheck
node --test --experimental-strip-types tests/server/core-files.test.ts tests/server/core-file-authority.test.ts
```

Typechecking includes the teaching adapter. Real capability tests use HTTP byte routes and an embedded database. They check size, format, digest, immutable validation, revocation, callback/audit rollback, GC/adoption concurrency, signatures and recovery. Tests remove their owned temporary directories after completion. They do not open `data/`. Later Lab assertions own actual GLB validation. See the [assertion map](../testing/vnext-core-assertions.md).

Use the generated [configuration](site:reference/config.md) and [API](site:reference/api.md) as facts. Core [FileService](../../packages/server/src/core/files/use-cases.ts) owns logical lifecycle. [Platform BlobStore](../../packages/server/src/platform/blob-store.ts) owns streamed physical I/O. Application owns the business validator, references and transaction callback.

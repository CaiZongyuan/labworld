# Back Up Offline and Restore to a New Directory

Goal: back up current Node data and restore it to a separate directory. Complete [Node operational records](server-traceability.en.md) first. Prepare a published asset and acknowledged business records. Use the pinned Node 24 and pnpm. Run these Bash commands from the repository root. They write the selected archive and restore directories.

## Create an Offline Archive

Stop the service using the source directory. Press Ctrl+C in the terminal running `pnpm dev`. Wait for the process to exit.

```bash
export LAB_WORD_DATA_DIR=data
pnpm server backup --output .scratch/archives/lab-backup
```

Success reports `status: backed-up`. The archive is a directory with `manifest.json`, a database snapshot and verified object bytes. The command holds source-directory exclusion. It reads ready references in pages, then streams size and SHA256 checks. Database transactions do not wait for file reads. Backup fails while an active service owns the source.

The archive positively includes the database and ready objects. It excludes the raw `secrets/file-signing-key`, upload staging, logs and environment files. Password, session and API-key hashes remain persisted identity data inside the database.

## Restore and Read Back

Choose a new or empty directory. Use a destination separate from the original service directory.

```bash
export LAB_WORD_DATA_DIR=.scratch/restored-lab
pnpm server restore --archive .scratch/archives/lab-backup
pnpm dev
```

Success reports `status: restored`. Restore checks format, paths and every file, then verifies actual database history and ready references in owned staging. It acquires destination exclusion and publishes only after validation. Nonempty destinations, wrong content and unsupported history fail. Correct the input or select a new directory, then retry.

Log in with the original account. Open its Lab and download the asset. Identity and bytes remain the same. Retry an acknowledged Command with its original key and parameters to receive the original result. Startup interrupts old Runs. It does not replay Commands or resume long Tasks. A fresh signer issues new byte URLs.

The current format supports only this implementation's verified Node migration history and database format. Later baseline compression must provide verified compatibility or refuse old history before target mutation. Preserve earlier Node directories and archives. This command does not convert or delete old Rust/PostgreSQL data.

Owners: [CLI composition](../../apps/server/src/operations.ts), [database history and opening](../../packages/server/src/platform/db/index.ts), [closed database snapshot](../../packages/server/src/platform/db/snapshot.ts), and [Files ready references](../../packages/server/src/core/files/archive.ts). The unified entrypoint currently provides backup and restore. Migration and password-reset composition continues in this operations implementation.

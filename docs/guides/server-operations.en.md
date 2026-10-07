# Back Up Offline and Restore to a New Directory

Goal: back up current Node data and restore it to a separate directory. Complete [Node operational records](server-traceability.en.md) first. Prepare a published asset and acknowledged business records. Use the pinned Node 24 and pnpm. Run these Bash commands from the repository root. They write the selected archive and restore directories.

## Create an Offline Archive

Stop the service using the source directory. Press Ctrl+C in the terminal running `pnpm dev`. Wait for the process to exit.

```bash
export LAB_WORD_DATA_DIR=data
pnpm server backup --output .scratch/archives/lab-backup
```

Success reports `status: backed-up`. The archive is a directory with `manifest.json`, a database snapshot and verified object bytes. The command holds source-directory exclusion. It reads ready references in pages, then streams size and SHA256 checks. Database transactions do not wait for file reads. Backup fails while an active service owns the source.

Output can be new or an existing empty directory. The safe `dataDir/backups` folder is allowed. Output and temporary archives cannot overlap the copied `pgdata` tree. Aliases resolve to real locations to prevent recursive copying. Publication removes only a confirmed empty output directory. It never recursively removes existing content.

The archive positively includes the database and ready objects. It excludes the raw `secrets/file-signing-key`, upload staging, logs and environment files. Password, session and API-key hashes remain persisted identity data inside the database.

## Restore and Read Back

Choose a new or empty directory. Use a destination separate from the original service directory.

```bash
export LAB_WORD_DATA_DIR=.scratch/restored-lab
pnpm server restore --archive .scratch/archives/lab-backup
pnpm dev
```

Success reports `status: restored`. Restore rejects linked directories at each archive path component. It checks format, paths and every file, then verifies the size and SHA256 of the actual staged copies. It checks database history and ready references in owned staging. It acquires destination exclusion and publishes only after validation. Nonempty destinations, wrong content and unsupported history fail. Correct the input or select a new directory, then retry.

Log in with the original account. Open its Lab and download the asset. Identity and bytes remain the same. Retry an acknowledged Command with its original key and parameters to receive the original result. Startup interrupts old Runs. It does not replay Commands or resume long Tasks. A fresh signer issues new byte URLs.

The current format supports only this implementation's verified Node migration history and database format. Later baseline compression must provide verified compatibility or refuse old history before target mutation. Preserve earlier Node directories and archives. This command does not convert or delete old Rust/PostgreSQL data.

## Migrate and Recover a Password

The same entrypoint provides serve, migrate and reset-password. `pnpm server` starts the service by default. Stop the service, then run:

```bash
pnpm server migrate
read -rs recovery_password
printf '%s\n' "$recovery_password" | pnpm server reset-password --email member@example.test
unset recovery_password
```

Migration reports the verified schema version. It does not start devices or maintenance loops. Password recovery reads standard input and excludes the password from output. It preserves user identity, revokes old sessions and records a system audit. Restart the service and log in with the new password. The original `pnpm reset-password --email ...` entrypoint remains available.

Owners: [unified CLI](../../apps/server/src/cli.ts), [archive composition](../../apps/server/src/operations.ts), [shared password operation](../../apps/server/src/password-operation.ts), [database history and opening](../../packages/server/src/platform/db/index.ts), [closed database snapshot](../../packages/server/src/platform/db/snapshot.ts), and [Files ready references](../../packages/server/src/core/files/archive.ts).

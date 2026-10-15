# Environment and tracker maintenance

The task owner cleans up its temporary resources. The coordinating PM owns the weekly repository and tracker maintenance pass. On session recovery, inspect the latest maintenance record; perform the weekly pass if it is more than seven days old. A long-running task performs the same pass every seven days. These are agent lifecycle duties, not an installed background deletion job.

## Cadence

| When                                     | Required action                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Task completion, cancellation or handoff | Stop owned processes, reconcile resources, retain the recovery checkpoint and release redundant worktrees and generated output        |
| Session recovery                         | Reconcile interrupted cleanup with actual Git, processes and resource ledgers                                                         |
| Weekly                                   | Inventory disk, worktrees, scratch, package caches and every open issue/PR; reclaim eligible resources and update stale tracker state |
| Epic completion                          | Finish the weekly pass, archive useful evidence and accepted previews, and reconcile the spec with actual child delivery              |

## Inventory and select

1. Record the main revision, `git worktree list --porcelain`, complete status of each worktree including staged and untracked files, directory sizes and filesystem free space. Read the current open issues, PR heads, CI results and blockers from `CaiZongyuan/labworld`.
2. Check running processes, their working directories and open files, and the run ledgers. A clean Git status, an old timestamp or an exited container alone does not establish that a resource is disposable. Persistent development data, external projects and active services retain their existing owners.
3. Write an explicit removal list with each path/resource, owner, reason, consumers and recovery location. Keep worktrees needed by current delivery. Consolidate redundant diagnostics into a source archive and a small checkpoint.

Measure each root separately when reporting sizes: hard links shared between package stores, installations and worktrees make a combined `du` result order-dependent. Record cache-prune output and filesystem free space as well; logical bytes removed need not equal physical bytes reclaimed.

## Preserve and reclaim

- **Worktrees:** pin every removed head with a Git reference and verify a source bundle. Save working-tree and index patches plus untracked source before removing a dirty worktree. Preserve required ignored evidence separately. Verify the archives, then recheck the head, complete status and consumers immediately before `git worktree remove`. Use `--force` only for the exact archived candidate. Keep source branches until their delivery or archive disposition is settled.
- **Scratch:** retain current checkpoints, unpublished designs, accepted previews and evidence needed by open work. Archive superseded runs before deleting their original directories. Keep small durable conclusions in `docs/internal/`; recovery instructions identify the source revision, archive and checksum. Avoid creating a full source checkout for each probe when a shared immutable revision and a small patch suffice.
- **Package caches:** use the owning tool's cleanup interface after checking package-manager consumers. Use `uv cache prune` for ordinary maintenance; `uv cache prune --ci` can additionally reclaim downloaded wheels and unpacked packages when installed environments and rebuildable dependencies are understood. Use `pnpm store prune` for its selected store. Preserve managed Python installations, installed virtual environments, browser binaries required by active work, credentials and persistent application data. Do not manually delete package-store internals or use forced cache removal.
- **Docker, when a task uses it:** inventory the daemon and record owned temporary resources and their consumers. Reconcile after interruption and completion; stop consumers before removing the explicit owned resource list. Preserve shared services, persistent data and other projects' resources. Use no global prune. Ordinary Node work does not require a Docker inventory.

Write the archive manifest before removal and update it after each completed action. On interruption, resume from that manifest and recheck consumers and status. Keep the last verified recovery copy until the source is delivered or explicitly retired; backup age alone does not authorize its removal. At each weekly pass, review older archives so backups do not become a second unbounded scratch directory.

## Reconcile GitHub

Follow [issue-tracker.md](issue-tracker.md) and the five state roles in [triage-labels.md](triage-labels.md).

- A spec is a reference rather than an implementation assignment. Remove `ready-for-agent` from specs; use `type:spec` and `type:task` to distinguish document and implementation issues without introducing new triage states.
- Keep one delivery PR for each scope. Before closing a duplicate, verify its complete head is retained by the replacement or a recoverable archive. State the replacement and closure reason on the PR, close it without merging, and leave its unintegrated implementation issues open.
- Close superseded requests with a replacement link. Close administrative handoffs after ownership and recovery information have a current home. Preserve valid unfinished requirements and dependencies; cleanup does not mark them delivered.
- Close an implementation issue only after actual integration and agreed acceptance. Inspect a spec's full scope before closing it: closed migration children do not establish completion of a separate product-restoration gate.
- Reconcile stale owners, blockers and PR descriptions against current state. For each remaining open item, record its role, current delivery path or backlog dependency, and next action. Use the tracker for current work and link historical logs from the maintenance record.

## Verify and record

Read back worktree registrations, source references, archive integrity, remaining processes, directory sizes and filesystem free space. Re-read changed issue/PR states and labels from GitHub. Record any retained resources with owner and purpose, including unavailable or uncertain evidence. Run only checks affected by a maintenance policy change; resource reclamation does not require repeating unrelated product suites.

Use one dated record in `docs/internal/` for the outcome and recovery map. Link it from the active checkpoint. Maintenance is complete when every selected action is reconciled with actual state and every retained item has a disposition.

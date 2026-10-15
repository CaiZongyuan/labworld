# Git workspace archive — 2026-10-15

This tag preserves retired branch tips and the staged/source state before workspace cleanup. It is a recovery anchor, not a product merge. Its parents keep the recorded commit tips reachable; its tree contains this recovery map. Historical local-only raw-tree handoffs remain local and are included in the local repository bundle.

The active work is on `chore/development-baseline`. `main` was not advanced by cleanup. Existing immutable tags, including `legacy-rust-final`, remain intact.

## Recover a retired branch

1. Fetch `archive/2026-10-15/git-workspace` from origin.
2. Read `refs.json` at this tag and choose the recorded branch name and SHA.
3. Create a new branch or worktree at that SHA, for example `git switch -c recovered/name <sha>` in a clean checkout.

## Recover the original uncommitted state

`workspace.json` records the original main, staged-tree commit and final source tree. In a separate clean checkout at the recorded base, apply `staged.patch` with `git apply --index`, then apply `unstaged.patch` with `git apply`. Extract `untracked.tar.gz` into that recovery checkout. The organized baseline branch already contains the final contents in three commits.

Local records and a verified complete bundle are retained under `backups/maintenance-2026-10-15/git-workspace/`. Ignored application data, credentials, caches and other maintenance backups were not committed or deleted.

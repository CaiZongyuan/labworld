# Environment and tracker maintenance — 2026-10-15

User authorization: clean the growing development environment and the current open issues/PRs; add regular maintenance. Baseline: `main@9e0f1040608f5c40d7e7b33f9c0b099b32ed88b5`. This record is a maintenance snapshot; GitHub remains the current tracker.

## Result

- Registered worktrees: **76 → 3** (main and two unfinished delivery candidates). Removed 73 redundant worktrees after preserving heads, dirty changes and required evidence.
- Approximate `du` inventory: `.worktrees` **9.6 GiB → 928 MiB**, `.scratch` **3.8 GiB → 941 MiB**. The verified recovery backup occupies **1.7 GiB** separately.
- `uv cache prune --ci` completed: 261,318 files / **20.9 GiB** reported removed; cache now about **412 MiB**. `pnpm store prune` completed: 20,201 files / 952 packages / **6.03 GB** reported removed; shared store now about **7.4 GiB**. Logical deletion totals are not physical reclaimed space because of hard links.
- Filesystem `df -h`: used **268G → 245G**, available **688G → 712G**, rounded by the tool. The exact cache-size sampling overlapped cache pruning; it is recorded as an after-cache sample rather than a false before baseline.
- Open PRs: **5 → 2**. Open issues: **27 → 25**, consisting of six reference specs and nineteen unfinished implementation tasks.

## GitHub disposition

- Closed superseded Draft PRs [#99](https://github.com/CaiZongyuan/labworld/pull/99), [#100](https://github.com/CaiZongyuan/labworld/pull/100), [#101](https://github.com/CaiZongyuan/labworld/pull/101) without merging or deleting branches. Each full head is an ancestor of #102 at `bbbc9ab5817ac5ff8029e05a4e7139ddf9377114`; closure comments identify the replacement.
- Retained [#102](https://github.com/CaiZongyuan/labworld/pull/102) as the single #87–#89 foundation delivery and [#65](https://github.com/CaiZongyuan/labworld/pull/65) for #31 spatial work. Both remain Draft and unfinished. Updated descriptions make the delivery boundary explicit; #65 needs its baseline refreshed after actual #102 integration.
- Closed [#85](https://github.com/CaiZongyuan/labworld/issues/85) as superseded by #86 and #87–#98; the original product goal remains pending there. Closed [#67](https://github.com/CaiZongyuan/labworld/issues/67) as a completed historical administrative handoff; its unfinished product work remains in the implementation issues.
- Added `type:spec` / `type:task`, preserving the five triage state roles. Removed `ready-for-agent` from reference specs. Re-read all open item states and labels, and verified native blocker links for all nineteen remaining implementation tasks against their published bodies.
- #45 remains open: closed migration tickets #46–#52 do not complete its separate Product Completion Gate. #24 remains a reference pending full integrated acceptance rather than being closed merely because its main feature tickets are integrated.

| Open issue                                               | Role and next action                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [#23](https://github.com/CaiZongyuan/labworld/issues/23) | Reference: spatial/product acceptance remains in #31 and #40.                                                            |
| [#24](https://github.com/CaiZongyuan/labworld/issues/24) | Reference: retain integrated workspace requirements until milestone acceptance is reconciled.                            |
| [#25](https://github.com/CaiZongyuan/labworld/issues/25) | Reference: creation/onboarding work remains in #34–#39.                                                                  |
| [#31](https://github.com/CaiZongyuan/labworld/issues/31) | Active delivery: PR #65; preserve accepted rendering scope, refresh foundation baseline and finish required CI.          |
| [#34](https://github.com/CaiZongyuan/labworld/issues/34) | Backlog: blocked by #31. Preserve scope and start only after real blockers close.                                        |
| [#35](https://github.com/CaiZongyuan/labworld/issues/35) | Backlog: blocked by #34. Preserve scope and start only after real blockers close.                                        |
| [#38](https://github.com/CaiZongyuan/labworld/issues/38) | Backlog: blocked by #35. Preserve scope and start only after real blockers close.                                        |
| [#39](https://github.com/CaiZongyuan/labworld/issues/39) | Backlog: blocked by #38. Preserve scope and start only after real blockers close.                                        |
| [#40](https://github.com/CaiZongyuan/labworld/issues/40) | Backlog: blocked by #39. Preserve scope and start only after real blockers close.                                        |
| [#45](https://github.com/CaiZongyuan/labworld/issues/45) | Reference: migration is integrated; product-restoration gate still depends on the unfinished product tickets.            |
| [#69](https://github.com/CaiZongyuan/labworld/issues/69) | Reference: deferred remote/WAN/soak and complete control acceptance remains in #76.                                      |
| [#76](https://github.com/CaiZongyuan/labworld/issues/76) | Deferred backlog: remote host/WAN readiness and full native acceptance remain outstanding; no infrastructure re-request. |
| [#86](https://github.com/CaiZongyuan/labworld/issues/86) | Reference: source scope remains in #87–#98.                                                                              |
| [#87](https://github.com/CaiZongyuan/labworld/issues/87) | Active delivery: PR #102; repair actual failing checks and integrate before closing.                                     |
| [#88](https://github.com/CaiZongyuan/labworld/issues/88) | Active delivery: PR #102; repair actual failing checks and integrate before closing.                                     |
| [#89](https://github.com/CaiZongyuan/labworld/issues/89) | Active delivery: PR #102; repair actual failing checks and integrate before closing.                                     |
| [#90](https://github.com/CaiZongyuan/labworld/issues/90) | Backlog: blocked by #87, #88. Preserve scope and start only after real blockers close.                                   |
| [#91](https://github.com/CaiZongyuan/labworld/issues/91) | Backlog: blocked by #90. Preserve scope and start only after real blockers close.                                        |
| [#92](https://github.com/CaiZongyuan/labworld/issues/92) | Backlog: blocked by #91. Preserve scope and start only after real blockers close.                                        |
| [#93](https://github.com/CaiZongyuan/labworld/issues/93) | Backlog: blocked by #91, #92. Preserve scope and start only after real blockers close.                                   |
| [#94](https://github.com/CaiZongyuan/labworld/issues/94) | Backlog: blocked by #92. Preserve scope and start only after real blockers close.                                        |
| [#95](https://github.com/CaiZongyuan/labworld/issues/95) | Backlog: blocked by #89, #94. Preserve scope and start only after real blockers close.                                   |
| [#96](https://github.com/CaiZongyuan/labworld/issues/96) | Backlog: blocked by #92. Preserve scope and start only after real blockers close.                                        |
| [#97](https://github.com/CaiZongyuan/labworld/issues/97) | Backlog: blocked by #89, #93, #95, #96. Preserve scope and start only after real blockers close.                         |
| [#98](https://github.com/CaiZongyuan/labworld/issues/98) | Backlog: blocked by #97. Preserve scope and start only after real blockers close.                                        |

## Retained resources and recovery

| Resource                                                                                                   | Owner and purpose                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main working tree                                                                                          | User workspace; all pre-existing staged changes, terminology edits and unpublished ADR/plans remain intact                                                                                                                        |
| `.worktrees/102-browser-failure-facts`                                                                     | #87–#89 delivery / #102, exact head `bbbc9ab5817ac5ff8029e05a4e7139ddf9377114`                                                                                                                                                    |
| `.worktrees/65-offline-canvas-geometry`                                                                    | #31 delivery / #65, exact head `1054619df9baec211c98897a825651e418a5f014`; retains its installed dependencies                                                                                                                     |
| `.scratch/improve-harness`                                                                                 | User workflow proposal; maintenance additions and both regenerated patch forms are retained; remaining proposal is not applied                                                                                                    |
| Remaining scratch previews and `newton-source-v1` / `use-newton`                                           | Accepted previews, unpublished design and current native evidence retained for the user and the two delivery scopes                                                                                                               |
| `.scratch/maintenance-2026-10-15`                                                                          | This maintenance run: inventories, action/closure bodies, GitHub readbacks and cleanup recovery script                                                                                                                            |
| `backups/maintenance-2026-10-15`                                                                           | Maintenance owner: Codex; recovery bundle, uncommitted patches, evidence archives and checksums. Review weekly; preserve the last verified source copy until delivered or explicitly retired                                      |
| Shared pnpm store                                                                                          | User package tooling across projects; retained referenced v11 packages and legacy v10 store (consumer ownership of v10 not established)                                                                                           |
| Playwright/Electron and other project caches                                                               | User tooling; no blanket deletion of installed browser/runtime environments                                                                                                                                                       |
| Docker: `clinmesh-synthea-provider-1`, `clinmesh-cn-health-localizer-1`, two images and `clinmesh_default` | Another project (`/home/caii/backend/clinmesh`); unchanged. No volumes or build cache. Final Docker reconciliation confirms 2 images / 1.019 GB, 2 stopped foreign containers, 0 volumes, 4 networks and 0 build cache; unchanged |

The source bundle and every archived head are listed in `backups/maintenance-2026-10-15/manifest.json`; SHA-256 checksums accompany the evidence archives. `uncommitted/<worktree>/working-tree.patch` records the complete tracked delta from HEAD, `index.patch` records staged changes, and `untracked.tar.gz` contains any untracked source. Installed dependency symlinks are rebuildable and excluded from untracked-source archives.

For recovery, first inspect the manifest. Restore a chosen head with `git worktree add --detach <new-recovery-path> refs/archive/maintenance-2026-10-15/<worktree-name>`. If the archive refs are unavailable, fetch them from `backups/maintenance-2026-10-15/source.bundle`. Apply the working-tree patch, restore the index patch with `git apply --cached`, then extract the untracked archive into that recovery worktree. Extract evidence archives into an empty separate directory; their member paths retain the original `.worktrees/` and `.scratch/` locations.

Cleanup recovered once from an owned read-only snapshot directory. The recovery verified the Motion archive checksum and removed only that explicit archived tree after adding owner write permission to its directories. It did not change hard-linked file permissions. GitHub PR-body editing recovered through REST after the installed gh GraphQL path failed on retired Projects Classic fields. Both failures and successful continuations are retained in the run records.

## Policy, validation and limits

- [Environment maintenance policy](../agents/environment-maintenance.md) is linked from root AGENTS.md and the harness drafts. It assigns task cleanup, recovery reconciliation and weekly PM maintenance; no background deletion scheduler was installed.
- Both proposal patch forms include the maintenance addition and were checked against a clean HEAD using an alternate index. The user index was not rewritten. Original proposal patches are preserved in the backup.
- Local simplification: kept one maintenance policy with short entrypoint links; no new cleanup framework, dependencies or duplicate tracker was introduced. No additional simplification was justified.
- Focused formatting, `git diff --check`, `pnpm docs:check` and installed React/TypeScript imports pass. Archive gzip integrity, member readability, source-bundle verification, status rechecks and consumer checks cover the destructive cleanup. Unrelated product suites were not rerun.
- The existing product baseline remains red: main CI 38323821077 failed, and #102 final-head CI 38658377245 failed its second browser shard and aggregate. This maintenance does not establish product acceptance or authorize a failed-check merge. The earlier review findings about the broader lighter-delivery proposal remain separate.
- Independent Standards/Spec maintenance review: **PASS / PASS**, zero required findings. The non-author reviewer independently checked archive refs, the complete source bundle and archive checksums, duplicate-PR ancestry and fresh GitHub item states. Report: `backups/maintenance-2026-10-15/scratch-records/maintenance-2026-10-15/independent-review.md`.

## Follow-up: root scratch cleared

The user requested clearing the remaining root `.scratch`. No process had that tree as its working directory or an open-file consumer. The complete remaining tree was archived before removal, including unpublished designs, accepted previews, current harness proposals and maintenance evidence. The `.scratch` directory is now absent. This follow-up supersedes the earlier retained-scratch entries and sizes above.

- Recovery archive: `backups/maintenance-2026-10-15/scratch-remainder.tar.gz` (442,146,270 bytes).
- SHA-256: `9a19dd34c354680ab63a63aa4ed25686a359714465ceb7873f2b6c2d45316354`.
- Verified archive inventory: 51,473 entries, with unchanged source metadata and no consumers rechecked immediately before removal.
- Browsable harness proposals: `backups/maintenance-2026-10-15/scratch-records/improve-harness/`.
- Browsable previous maintenance records and independent review: `backups/maintenance-2026-10-15/scratch-records/maintenance-2026-10-15/`.
- Completion manifest: `backups/maintenance-2026-10-15/scratch-clearance.json`; the source inventory is stored alongside it.
- Recover into an empty directory with `tar -xzf backups/maintenance-2026-10-15/scratch-remainder.tar.gz -C <empty-recovery-directory>`; archived member paths retain the `.scratch/` prefix. The root directory is recreated only when future work needs new temporary output.

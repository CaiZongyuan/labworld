# Reliable World Synchronization Validation

Scope: [Issue #8](https://github.com/CaiZongyuan/labworld/issues/8), approved [spec #1](https://github.com/CaiZongyuan/labworld/issues/1), ADR 0006–0008 and accepted Foundation preview `10c4c22f875b958c7adc30cf84c7a41d56a4589c`. Base: `240294a75a807367d3bad8fa0b1a14e26ecc1828`; branch `feat/8-reliable-sync`; isolated worktree `.worktrees/8-reliable-sync`.

## Behavior

- A transactional deployment world clock and consistent snapshots cover Entities, Nodes, relationships, Bindings, Runs, observations and referenced assets. Decimal-string versions avoid JavaScript integer precision loss. The clock lock follows authentication locks and precedes business locks. Layout versions and drafts remain independent.
- Public SSE sends a complete initial snapshot followed by property changes with a matching base version. The SDK ignores duplicate/older facts, rejects missing bases and preserves canonical item ordering. Concurrent older HTTP responses cannot overwrite a higher subscription version.
- Event JSON is limited to 1 MiB; each connection queues at most eight events. Overflow discards the queue, sends a priority resync and closes. Unfinished client frames are bounded. This is a latest-state stream, not a historical event feed.
- Credentials are checked periodically and before delivering queued data. Logout, expiry, revocation and inactive membership terminate existing access. Cancellation drops the stream and cancels in-flight polling work.
- Persistent capability constraints agree between World and Entity reads. Immediate service readiness is separate through `X-Lab-Runtime` and `runtime_status`; UI operations require both. HTTP response headers do not overwrite the page's ordered subscription status.
- Ordinary SDK requests retain their short timeout. Generated SSE operations and the Lab helper use a caller-controlled stream lifetime; the Lab helper also detects ten seconds without messages. Navigation, Lab changes and identity changes cancel subscriptions. Render frames remain local to Three.js.

## TDD and Checks

Observed red states: missing subscription returned 404; missing SDK helper; the page lacked live state; a queued initial snapshot leaked after logout; generated SSE inherited an expired ordinary timeout signal. Each corresponding public behavior is now green.

- `node scripts/test-backend.mjs --test lab_sync --test lab_devices --test lab_world`: 8 subscription, 9 device and 8 world tests pass. Explicit heartbeats and observable versions synchronize handoff, queue pressure, credentials and source ordering.
- `node scripts/test-backend.mjs --test lab_sync --test lab_assets`: subscription tests and 15 real-storage asset tests pass, including referenced-asset rename updates.
- `pnpm test:frontend packages/sdk/src/lab-world.test.ts apps/web/src/lab-sync.test.tsx`: 5 pass. MSW replaces only HTTP; assertions cover timeout separation, cancellation, missing bases, payload bounds, duplicate/old facts, delayed HTTP responses, retained observations and reconnect.
- `node --test tests/tooling/sdk-ownership.test.mjs`: the public boundary CLI accepts exact declared Lab SDK files and rejects business contracts in undeclared SDK/Core files.
- `just check`: the final runtime source refresh completed with 64 tooling tests, 206 Rust tests, 270 frontend passes and 4 existing skips; formatting, static checks, generated contracts, boundaries, budgets, web/desktop and bilingual docs builds pass. The same refreshed source also passed the real sync journey. The subsequent review correction changes tutorial/OpenAPI wording and this evidence record only; affected contract/document checks are refreshed before publication, while unchanged behavior checks are reused.

## Real Application

`node scripts/e2e.mjs tests/e2e/lab-sync.spec.ts` passes with two real browser contexts, a Member, an independent Agent, backend lighting and WebGL. It verifies offline retention, online snapshot recovery, identical versions/facts, nonblank canvas pixels, Agent revocation and the runnable tutorial script. Desktop Chinese/light and 320px English/dark screenshots preserve the accepted three-column/stacked workspace with no horizontal overflow or page errors.

`node scripts/e2e.mjs tests/e2e/lab-layout.spec.ts` passes for pointer transforms, independent layout/observation changes, draft conflict recovery, keyboard/numeric controls, manual relations, narrow layouts and its Agent tutorial. A first combined cold run timed out in the second-browser portion; the isolated rerun passed. The initial sync journey also needed an explicit canvas-ready boundary before going offline and screenshot-based pixels for the non-preserved WebGL framebuffer; the corrected public checks pass.

Screenshots are local test artifacts under `test-results/lab-foundation/t07-sync-*.png`; credentials and raw failure bodies are not retained. Browser rendering uses the repository's Chromium setup; no target-hardware performance claim is made. The 100-Entity/20-device capacity journey and full layout-draft/network combination remain Issue #11 responsibilities.

## Simplification and Ownership

The local reduce-complexity pass covers all staged, unstaged and new task files relative to the fixed base. It replaced duplicate JSON message shapes with the actual `WorldEvent` contract, removed numeric collection dispatch, shared authorization checks, used the generated public SSE operation instead of rebuilding request configuration, preserved canonical array order and avoided redundant connection-state updates. Required versioning, backpressure, credentials, cancellation and draft boundaries remain explicit. No optional architecture expansion was added.

Lab ownership declares the migration/table, exact SDK helper, facade integration, contracts, tests and bilingual tutorial. The boundary CLI is still restrictive outside those exact SDK files; removal tooling is not claimed. The paired chapter is `reliable-sync`, with `examples/lab/observe-world.mjs`; earlier lighting/layout chapters and product/boundary docs reflect the delivered behavior.

## Independent Review

Two independent reviewers inspected all 39 changed/new files in tree `f6df83121e9ea182c8cb74ec36042ed84f3645eb` against the fixed base. Spec found no missing, incorrect or out-of-scope behavior. Standards found one documentation overstatement: the 250ms polling target was described as a guaranteed credential-check interval. Both tutorials and the OpenAPI response description now state that checks occur on each polling cycle and before queued-frame delivery, and that source/check timeouts close the stream. No runtime logic changed for this correction.

The simplification pass is refreshed for that documentation-only correction. Both reviewers refresh coverage of the corrected final tree before commit; the immutable tree and final results are recorded in the PR. Integration requires successful CI for the published head and a merged linked PR.

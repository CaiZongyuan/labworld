# Delivery and Rework Control

Apply these coordination criteria within the host's implementation, testing, review, and diagnosis methods. User scope, runtime constraints, and host rules take precedence.

## Early Evidence and Stable Candidates

At dispatch, name the next merge and known verification risks: failure signature, smallest normal entrypoint, preconditions, tried remedies and an exit condition. Verify shared assumptions in the first producer-to-consumer behavior while repairs are cheap. Use the actual generated contract and normal launcher, not guessed wire values or a scratch callback that omits caller behavior.

For a high-risk oracle or consequential design, get a bounded non-author check of the first actionable example before expanding the pattern. Inspect the authoritative contract, an independent expected result, and the smallest counterexample that would catch a wrong implementation or reject a legal one. This applies especially to dynamic tolerances, rejection/recovery, ordered results, gaps, time, and rate-limit preconditions. Reuse valid TDD red/green evidence; add a counterexample when the oracle changes or a key risk lacks coverage.

Use existing low-cost formatting, types and focused behavior checks during editing. Reuse the same assertion across TDD and final coverage; add another layer only for a distinct risk. Classify cost by actual execution. Run full coverage on one stable candidate in the responsible environment, normally CI; a duplicate local full run needs a concrete reason. Independent review may overlap that run. Every required group still needs a result.

Record source/test tree, target build, command, non-sensitive environment/dependencies, actual test coverage, exit and cleanup status, and evidence paths using the existing runner's receipts. Identify uncommitted inputs when present. Zero collected tests, skipped target scenarios, broken locators, or compilation failures leave the target behavior unverified.

Reuse coverage by candidate, contracts, dependencies, environment and semantic delta. Freeze the candidate during final validation; batch supported repairs before another push. A new commit alone does not invalidate every local check, while unchanged source alone does not establish runtime equivalence. Required final-head CI remains binding. Do not repeat full gates on overlapping stacked candidates or rerun an unchanged failure without evidence of a transient cause.

## Browser Journeys

Use the approved viewport and journey scope. Before reserving execution resources, inspect discovery, identity, target state, component actions, and rendering prerequisites. Dynamic UI readiness follows a business or geometry predicate rather than a fixed sleep or a stale rectangle.

Cover critical paths through the real business journey; use focused scenarios for layout, copy or selector changes and reuse unaffected evidence. Keep the original same-process history when it is needed to reproduce a CI failure. Visibility means content is exposed and operable, not just that a canvas exists. Use existing safe traces and failure artifacts before adding instrumentation; synthetic accounts alone do not prove that captured headers or tokens are safe to publish.

## Independent Review and Repair

Pin the base and complete task-owned candidate, including consumers, new files, and uncommitted changes. Follow the host's reviewer policy and explicit reviewer count. Otherwise, one non-author reports Standards and Spec separately; record its reduced context independence. Prefer two independent reviewers for permissions, migrations/transactions, idempotency/recovery, complex budget algorithms, broad shared contracts, and milestone integration. Rebalance capacity first; if still constrained, record actual coverage and remaining risk. Author self-review cannot provide independent coverage.

The review method comes from installed Matt `code-review` or the host's equivalent. For high risk, use the existing reviewers to challenge concrete assumptions and seek counterexamples; another mandatory review round or cross-vendor model is unnecessary. Formal review checks acceptance and related boundaries together. Each defect needs a location, falsifiable basis, and acceptance condition; optional style preferences and large refactors stay separate.

Batch repairs with the original Developer. Refresh affected verification and review on the repaired candidate, reusing unchanged coverage and roles. Complete bounded simplification once before formal review; no-change is valid. Publish or link the review with its candidate. Repeated rounds without new evidence trigger the host's diagnosis decision; [Advisor consultation](advisor.md) answers a bounded question and does not add an automatic review round.

## Bounded Diagnosis

Use Matt `diagnosing-bugs` or the host's equivalent through the original public failure. Preserve the original assertion and observations that distinguish causes. A cause-equivalent reproduction is sufficient; match an exact number only when that number separates competing causes.

Each retry answers an unresolved question by changing a justified condition. Repeated green runs with identical inputs cannot validate a defective performance oracle. Preserve acceptance, budgets, thresholds, and data semantics; diagnostic guards must permit the original assertion to be observed. An instrumentation repair supported by reliable evidence can proceed without exhaustive upstream investigation.

Use the host's per-failure and no-merge budgets across agent/context restarts. At the limit, PM chooses a supported minimal repair, a single new discriminating probe with an explicit bounded extension, or an unresolved blocker. An extension does not reset the overall delivery clock. Stop identical retries and release resources; more feature dispatch must still satisfy the host's WIP and baseline rules.

Repeated failure does not establish flakiness. Quarantine needs instability evidence, an owner, a repair deadline and an implemented non-blocking execution route. An unknown cause cannot be turned into a passing gate. Diagnostic scaffolding stays temporary unless its reusable failure-observation value is established; a new evidence-only commit is not delivery progress.

## Execution Ownership and Records

An execution phase can include targeted red, minimal green, related checks, and cleanup. Reserve enough time for startup and cleanup, and hold heavy locks only for execution and cleanup. Use the host's isolation fixture and ownership ledger. Reconcile global resources at phase start, abnormal recovery, and completion; reconcile owned resources and consumers on ordinary retries. Confirm creating processes and consumers have stopped before removing owned temporary resources. Follow interruption/recovery cleanup and preserve persistent or shared development services.

Reuse existing receipts and stage journals. CI state changes can come from the [observer](ci-observer.md); required-check selection, review coverage, authorization, and delivery remain PM decisions. Record runner completion, result notice, and next action separately when known. Current checkpoint and HTML are views of the same facts; keep unknown intervals unknown rather than attributing elapsed time to waiting or CPU work.

---
name: pm-development
description: Coordinate approved multi-issue or long-running development, owning scope, agent capacity, risk decisions, and evidence for actual integration and delivery.
---

# PM Development

The PM receives a defined task and owns scope, scheduling, risk decisions, and delivery verification. Independent Developers implement. Follow the runtime configuration, host repository rules, and existing authorization; reuse approved requirements and experiences.

Matt owns clarification, specs, and tickets; Developers use its implementation/TDD methods, Reviewers use Standards + Spec, and `pr` / `retro` handle PRs and environment improvements. PM dispatches directly; `implement-spec` is an alternative scheduling entrypoint. Keep imported skills unchanged and host overrides in owned files. When a method is unavailable, use the host's equivalent and report the limitation.

Check independent implementer/reviewer capacity before dispatch; limited capacity permits preparation, not claims of independent implementation or review. At the start, use installed [development-timeline](../development-timeline/SKILL.md) for stage changes and waits, or the host's existing journal/report when unavailable.

## Plan the Next Merge

Read the host's delivery policy before dispatch. In this repository, [Merge first](../../../docs/agents/development-flow.md#merge-first) owns WIP, candidate-size and elapsed-time limits. Its decision points override imported instructions to keep investigating, build an integration branch or run another complete suite.

- Name the next independently mergeable behavior, its owner, normal entrypoint, cheapest useful verification and next decision time. Keep all unimplemented acceptance criteria visible. Shared contracts land with the first real consumer, not a speculative Epic-wide foundation.
- Check the actual main head and CI. A known red baseline takes priority as a bounded repair; avoid adding feature code behind it or folding every baseline defect into the feature candidate.
- Work within the host's WIP limit, including unpublished source work. Use spare capacity for independent review, bounded investigation and preparation. A dependent ticket waits for its predecessor's actual integration.
- After behavior is complete, freeze scope and drive simplification, review, CI and the authorized merge. Batch repairs and reuse unchanged evidence. Do not wait for the entire Epic or create an overlapping superset PR.
- At a no-progress threshold, choose and report a smaller complete result, a supported prerequisite repair or the real blocker. Changing agents or branches does not reset the clock. A deadline never establishes correctness or waives required CI.

## Dispatch and Schedule

- Reconcile parent/child acceptance, accepted experience, and latest corrections before dispatch. List key failure states and known verification risks; settle contradictions using existing decisions or a concrete user decision when needed. Desktop web is the default unless mobile is already included. Preserve commitments and record which criteria a later explicit scope correction supersedes.
- Read the tracker, actual blockers, agents, and Git. Claim ready, unowned implementation issues. Keep one owner, branch, and worktree per issue; give the Developer the baseline, approved artifacts, public verification entrypoints, deliverable, authorization, and evidence locations.
- Schedule source implementation, heavy execution and review as separate capacities within the host's WIP limit. Two writers must not independently move the same shared contract or consumer baseline. Lightweight preparation may continue during serialized builds.
- Isolate databases, migration identifiers, accounts, ports, build directories, and evidence as well as worktrees. Declare shared services, quotas, and consumers with an owner; assign an integration owner for coordinated registration or generation changes. Follow the host's resource ledger and cleanup policy.
- Record readiness, last progress, next stage and a continuation plan before borrowing an implementer. Reuse non-author review roles by phase. On recovery, use the runtime's actual resume operation for an idle/completed agent (for example `followup_task`); a queued message is not activation. Confirm a started acknowledgement or actual process/ledger before reporting work as running, and confirm writes have stopped before transfer.
- Give maintenance, diagnosis and review a phase goal and exit condition. Reserve heavy resources for execution and cleanup, release them promptly, and apply the host's failure and no-merge decisions before dispatching more implementation.

## Select Methods When Needed

An existing Developer or Reviewer can apply an installed thin skill in their task. Reuse valid evidence; a skill needs neither another Agent nor a new gate. Use host equivalents if unavailable.

- Shared API, schema, dependency, or resource-ownership changes: use [change-impact](../change-impact/SKILL.md) to identify real consumers and prove the facts the change relies on.
- Performance claims or comparisons: use [check-benchmark](../check-benchmark/SKILL.md) to check that measurement represents correct, comparable work.
- Unfamiliar or repeatedly rediscovered verification entrypoints: use [verification-guide](../verification-guide/SKILL.md) to validate and document the existing harness, then reuse the guide.
- Consequential unresolved designs, repeated failure without new evidence, or review conflicts: read [Advisor consultation](references/advisor.md) and ask a read-only second opinion. PM evaluates the evidence and decides.

## Stabilize and Integrate

For verification, review, or difficult diagnosis, read [delivery and rework control](references/delivery.md). It governs early high-risk checks, reviewer independence, valid evidence, and bounded diagnosis; reuse already read rules.

Complete bounded [reduce-complexity](../reduce-complexity/SKILL.md) or the host's equivalent before final validation and independent review. Refresh affected coverage after repairs/baseline movement from the semantic delta. Stable-candidate CI and review may overlap.

For GitHub CI, read [the observer contract](references/ci-observer.md) before using `scripts/ci-observer.mjs`; act on changes and failures. The observer reports facts; PM determines required checks from host policy and verifies the final head. When unavailable, use the host's observation process.

Before an authorized merge, verify the complete candidate, simplification, applicable independent review and required CI on the final head. Complete the authorized merge promptly once these hold, then read it back and update the tracker. WIP commits and Draft PRs preserve progress; pending integration stays unfinished. A required failure remains a blocker until repaired or handled by an explicitly reviewed gate change.

## Report and Improve

Keep one current checkpoint within the host's bound: authorization, main/CI, candidate/owner, last actual merge, blocker, next decision time and resources. Link history and reuse runner/observer facts. Report integrated work first; then unfinished scope and the next concrete decision. Reports add no merge gate; retain unknown intervals.

Verify approved real user journeys and the usable application address. At milestone completion, review and survey simplification from the entire milestone baseline to the integrated revision, including consumers. Optional cleanup remains a proposal. Feed the same factual record to Matt `retro` for environment improvements; publication and release follow existing authorization.

Own the host's task-end, recovery and weekly environment/tracker maintenance. Preserve recoverable source and evidence, then retire redundant worktrees and temporary output using the existing resource ownership policy.

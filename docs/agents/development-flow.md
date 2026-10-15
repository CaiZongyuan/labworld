# Engineering flow

Choose the route from the agreed task scope; this project is a multi-session build. Bounded, authorized repository maintenance can continue in the current context without inventing implementation tickets.

Desktop web is the default product and browser-validation scope. Include mobile adaptation, narrow-screen, touch or device testing only when the user or approved task explicitly requires them. Apply the latest explicit user scope change to active work and record its effect on earlier acceptance criteria; this does not authorize rewriting published issues or parent specs.

## Merge first

Schedule around the next independently mergeable behavior. A draft, a local green run or more implemented tickets does not replace actual integration. These rules override imported skill defaults, including unlimited diagnosis, integration branches and repeated local full-suite runs.

| Decision point                                    | Default and required response                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work in progress                                  | One implementation item, including unpublished code and Draft PRs. A second is allowed only to unblock the first, or after the first slice has merged when contracts and consumers are independent. Maximum two; reviewers and read-only preparation do not add implementation items.   |
| Slice size                                        | Aim for 200–500 added non-generated code lines, including tests. Above 1,000, stop expanding and split the observable behavior, or record the inseparable coupling and a bounded completion plan. Generated files and documentation are reported separately.                            |
| Four working hours without a reviewable candidate | PM freezes new scope and selects a smaller complete result, a prerequisite repair, or a concrete blocker. Preserve all remaining acceptance criteria as unfinished work.                                                                                                                |
| Eight working hours without an actual merge       | PM stops dispatching feature work, explains the failed delivery plan, and chooses the next bounded route. Do not reset this clock by opening another ticket, branch or context. If a product decision or unavailable permission is essential, present the concrete options to the user. |
| One failure                                       | At most two working hours or three discriminating attempts, whichever comes first; then apply the diagnosis decision below.                                                                                                                                                             |

Working time here is elapsed time in recorded periods when the task is being pursued, including CI and diagnosis waits. Explicit user pauses and known unavailable execution periods are separate; unknown historical gaps stay unknown. These are intervention thresholds, not delivery guarantees or permission to bypass checks. Record them in the existing checkpoint; no new dashboard is required.

The delivery clock starts when implementation is dispatched. Only an actual merge that advances the named result or removes its prerequisite blocker resets it; an unrelated cosmetic merge does not. Record the last transition and decision time using the existing stage journal.

Before feature dispatch, inspect the actual main head and its required CI. Reuse valid results for that head. A known red baseline becomes the first bounded repair, with one owner and its own candidate; do not accumulate features behind it or absorb unrelated baseline repairs into every feature PR. Unknown baseline status needs one responsible verification route, not duplicate local and hosted full runs.

Land the first slice before scheduling dependent implementation. Shared contracts travel with their first real consumer and a small public example; avoid a standalone framework or the entire Epic's DTO/schema up front. An integration branch is an exception for an evidenced inseparable change, with an owner and exit plan; it is not the default route for feature tickets. Keep a single PR for each candidate, and never create a superset PR while its overlapping originals remain active.

Once the agreed behavior works, stop adding scope. Run bounded simplification, obtain the required independent review and final-head CI, then merge promptly within existing authorization. Review and CI may run concurrently against the same frozen candidate. Waiting for another ticket or an Epic report is not a merge condition.

## Planning and publication

1. Refine requirements with grill-with-docs, recording terminology and meaningful ADRs. For UI, UX and user-visible workflow changes, follow [experience design](experience-design.md) to establish a runnable, accepted experience before implementation. Reuse accepted versions and explicit user corrections, including an instruction to skip another preview.
2. Synthesize the agreed behavior and public testing interfaces into a spec with to-spec. Existing architecture material is an input; avoid repeating the interview just to reformat it.
3. Use to-tickets to produce vertical, independently mergeable slices with only their real blockers and the limits above. For each slice, name its observable result, cheapest useful test seam and what can land before the next ticket. A later slice must not be needed to make the current one usable or green.
4. Show the numbered breakdown, full acceptance criteria and test strategy. Obtain the user's approval of granularity/dependencies before publishing.
5. Publish the spec and approved implementation tickets to GitHub; create and verify native blocking edges. Keep specs as reference issues, and preserve the approved scope when splitting. Spec completion and explicitly authorized scope retirement follow the issue-tracker policy.

The tracker owns current scope and dependencies. Older handoffs, previews and closed specs are reusable evidence, not an active assignment. Check the latest explicit scope before reviving an old branch or its acceptance matrix.

## Per implementation ticket

1. Prefer a fresh implementation context for a new ticket; resume the original writer for repairs. If transferring work, confirm previous writes have stopped. Give the owner the ticket, baseline, relevant decisions, normal entrypoint, first observable result, test seam and the next delivery decision time. Resolve implementation facts directly; use existing authorization without reopening settled approvals.
2. Claim only an implementation ticket whose blockers are complete. Keep unrelated repository/user changes intact.
3. Run implement and tdd at the agreed public interfaces: observe one behavior red, make the minimal end-to-end change green, then take the next behavior. Reuse that red/green evidence for the same VDD assertion as described in [testing strategy](../testing/strategy.md).
4. Run focused checks during development and validate the normal entrypoint early. Update affected bilingual guides, generated references and ownership. Open one linked Draft PR after the first coherent green slice when publication is authorized; batch related repairs before further pushes. Keep diagnostic-only probes out of the delivery branch unless they are a justified reusable harness repair.
5. For consequential design or contract choices, obtain a short independent pre-review while changes are still cheap. Once behavior works, batch compatible actionable findings, apply their bounded repairs, then run [reduce-complexity](../../.agents/skills/reduce-complexity/SKILL.md). Keep larger refactors as proposals; no-change and optional-cleanup deferral are valid outcomes.
6. Pin the complete candidate and obtain independent Standards + Spec review under the policy below. Publish the review on the PR when that communication is authorized; otherwise link the local report. Batch actionable repairs and refresh only affected coverage. Routine repairs do not create another approval stage.
7. On the stable final candidate, complete the coverage matrix in [testing strategy](../testing/strategy.md). Run the full gate once in the responsible environment: local focused checks plus final-head CI `pnpm check` can provide final coverage. If local full validation is needed, record why. A failed check or later semantic change refreshes affected coverage; a changed commit id alone does not require repeating every suite. For visible changes, complete [real-application acceptance](experience-design.md#5-verify-the-real-application) within the agreed viewport and journey scope.
8. Integrate within existing authorization as soon as simplification, independent review and required final-head CI cover the final changes. Read back the merge and tracker state before taking dependent work. Report a blocked merge as unfinished delivery with its exact next decision, rather than starting another implementation to fill the wait.

Deliver tests, usage documentation and ownership with the behavior. Update existing pages or add a short guide for a new entrypoint. Write a new tutorial sequence once at Epic completion, unless a ticket's explicitly approved acceptance requires a chapter earlier.

## Review and integration policy

This project policy overrides imported `implement` and `code-review` defaults without editing those skills:

- **Candidate input:** record the resolved base and candidate commit or complete tree, scoped paths, new files and exact diff command. Include task-owned staged, unstaged and new files. Use a tree comparison when `HEAD` omits uncommitted work; an empty `base...HEAD` diff does not mean that work is absent.
- **Review capacity:** default to one independent non-author reviewer producing separate Standards and Spec passes; this gives up the cross-check between two independent contexts. Prefer two independent axes when capacity permits for permissions, transactions or migrations, idempotency/recovery, complex budget algorithms, broad shared-contract changes or Epic integration. Record a capacity limitation, actual coverage and remaining review risk. An explicit user requirement for two reviewers remains binding. Preserve both reports and author independence rather than enforcing fixed agent or writer counts.
- **Commit and validation:** WIP commits and authorized Draft PRs are allowed before final review. The final stable candidate needs full-gate coverage, which CI may own; each pre-review candidate and small repair need only their affected checks. Simplification, independent final review and required final-head CI remain main-merge conditions. An old-head CI result or local pass does not replace required CI for the final head.
- **New main baseline:** inspect the semantic delta in migrations, routes, generated contracts, ownership, budgets, shared UI and runtime dependencies. Preserve both intents in conflicts and regenerate from the owner. Refresh affected consumers and review coverage; run a full gate only when the remaining impact cannot be bounded or the final candidate still lacks full coverage.

Batch related repairs when they preserve a clear diagnosis and independently observable behavior. Classify setup/oracle failures separately from product defects, and reuse completed checks by their source, contract, environment and coverage inputs. A named documentation or browser command is a coverage route, not a requirement to execute identical checks again when valid evidence already covers it.

## Diagnosis decision

Classify a failure as product, test/oracle, environment, or still unknown. Keep the original acceptance assertion. A focused green that omits the original same-process history only establishes non-reproduction; it does not clear the original failure. Check discovery, actual case counts and relevant setup before another expensive run. Reuse existing safe traces and first-failure facts before adding instrumentation.

At the failure budget, the PM must choose: apply the supported minimal repair; change to one named discriminating probe with new evidence and an explicit limited extension; or record the unresolved blocker and stop that line of work. The extension remains subject to the overall no-merge threshold. A new agent, branch or narrower test name does not reset the original failure budget. Imported instructions to keep trying or to minimise every element do not override this decision.

Two failures alone do not establish flakiness. Quarantine requires evidence that the test or environment is unstable, an owner and a repair deadline, and a real non-blocking execution route. Unknown failures remain blockers. Until a reviewed CI change implements test selection or quarantine, the existing required checks still apply; labels and prose do not switch them off.

Required checks run once on each stable final candidate in the responsible environment. Rerun after a justified repair or demonstrated transient failure, not because an unchanged retry might turn green. Full CI is a validation route, not the default diagnostic probe. Preserve mandatory final-head checks even when focused local evidence is reused.

## Epic completion

Once the Epic's implementation tickets are integrated, run the reduce-complexity Epic survey over the whole Epic and its current consumers. Use the pre-Epic revision and integrated head, or an explicit child-PR inventory; the last child's diff alone is insufficient. Report supported opportunities to reduce duplicated state, APIs, configuration and other maintenance costs.

The survey produces proposals. Required behavior defects affect acceptance; optional cleanup can become follow-up work without reopening completed tickets or blocking an otherwise complete Epic. Assemble the tutorial sequence and verify the integrated journey. Publishing follow-ups, closing the spec or changing scope follows [issue-tracker.md](issue-tracker.md) and existing authorization.

Keep imported skills intact for upstream updates. Repository-specific overrides belong in AGENTS.md, this workflow and repository-owned skills.

## Context and detours

Keep the current design/spec/ticket reasoning together through publication when feasible. Each implementation context is then independent because the ticket is self-contained.

For PM coordination, record lightweight stage starts/ends, waits, role changes and rework using [development-timeline](../../.agents/skills/development-timeline/SKILL.md). Keep one current checkpoint under 30 lines: authorization, main/CI, active candidate and owner, last actual merge, current blocker, next decision time and resources. Link history. Confirm actual agent activation before reporting work as running; resuming a completed agent needs the runtime's activation operation, such as `followup_task`, not merely a queued message. Reports are not merge gates.

Use a prototype only when a design question needs runnable evidence; return the result to the spec before implementation. Use diagnosing-bugs for a difficult regression, research for primary-source reading, and wizard only for a step the agent cannot perform itself.

For diagnosis, accept a cause-equivalent reproduction when it distinguishes the same defect. An exact numeric match is needed only when it separates competing causes. Follow the diagnosis decision above. At task cleanup, recovery and the weekly pass, use [environment maintenance](environment-maintenance.md).

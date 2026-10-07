# Engineering flow

Choose the route from the agreed task scope; this project is a multi-session build. Bounded, authorized repository maintenance can continue in the current context without inventing implementation tickets.

Desktop web is the default product and browser-validation scope. Include mobile adaptation, narrow-screen, touch or device testing only when the user or approved task explicitly requires them. Apply the latest explicit user scope change to active work and record its effect on earlier acceptance criteria; this does not authorize rewriting published issues or parent specs.

## Planning and publication

1. Refine requirements with grill-with-docs, recording terminology and meaningful ADRs. For UI, UX and user-visible workflow changes, follow [experience design](experience-design.md) to establish a runnable, accepted experience before implementation. Reuse accepted versions and explicit user corrections, including an instruction to skip another preview.
2. Synthesize the agreed behavior and public testing interfaces into a spec with to-spec. Existing architecture material is an input; avoid repeating the interview just to reformat it.
3. Use to-tickets to produce vertical, individually verifiable slices with only their real blockers.
4. Show the numbered breakdown, full acceptance criteria and test strategy. Obtain the user's approval of granularity/dependencies before publishing.
5. Publish the spec and approved implementation tickets to GitHub; create and verify native blocking edges. Leave source/parent issues unchanged thereafter.

The integrated viewer is described in [product architecture](../architecture/lab-word.md). Digital Twin Foundation V1 has an approved experience and published implementation tickets; start with [the development handoff](../handoffs/digital-twin-foundation-v1.md). Its GitHub spec and child tickets own implementation scope and dependencies. Historical template tickets and autonomous-build approvals do not authorize work in Lab Word.

## Per implementation ticket

1. Prefer a fresh implementation context for a new ticket; resume the original writer for repairs. If fresh contexts are unavailable, give an eligible existing developer a bounded handoff after confirming its previous writes have stopped. Provide the ticket, comments, blockers, glossary and relevant ADRs. Do a short design/Spec preflight: align parent and child criteria, accepted experience, latest corrections and public testing interfaces. Resolve implementation facts directly; use existing decisions and authorization without reopening settled approvals.
2. Claim only an implementation ticket whose blockers are complete. Keep unrelated repository/user changes intact.
3. Run implement and tdd at the agreed public interfaces: observe one behavior red, make the minimal end-to-end change green, then take the next behavior. Reuse that red/green evidence for the same VDD assertion as described in [testing strategy](../testing/strategy.md).
4. Run focused checks during development. Update the business, paired online guide or tutorial, generated references and ownership with the feature. WIP commits on the feature branch may preserve each slice; when publication is authorized, push and open a linked Draft PR with the actual verified and pending scope. Commit or Draft PR existence does not mean completion or authorize merge.
5. For consequential design or contract choices, obtain a short independent pre-review while changes are still cheap. Once behavior works, batch compatible actionable findings, apply their bounded repairs, then run [reduce-complexity](../../.agents/skills/reduce-complexity/SKILL.md). Keep larger refactors as proposals; no-change and optional-cleanup deferral are valid outcomes.
6. Pin the complete candidate and obtain independent Standards + Spec review under the policy below. Refresh affected review coverage after repairs; reuse unchanged coverage. Findings that require a product decision follow existing authorization; routine repairs do not create another approval stage.
7. On the stable final candidate, complete the coverage matrix in [testing strategy](../testing/strategy.md). Run the full gate once in the responsible environment: local focused checks plus final-head CI `pnpm check` can provide final coverage. If local full validation is needed, record why. A failed check or later semantic change refreshes affected coverage; a changed commit id alone does not require repeating every suite. For visible changes, complete [real-application acceptance](experience-design.md#5-verify-the-real-application) within the agreed viewport and journey scope.
8. Publish reviewed changes within existing authorization, with behavior, evidence and limits. Before main merge, require final changes to be covered by simplification, independent review and required final-head CI. Verify actual merge and tracker state. Reuse completed passes while their inputs remain valid; continue further tickets only within the user's actual Lab Word authorization.

Deliver tests, documentation and ownership with the behavior. The release ticket checks that already-delivered chapters form a coherent learning path.

## Review and integration policy

This project policy overrides imported `implement` and `code-review` defaults without editing those skills:

- **Candidate input:** record the resolved base and candidate commit or complete tree, scoped paths, new files and exact diff command. Include task-owned staged, unstaged and new files. Use a tree comparison when `HEAD` omits uncommitted work; an empty `base...HEAD` diff does not mean that work is absent.
- **Review capacity:** default to one independent non-author reviewer producing separate Standards and Spec passes; this gives up the cross-check between two independent contexts. Prefer two independent axes when capacity permits for permissions, transactions or migrations, idempotency/recovery, complex budget algorithms, broad shared-contract changes or Epic integration. Record a capacity limitation, actual coverage and remaining review risk. An explicit user requirement for two reviewers remains binding. Preserve both reports and author independence rather than enforcing fixed agent or writer counts.
- **Commit and validation:** WIP commits and authorized Draft PRs are allowed before final review. The final stable candidate needs full-gate coverage, which CI may own; each pre-review candidate and small repair need only their affected checks. Simplification, independent final review and required final-head CI remain main-merge conditions. An old-head CI result or local pass does not replace required CI for the final head.
- **New main baseline:** inspect the semantic delta in migrations, routes, generated contracts, ownership, budgets, shared UI and runtime dependencies. Preserve both intents in conflicts and regenerate from the owner. Refresh affected consumers and review coverage; run a full gate only when the remaining impact cannot be bounded or the final candidate still lacks full coverage.

Batch related repairs when they preserve a clear diagnosis and independently observable behavior. Classify setup/oracle failures separately from product defects, and reuse completed checks by their source, contract, environment and coverage inputs. A named documentation or browser command is a coverage route, not a requirement to execute identical checks again when valid evidence already covers it.

## Epic completion

Once the Epic's implementation tickets are integrated, run the reduce-complexity Epic survey over the whole Epic and its current consumers. Use the pre-Epic revision and integrated head, or an explicit child-PR inventory; the last child's diff alone is insufficient. Report supported opportunities to reduce duplicated state, APIs, configuration and other maintenance costs.

The survey produces proposals. Required behavior defects affect acceptance; optional cleanup can become follow-up work without reopening completed tickets or blocking an otherwise complete Epic. Implement accepted proposals as bounded changes through the same validation and code-review flow. Publishing follow-ups or changing parent/spec state still follows [issue-tracker.md](issue-tracker.md) and existing authorization.

Keep imported skills intact for upstream updates. Repository-specific overrides belong in AGENTS.md, this workflow and repository-owned skills.

## Context and detours

Keep the current design/spec/ticket reasoning together through publication when feasible. Each implementation context is then independent because the ticket is self-contained.

For PM coordination, record lightweight stage starts/ends, waits, role changes and rework using [development-timeline](../../.agents/skills/development-timeline/SKILL.md). Keep the current checkpoint small and link event history and evidence. Record actual intervals and unknowns rather than reconstructing every action; a timeline report is for scheduling and diagnosis, not a new merge condition.

Use a prototype only when a design question needs runnable evidence; return the result to the spec before implementation. Use diagnosing-bugs for a difficult regression, research for primary-source reading, and wizard only for a step the agent cannot perform itself.

For diagnosis, accept a cause-equivalent reproduction when the public failure and evidence distinguish the same defect; preserve the original assertion and thresholds. An exact numeric match is needed only when it distinguishes competing causes. Set a diagnostic timebox and evidence-based stop condition: at the limit, change the probe, consult an Advisor or report the remaining blocker and release idle capacity. A timebox never turns a failure into a pass or permits skipping a required assertion.

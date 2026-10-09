---
name: reduce-complexity
description: Simplify completed issue or PR changes while preserving behavior, before final validation and code-review. At Epic completion, survey the integrated work for evidence-backed reductions in maintenance cost.
---

# Reduce Complexity

This repository-owned step complements the existing implementation and code-review skills. The [development flow](../../../docs/agents/development-flow.md) owns when to run it; keep imported skills unchanged.

## Choose the scope

- **Issue/PR completion:** follow [local simplification](references/local-simplification.md). Apply small, behavior-preserving improvements within the authorized implementation, then return to final validation and the existing Standards + Spec code-review.
- **Epic completion:** follow [the Epic survey](references/epic-simplification.md). Inspect integrated consumers and report supported proposals. Implement only candidates already covered by the user's authorization.

Infer the scope from the active ticket or Epic; no mode argument is required. An explicit review-only request remains read-only. A survey does not authorize issue publication, merging or changes to parent/spec state; follow the [issue-tracker rules](../../../docs/agents/issue-tracker.md) and existing authorization for those actions.

## Establish the evidence

Read applicable AGENTS.md instructions, the ticket/spec or agreed request, and [the testing strategy](../../../docs/testing/strategy.md). Read CONTEXT.md and relevant ADRs before judging domain or architecture choices.

Use the task's fixed starting point or verified PR merge base, recording the resolved revision and scoped paths. Inspect `git status --short`, `git diff <base-sha> -- <task-paths>` and `git ls-files --others --exclude-standard` so committed, staged, unstaged and task-owned new files are considered. Read relevant new files explicitly. Preserve unrelated files and hunks. Resolve a missing base from the task or PR context; ask only if the intended scope remains ambiguous.

For an Epic, use the entire integrated range or child-PR inventory described in the Epic reference. Zero search matches alone do not establish that a public or dynamically registered capability is unused.

## Return to the existing flow

Report the inspected scope, meaningful simplifications or proposals, retained obligations and evidence gaps. No-change is a valid result; there is no deletion quota. Return to the development flow for affected checks and code-review after any edits. Optional cleanup does not block delivery by itself.

Record the inspected revision and any uncommitted scope. Reuse the pass before merge if its inputs remain unchanged; inspect new changes and refresh affected tests/review if fixes or integration changed the result. Do not repeat cleanup merely because a commit or push follows.

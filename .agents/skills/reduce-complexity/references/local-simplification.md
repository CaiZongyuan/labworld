# Local simplification before review

Read for issue/PR completion. Adapted from Anthropic's [code-simplifier](https://github.com/anthropics/claude-plugins-official/blob/ceb9b72b4c4c20ad39efce780edd0aabe80ebce3/plugins/code-simplifier/agents/code-simplifier.md): preserve behavior, focus on recently modified code, and prefer clarity over brevity. Use this repository's Rust/TypeScript conventions; the upstream agent's JavaScript style rules and model selection are not repository requirements.

## Bound the edit

Start from the task's acceptance criteria and working behavior. Inspect its changed code plus the immediate callers needed to understand it. Apply improvements within the same ticket; discoveries elsewhere become follow-up proposals.

- Flatten unnecessary nesting and make names, conditions and error paths explicit.
- Remove redundant intermediate state, duplicate logic or pass-through abstractions when their consumers demonstrate no distinct responsibility.
- Keep useful domain boundaries and ownership visible. Similar-looking code with different reasons to change need not share an abstraction.
- Remove comments that merely narrate code while retaining non-obvious behavior, failure, ordering and ownership facts. Update the owning source before regenerating derived artifacts.

The result should be easier to understand or maintain. A line-count reduction, generic helper or new dependency alone does not establish an improvement. Preserve existing features, outputs, public types, errors, authorization, persistence, transaction behavior and relevant timing/resource guarantees. A capability reduction is a proposal, even if it deletes substantial machinery.

## Protect required behavior

Read relevant ADRs before removing an architectural distinction. In particular, the Core/reference-application separation, explicit composition and example ownership manifest support real example removal; one current reference application is not evidence that these are redundant.

Keep validation at untrusted inputs and persistence/wire boundaries. Preserve Worker leases, idempotency, cancellation/cleanup, rollback and permission enforcement where touched. Generated OpenAPI/SDK code is regenerated from its owner, not manually simplified.

Keep behavior tests independent of implementation structure. Refactoring may simplify fixtures, but must retain distinct regression evidence. Add a test only for a meaningful uncovered risk, not to mirror a renamed helper.

## Finish the pass

Explain significant changes and deferred trade-offs, or state that no worthwhile local simplification was found. Return to the development flow for final validation and the existing independent code-review. Large refactors and optional cleanup do not become mandatory work merely because this pass found them.

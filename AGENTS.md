# Working in this repository

Read CONTEXT.md before changing domain terminology and the relevant docs/adr/ decisions before changing architecture. [Product scope](docs/architecture/lab-word.md) distinguishes current implementation from target behavior; inspect the repository before assuming a documented command or feature already exists.

## Agent skills

For Digital Twin Foundation V1 work, start with [the development handoff](docs/handoffs/digital-twin-foundation-v1.md) for the approved scope, published tickets, accepted preview and current implementation baseline.

### Issue tracker

Use GitHub Issues in CaiZongyuan/labworld. Before planning, publishing, claiming or completing tickets, read docs/agents/issue-tracker.md.

### Triage labels

Use the agreed five-role vocabulary in docs/agents/triage-labels.md when creating or changing issue state.

### Domain docs

The shared glossary is CONTEXT.md; decisions live in docs/adr/. Read docs/agents/domain.md when exploring or changing domain boundaries.

### Documentation

When changing public documentation, navigation or generated references, read docs/agents/documentation.md.

### Engineering flow

For user-facing UI, UX or workflow changes, read [experience-design.md](docs/agents/experience-design.md). Desktop web is the default scope; add mobile adaptation and validation only when the user or approved task explicitly includes them. Reuse accepted previews and the latest explicit scope changes, including an instruction to proceed without another preview.

For implementation, read docs/agents/development-flow.md and docs/testing/strategy.md. Work an unblocked vertical ticket through its agreed public test interfaces. WIP commits and authorized Draft PRs can preserve progress; completion and main merge require simplification, independent Standards + Spec review and required final-head CI. The project flow explicitly overrides conflicting imported-skill defaults; keep imported skills unchanged.

At issue completion or before PR merge, run the repository-owned [reduce-complexity](.agents/skills/reduce-complexity/SKILL.md) step before final validation and code-review; reuse the result when the changes are unchanged. At Epic completion, use its broader simplification survey. Compose these steps in the repository workflow while keeping imported skills unchanged for upstream updates.

For coordinated development, lightweight stage records and delivery-time analysis, use [development-timeline](.agents/skills/development-timeline/SKILL.md). Record stage changes, waits and rework rather than every action; its report is not an additional merge gate.

### Docker resources

At the start of a Docker run or validation phase, inventory containers, volumes, networks and disk usage. Use the run's fixture or supervisor to record temporary resource names, labels, ports and consumers in an owned ledger; reference it from the task checkpoint. Worktrees share the Docker daemon; isolate resources and record the owner of any shared development service.

The creating agent owns cleanup after success, failure, timeout and cancellation. Use `docker rm -f -v <owned-container>` for disposable containers; `--rm` does not stop a container when its creating process exits. Explicitly remove owned temporary named volumes and networks after checking their references. A `finally` block alone does not cover process termination; provide interruption cleanup and recover leftovers after an interrupted run.

Before a normal retry, reconcile the run's owned ledger with actual resources and consumers. After an abnormal exit, session recovery, run completion or ticket completion, reconcile the ledger and the global inventory. Confirm the owner and consumers have stopped before reclaiming a temporary resource. PM checks the recorded reconciliation before declaring delivery complete and reports retained resources with owner and purpose; repeat inspection when evidence is incomplete or ownership is uncertain. Age, an exited container or an unreferenced volume alone does not establish ownership.

Preserve active development services, persistent data and other projects' resources unless the user explicitly authorizes their removal. Cleanup uses an explicit owned-resource list; do not run global Docker prune commands. At run completion, verify and report the remaining containers, volumes, networks and disk usage after cleanup. Normal command retries within that run use the owned ledger rather than repeating a full global inventory.

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

For user-facing UI, UX or workflow changes, read [experience-design.md](docs/agents/experience-design.md). Start with a versioned interactive preview, carry the user's decisions into implementation, and compare the real application with the accepted experience. Reuse existing approval and honor an explicit instruction to proceed without another preview. Continue through the matt engineering flow below; keep imported skills unchanged.

For implementation, read docs/agents/development-flow.md and docs/testing/strategy.md. Work an unblocked vertical ticket through its agreed public test interfaces, then perform Standards + Spec review before committing.

At issue completion or before PR merge, run the repository-owned [reduce-complexity](.agents/skills/reduce-complexity/SKILL.md) step before final validation and code-review; reuse the result when the changes are unchanged. At Epic completion, use its broader simplification survey. Compose these steps in the repository workflow while keeping imported skills unchanged for upstream updates.

### Docker resources

Before starting Docker work, inventory containers, volumes, networks and disk usage. Give temporary resources identifiable project, ticket and run ownership through names or labels, and record their exact names in the task checkpoint. Worktrees share the Docker daemon; isolate each run's resources and ports, and record the owner of any shared development service.

The creating agent owns cleanup after success, failure, timeout and cancellation. Use `docker rm -f -v <owned-container>` for disposable containers; `--rm` does not stop a container when its creating process exits. Explicitly remove owned temporary named volumes and networks after checking their references. A `finally` block alone does not cover process termination; provide interruption cleanup and recover leftovers after an interrupted run.

Before retrying, after session recovery and at ticket completion, reconcile recorded resources with Docker's actual state. Confirm the owner and consumers have stopped before reclaiming a temporary resource. PM must check this inventory before declaring delivery complete and report retained resources with their owner and purpose; age, an exited container or an unreferenced volume alone does not establish ownership.

Preserve active development services, persistent data and other projects' resources unless the user explicitly authorizes their removal. Cleanup uses an explicit owned-resource list; do not run global Docker prune commands. Verify and report the remaining containers, volumes and disk usage after cleanup.

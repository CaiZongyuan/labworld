# Working in this repository

Read CONTEXT.md before changing domain terminology and the relevant docs/adr/ decisions before changing architecture. [Product scope](docs/architecture/lab-word.md) distinguishes current implementation from target behavior; inspect the repository before assuming a documented command or feature already exists.

## Agent skills

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

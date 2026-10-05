# Issue tracker: GitHub

Canonical tracker: https://github.com/CaiZongyuan/labworld/issues. Use the gh CLI with explicit repository CaiZongyuan/labworld so worktrees or other remotes cannot redirect writes. Historical template issue numbers and approvals do not carry into this product repository.

## Specs and implementation tickets

- Specs and implementation tickets are GitHub issues. A spec is a reference document, not a single implementation assignment; only the scoped implementation tickets are claimed for coding.
- Read the full issue body, comments, labels and current blockers before implementation. Use each child ticket's Parent reference to find the approved spec.
- Publish only the reviewed ticket breakdown. Each implementation ticket is a complete observable behavior with acceptance criteria, agreed tests and an online tutorial requirement.
- Local plans and .scratch artifacts are design or publication drafts, not a second issue tracker. Record resulting GitHub identifiers after publication.
- Create multiline bodies from UTF-8 files using --body-file. Preserve the approved content and real newlines.
- Apply ready-for-agent to fully specified implementation tickets. This means the ticket is specified; it can start only when its blockers are closed.
- Do not retriage tickets produced by to-tickets. Incoming requests may use the separate triage flow.

## Native blocking links

For a ticket blocked by another issue, use GitHub's issue-dependency blocked_by relationship. The endpoint is POST repos/{owner}/{repo}/issues/{ticket-number}/dependencies/blocked_by, and issue_id is the blocker's numeric database ID from the REST issue response, not its displayed issue number or GraphQL node ID.

Create blockers before blocked tickets, retain readable Blocked by issue links in the bodies, then verify the native relationships. If the platform explicitly does not support dependencies, retain the textual edges and report the limitation; an authentication or permission failure is not evidence that the feature is unsupported.

A ticket is eligible only when all blocking issues are closed and no other implementer owns it. Ready labels alone do not prove eligibility. Distinct unblocked branches may proceed independently.

Do not modify or close a source/parent spec issue while splitting it. Keep implementation status in child tickets and PRs.

## Completion

Use an isolated branch/worktree appropriate to the task. Follow [development-flow.md](development-flow.md): WIP commits and authorized Draft PRs may preserve progress before final review, with verified and pending scope clearly stated. A PR references its implementation issue and contains behavior and validation evidence. Final merge requires the stable candidate's simplification, independent Standards/Spec coverage and required final-head CI. Close the implementation issue when the agreed completed work is integrated, not merely because a commit, PR or draft exists. Publishing tickets does not itself authorize starting an unlimited implementation run.

## Pull requests as a triage surface

PRs as a request surface: no.

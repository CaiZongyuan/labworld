# Experience design

Apply to changes in pages, navigation, user interactions or user-visible workflows. This step feeds the matt flow in [development-flow.md](development-flow.md); backend-only work follows its existing route unless a state or workflow question needs a runnable probe.

## 1. Establish the task

Inspect the actual application, existing contracts, domain vocabulary and references. State the user task, scope, constraints and success criteria in a short brief. Distinguish existing capabilities from proposed ones.

Resolve facts from code and primary sources. Use `grill-with-docs` and its `grilling` primitive for consequential decisions that remain open. Ask the current decision frontier with recommendations, carry forward settled answers, and keep independent discovery moving while waiting. A familiar app category does not settle its intended workflow.

Done when the user can recognize the intended result and the remaining assumptions are explicit.

## 2. Show the experience

For visible changes, produce a versioned, runnable interactive preview before product implementation. Prefer a self-contained HTML when it can represent the experience faithfully; otherwise use an isolated route with the existing application context. Preserve each delivered version and give the user a working file or URL.

Reuse the repo's components, tokens, icon libraries and realistic content. A visual acceptance preview needs enough finish to judge the resulting page. Use the matt `prototype` skill for cheap probes that answer a specific layout or state question; a low-fidelity logic probe and a visual acceptance preview have different completion criteria.

Make the critical journey operable. Include the states that affect decisions, such as empty, loading, failure, permission denial, unsaved input and conflicts. Keep simulated data and mutations isolated from the real application. Put scenario controls outside the evaluated product surface and record which capabilities are simulated.

When the reference direction is established, start with one coherent design. Offer alternatives when a material structural decision remains open. Inspect the reference's current implementation rather than assuming an old description still reflects it.

Done when the preview runs, its important controls work and the user has a concrete version to assess.

## 3. Capture feedback

Record the accepted version, feedback, required revisions and unresolved decisions. Keep the original artifact, then create a new version for an iteration. Approval of the overall visual direction is not confirmation of every interaction or simulated feature.

Reuse approvals already given. The latest user correction supplements the accepted version. If the user explicitly requests direct implementation or waives another preview, proceed from that accepted design and record the correction; do not ask them to approve the same stage again.

Done when the implementation inputs consist of a recognizable accepted experience plus any explicit corrections and scope decisions.

## 4. Enter the matt flow

Use `ask-matt` to choose the implementation route. A bounded, already-approved change can continue in the current context. Multi-session work goes through `to-spec` and `to-tickets`, including the existing approval of ticket granularity and blocking edges before publication.

Translate the experience into observable acceptance criteria and tests at the interfaces agreed in [testing strategy](../testing/strategy.md). Cite the preview version and record persistence, permissions, navigation and error recovery explicitly. Keep source paths and prototype code out of the implementation prescription; links to primary-source artifacts belong in the supporting notes.

Implement using the real components and contracts. Prototype code is evidence for the design, not a production-quality implementation. Preserve example ownership and Core independence, update the runnable example and paired tutorials, then run the repository's simplification, required checks and Standards + Spec review.

## 5. Verify the real application

Exercise the actual journey in a browser and compare representative states with the accepted version at comparable content, viewport, language and theme. Check layout, text fit, focus, keyboard operation and recovery from relevant failures. Use real E2E dependencies for critical journeys covered by the testing strategy.

Treat functional checks and visual acceptance as separate evidence. A passing unit test does not establish visual fidelity; an attractive screenshot does not establish permissions or persistence. If an environment blocks a check, record exactly what ran and what remains unverified.

Resolve material deviations within the agreed design. Return to the user for a changed product decision, rather than restarting discovery for routine implementation details. Deliver the real application with evidence and limits, then carry lessons from the interaction into the repository-owned workflow when authorized.

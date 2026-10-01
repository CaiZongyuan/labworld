# Domain documentation

Use a single glossary at CONTEXT.md and project decisions in docs/adr/. The planned monorepo does not by itself require multiple domain glossaries.

Before investigating or implementing behavior, read the glossary and ADRs relevant to that area. Use Lab Word, Digital Twin, Lab Viewer, Lab Layout, Equipment Model and Equipment Instance consistently. Organization, Membership and knowledge terms retain their platform meanings. Lab owns equipment and layout behavior; Core owns reusable platform capabilities; Knowledge owns its existing business behavior.

When a design conflicts with an accepted ADR, identify the decision and resolve the conflict before silently changing it. Add terms when their meaning is resolved, and reserve ADRs for significant choices with real alternatives and meaningful reversal cost.

CONTEXT.md contains domain definitions, not implementation details, task state or raw meeting notes. The product architecture, Lab plans and approved GitHub tickets carry implementation and acceptance contracts. Inherited ADRs record platform constraints; their historical template delivery claims do not establish tools present in this repository.

# Documentation maintenance

Read this when creating or editing public documentation, navigation or generated references. Write for Lab Word tasks using the [author guide](../guides/maintain-docs.md). The upstream writing pattern is referenced there at a fixed revision; Lab Word source owns facts.

Apply the author guide's [ASD-STE100-inspired writing rules](../guides/maintain-docs.md#simplified-technical-language) when writing or reviewing public prose in either language.

## Write and verify one developer task

1. Identify the reader, task and page type. Use `overview`, `tutorial`, `guide`, `concept` or `reference` in `docs/site.json`.
2. Inspect the current public interface, source and existing behavior checks. Use CONTEXT terms and accepted ADRs. Distinguish production capabilities, isolated previews and planned behavior.
3. Write the smallest complete path from source location to observable result. Tutorials continue the same business code; guides can be entered independently. Explain the reason after the first runnable result.
4. Deliver Chinese and English sources together with one stable chapter id. Set explicit `previous`/`next` ids when pages form a sequence; absent relationships disable automatic unrelated neighbors.
5. Update code, tests, source snippets, links and business ownership with the capability. Keep API DTOs and configuration defaults generated from implementation.
6. Run affected public behavior checks, `pnpm docs:check` and `pnpm docs:build`. Compare visible navigation and layouts with the accepted experience. Use the repository simplification and Standards + Spec review before delivery.

Done when the task can be followed in its declared source version, both languages have the same behavior, changed prose has passed the language review, links resolve, ownership is clear, and validation records its actual scope. Preview branches must state their availability; a local preserved branch is not a published artifact.

## Content responsibilities

| Type | Required content |
| --- | --- |
| Tutorial | Starting code state, complete change, files, run/request, expected result, one failure check, next stage |
| Guide | Goal, prerequisites, public interface, complete minimal implementation, verification, recovery |
| Concept | Definition, real relationship diagram, minimal example, tradeoff and failure boundary, practical guide |
| Reference | Source, classified index, types/options/returns/errors/limits, links to usage |
| Overview | Product scope, current stage, task entry paths and a first result |

Keep historical tickets and validation reports in maintainer records. The public page describes current behavior. The footer SHA identifies the build source; it does not prove every command was tested.

## Source and ownership

Repository Markdown and tracked teaching code are canonical. `apps/docs/.generated` and VitePress output are derived. Use `<<<` for source snippets and Markdown links to source files; the renderer localizes destinations registered in the site model.

Keep adopted published routes when reorganizing source files. Register new bilingual routes explicitly. Product pages cover equipment viewing and Lab development; inherited SaaS courses and template promotion belong upstream. Keep actual module ownership explicit without requiring absent example-removal tooling.

Use screenshots to identify actual UI or results with reproducible development content and a recorded version. Use compact code and diagrams for backend flow. Explain placeholders, command working directories, required services and whether a step changes persistent data.

Only add a new source of generated facts when the public reference needs it. Prefer the existing OpenAPI, Settings/FIELDS and task runners. Changes to an interface update its teaching examples in the same implementation. Copy site assets from apps/docs/public through the projection script; derived files remain untracked.

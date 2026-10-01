# Maintain Project Documentation

Goal: deliver runnable learning paths and useful references with Lab Word behavior. The writing pattern follows [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template/tree/83f1f71bd166af8b604dd50124abc85242b82177/docs)as inspected on 2026-10-01; topics and facts come from Lab Word's current source.

## Choose A Reader Task

| Type      | Content order                                                                                    | Completion                                    |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Tutorial  | Goal, prior code, complete change, run, result, failure check, next chapter                      | Continue the same Lab code                    |
| Guide     | Goal, prerequisites, source/public interface, complete minimal operation, verification, recovery | Complete the task independently               |
| Concept   | Definition, real relationship diagram, minimal example, tradeoffs, limits, practical guide       | Understand when it applies and where it fails |
| Reference | Source, classification, parameters, returns, errors, limits, usage                               | Find the current contract                     |
| Overview  | Product scope, current stage, task entries, first result                                         | Know where to start                           |

Equipment inspection, GLB import and Lab development define the learning path. Link platform topics when Lab needs them. Historical template tickets, generic SaaS courses and template promotion are outside product documentation.

## Write A Verifiable Path

Inspect the public interface and actual source, then write “source location → complete operation → command → result → one failure and recovery.” Specify working directory, dependencies, placeholders and persistent writes. Explain reasons after the first result.

Distinguish production implementation, isolated previews and plans. Screenshots identify actual versions and simulated identities/data. Footer SHA identifies build source and does not establish execution evidence.

## Register And Validate

Create an adjacent `.en.md` and register one stable id, both titles/sources, route, group and type in [site.json](../site.json). Sequence chapters through `previous`/`next` ids; unrelated pages do not form automatic sequences.

Markdown is canonical content. Rust/OpenAPI owns API facts and Settings owns configuration. Use `<<<` for checked complete source instead of duplicating code. Scripts generate `apps/docs/.generated` and build artifacts. Put site images in `apps/docs/public/`.

```bash
pnpm docs:check
pnpm docs:build
just e2e-docs
```

The first two validate sources, locale pairing, generated references and built links. Browser journeys validate language, theme, search and deployment base. Test business HTTP, components and actual 3D rendering separately under the [testing strategy](../testing/strategy.md).

Lab Word has not published inherited template learning paths. Cleanup removes unrelated pages while retaining routes for adopted chapters. Future reorganization must preserve actual published Lab links, without importing dangling template navigation.

## Maintainer Entries

[CONTEXT](../../CONTEXT.md)owns vocabulary; [ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)records product boundaries. The [development flow](../agents/development-flow.md)and [author rules](../agents/documentation.md)define delivery. The original [documentation philosophy](../document-guild.md)remains a writing reference.

After validation, follow the [publishing guide](../getting-started/publish-docs.md).

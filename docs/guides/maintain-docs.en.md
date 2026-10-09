# Maintain Project Documentation

Goal: help readers run Lab Word tasks and find current reference information. The writing pattern follows [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template/tree/83f1f71bd166af8b604dd50124abc85242b82177/docs), as inspected on 2026-10-01. Topics and facts come from the current Lab Word source.

## Choose A Reader Task

| Type      | Content order                                                                                    | Completion                                    |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Tutorial  | Goal, prior code, complete change, run, result, failure check, next chapter                      | Continue the same Lab code                    |
| Guide     | Goal, prerequisites, source/public interface, complete minimal operation, verification, recovery | Complete the task independently               |
| Concept   | Definition, real relationship diagram, minimal example, tradeoffs, limits, practical guide       | Understand when it applies and where it fails |
| Reference | Source, classification, parameters, returns, errors, limits, usage                               | Find the current contract                     |
| Overview  | Product scope, current stage, task entries, first result                                         | Know where to start                           |

The learning path covers equipment inspection, GLB import and Lab development. Link to platform topics when a Lab task needs them. Product documentation excludes historical template tickets, generic SaaS courses and template promotion.

## Write A Verifiable Path

Inspect the public interface and current source. Write a complete path: source location, operation, command, expected result, then one failure and recovery. State the working directory, dependencies and placeholder values. Explain whether the operation writes persistent data. Explain the reasons after the reader gets the first result.

State whether a feature is implemented, an isolated preview or planned. For screenshots, record the source version and identify simulated accounts or data. The footer SHA identifies the source used to build the site. It does not prove that the documented commands were tested.

## Simplified Technical Language: ASD-STE100-inspired {#simplified-technical-language}

Public documentation aims to be **80% of the way to ASD-STE100**. Use the principles of [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/) to make actions, conditions and results easy to understand. The percentage describes our writing approach. It is not a measured compliance score. Lab Word does not claim full compliance with the STE writing rules or controlled dictionary.

| Rule                                   | How to apply it in Lab Word                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use short sentences with one main idea | Aim for up to 20 words in English instructions and 25 words in descriptions. Split longer sentences first. In Chinese, split by meaning rather than English word counts.         |
| Use active voice and name the actor    | Start instructions with a verb, such as `Open`, `Run` or `Select`. For system behavior, name the API, Worker or browser that acts.                                               |
| Give one action per step               | Use numbered steps. Put the expected result immediately after the action. Put dependencies, permissions, conditions and warnings before the related action.                      |
| Use common words with stable meanings  | Prefer `use`, `start`, `stop` and `check`. Use one term for each concept. Follow [CONTEXT](../../CONTEXT.md) for domain terms.                                                   |
| Keep exact technical names             | Keep necessary terms, such as GLB and Entity, and explain them on first use. Preserve commands, paths, API fields, error codes and interface labels.                             |
| Make conditions and failures clear     | State the trigger, result and recovery action. Preserve the distinctions between `must`, `should` and `can`. Preserve negation, units, numeric limits and permission boundaries. |

Keep each paragraph on one topic. Separate actions from explanations. Both languages must keep the same prerequisites, steps, results and failure boundaries. Use natural sentences in each language.

For example, replace "After adding SQL, migrate and restart development so the embedded migration set is refreshed." with:

1. After you add SQL migrations, run `just migrate`.
2. Restart development.

The restart updates the migration set in the binary.

Before delivery, review each changed passage against the table. Compare it with the source and the other language version. Word counts guide editing; they do not replace a review of meaning. `docs:check` checks documentation structure and source relationships. It does not validate STE compliance.

## Register And Validate

1. Create an English `.en.md` file next to the Chinese source.
2. Register the page in [site.json](../site.json).
3. For a chapter sequence, set `previous` and `next` to the related chapter ids.

The registration needs one stable id, both titles and sources, published routes, a group and a page type. Pages without a chapter relationship have no automatic previous or next page.

Repository Markdown is the source of page content. Rust/OpenAPI provides API facts. Settings provides configuration facts. Use `<<<` to include checked, complete source code. Scripts generate `apps/docs/.generated` and the build output. Put site images in `apps/docs/public/`.

Run these checks from the repository root:

```bash
pnpm docs:check
pnpm docs:build
just e2e-docs
```

The first two commands check sources, language pairs, generated references and links in the built site. Browser tests check language, theme, search and the deployment base. Use the [testing strategy](../testing/strategy.md) to check business HTTP behavior, components and actual 3D rendering separately.

Lab Word has not published the learning paths from the original template. The cleanup removed unrelated pages and kept routes for adopted chapters. When you reorganize published Lab pages, preserve their existing links. Check that every navigation entry has a destination.

## Maintainer Entries

[CONTEXT](../../CONTEXT.md) defines the vocabulary. [ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md) records product boundaries. The [development flow](../agents/development-flow.md) and [author rules](../agents/documentation.md) define delivery. The original [documentation philosophy](../document-guild.md) remains a writing reference.

After validation, follow the [publishing guide](../getting-started/publish-docs.md).

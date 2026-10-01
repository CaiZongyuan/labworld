# Lab Word Documentation

Lab Word is a laboratory digital twin. Current work establishes a Three.js presentation layer for equipment models; placement and live state follow later.

## Choose Your Task

| Task                           | Starting point                                                             | Observable result                                            |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Start the existing application | [Quick start](quickstart.md)                                               | Ready API and accessible Web registration page               |
| Inspect equipment models       | [Lab Viewer preview](../guides/lab-viewer.md)                              | A rendered model and local GLB import in an isolated preview |
| Change the project             | [Project structure](../architecture/project-structure.md)                  | Locate application composition and business ownership        |
| Look up interfaces             | [API](site:reference/api.md) and [configuration](site:reference/config.md) | Find generated contracts and defaults                        |

## Current Capabilities And Plans

The application already has identity, membership, knowledge, files and jobs through its [platform capabilities](../guides/platform.md). Lab Viewer v1 runs independently and its visual experience is accepted. Acceptance of production routing, the Lab entry after login and production lazy loading is pending.

Local GLB import stays in the browser session and does not upload files. Equipment data integration, control and scene placement follow later. [Product scope](../architecture/lab-word.md) explains the boundary; the [presentation plan](../plans/lab-viewer-m0.md) records future acceptance criteria.

## Reading And Maintenance

Tutorials grow the same Lab business code. Independent guides provide a task, prerequisites, source locations, commands, results and failure boundaries. Existing capabilities, previews and plans carry distinct status statements.

Chinese and English pages are paired by chapter. API and configuration facts are generated from implementation. Update relevant documentation and [validation](../testing/t01-feedback-loop.md) with behavior changes; see [documentation maintenance](../guides/maintain-docs.md).

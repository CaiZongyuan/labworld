# Product Scope And Architecture

Lab Word is a laboratory digital twin. The current stage focuses on equipment model presentation. Placement and live state with explicit sources follow later. See the [glossary](../../CONTEXT.md).

## Models And Equipment

```text
Lab Word
  └─ Lab Viewer
       └─ Lab Layout
            └─ Equipment Instance ──uses──> Equipment Model
```

An Equipment Model is a reusable 3D asset; an Equipment Instance is one device with its own identity and position. Multiple instances can share one model, so filenames cannot stand in for equipment identity. The current single-model preview does not establish persistent layouts.

## Existing Implementation And Planned Integration

| Area                                             | Current state                          | Future responsibility                           |
| ------------------------------------------------ | -------------------------------------- | ----------------------------------------------- |
| Universal shell, identity, membership, knowledge | Existing application code              | Host Lab and provide shared capabilities        |
| Lab Viewer v1                                    | Accepted isolated preview              | Integrate import, camera, selection and metrics |
| Lab navigation and default entry after login     | Agreed; integration acceptance pending | Explicitly compose the Lab contribution         |
| Multiple-device layouts and real device data     | Future scope                           | Define persistence and state sources            |

[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)chooses the existing SaaS foundation: Lab owns equipment and layout behavior while Core owns common identity and membership. Production Lab integration and acceptance are pending. See [project structure](project-structure.md) for integration locations.

## Presentation Boundaries

The first version inspects one self-contained GLB, with file selection/drop, automatic centering/framing, orbit/zoom/pan, click selection, return to preset and renderer metrics. Imported files remain in the browser session; server upload and a cloud asset library are outside this stage.

Preserve source scale. Missing external resources, absent geometry and decoder failures require explicit feedback while keeping the previous usable model. Replacements and page exit must release exclusive GPU resources; older loads must not overwrite newer models. These are acceptance contracts awaiting production implementation.

Three.js code will load with the Lab page and be measured against production bundle budgets. Preview builds and software-rendering measurements do not establish production performance.

## Continue Development

Follow the [preview guide](../guides/lab-viewer.md), then turn accepted behavior into public tests. The [presentation plan](../plans/lab-viewer-m0.md) records scope and assets; [module boundaries](module-boundaries.md) define ownership.

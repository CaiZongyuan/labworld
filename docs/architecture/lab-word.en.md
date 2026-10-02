# Product Scope And Architecture

Lab Word is a laboratory digital twin. The application currently provides single-model viewing and a session-local Asset Library. Persistent worlds and server-owned virtual devices are the approved next stage. See the [glossary](../../CONTEXT.md).

## Models And Equipment

```text
Lab ──registers──> Entity <──defined by── Asset
                    │
                    └──represented by Scene Node <──appearance── Asset Representation
```

This is the Foundation V1 target relationship: an Equipment Model is a 3D representation, and an Equipment Instance is a device Entity. Scene Node identity and placement are independent of device identity. Multiple devices can share a model, and one device can have multiple nodes. The current single-model viewer does not establish these persistent objects or layouts.

## Existing Implementation And Planned Integration

| Area                                             | Current state                               | Future responsibility                         |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| Universal shell, identity, membership, knowledge | Existing application code                   | Host Lab and provide shared capabilities      |
| Lab Viewer and session-local Asset Library       | Integrated with application verification    | Extend persistent assets and multiple objects |
| Lab navigation and default entry after login     | Integrated through explicit composition     | Preserve shell and Lab ownership              |
| Foundation V1                                    | Experience accepted; spec/tickets published | Build persistent worlds and virtual devices   |
| Physical devices and protocols                   | Future scope                                | Add source adapters and execution contracts   |

[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)chooses the existing SaaS foundation: Lab owns equipment and layout behavior while Core owns common identity and membership. See [project structure](project-structure.md) for integration locations.

## Presentation Boundaries

The first version inspects one self-contained GLB, with file selection/drop, automatic centering/framing, orbit/zoom/pan, click selection, return to preset and renderer metrics. Imported files remain in the browser session; server upload and a cloud asset library are outside this stage.

The current implementation preserves source scale, reports external-resource dependencies, absent geometry and decoder failures, and keeps the previous usable model on failure. Replacements and page exit release exclusive GPU resources; older loads cannot overwrite newer models. Multiple-instance work must retain these contracts.

Three.js code is loaded with the Lab page and checked against production bundle budgets. Preview builds and software-rendering measurements do not establish target-hardware performance.

## Continue Development

Follow the [viewer guide](../guides/lab-viewer.md) for current behavior. Foundation V1 continues through [spec #1](https://github.com/CaiZongyuan/labworld/issues/1) and its implementation tickets; start with the [developer handoff](../handoffs/digital-twin-foundation-v1.md). [Module boundaries](module-boundaries.md) define ownership.

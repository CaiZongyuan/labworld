# Product Scope And Architecture

Lab Word is a laboratory digital twin. The application currently provides persistent Labs, independent Entities, multi-node scenes, a server Asset Library and versioned built-in definitions. Server-owned virtual devices are the approved next stage. See the [glossary](../../CONTEXT.md).

## Models And Equipment

```text
Lab ──registers──> Entity <──defined by── Asset
                    │
                    └──represented by Scene Node <──appearance── Asset Representation
```

This Foundation V1 identity relationship is implemented: an Equipment Model is a 3D representation, and an Equipment Instance is a device Entity. Scene Node identity and placement are independent of device identity. Multiple devices can share a model, and one device can have multiple nodes. Registration pins a definition version and snapshot. Simulated and physical objects have separate identities, and static objects require no Binding.

## Existing Implementation And Planned Integration

| Area                                             | Current state                                    | Future responsibility                              |
| ------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Universal shell, identity, membership, knowledge | Existing application code                        | Host Lab and provide shared capabilities           |
| Lab and persistent Asset Library                 | Members/Agents share persistent worlds and files | Layout editing, relationships and runtime Bindings |
| Lab navigation and default entry after login     | Integrated through explicit composition          | Preserve shell and Lab ownership                   |
| Foundation V1                                    | Experience accepted; spec/tickets published      | Build persistent worlds and virtual devices        |
| Physical devices and protocols                   | Future scope                                     | Add source adapters and execution contracts        |

[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)chooses the existing SaaS foundation: Lab owns equipment and layout behavior while Core owns common identity and membership. See [project structure](project-structure.md) for integration locations.

## Presentation Boundaries

The Lab entry has an object directory, multi-node scene and Inspector. Basic placement, instance configuration and references persist and can be read by another browser or Agent. Robot definition support, Binding implementation and current executability remain separate; absent observations are unknown. Interactive layout editing, relationships and device execution follow in later slices. See the [persistent world tutorial](../tutorials/persistent-world.md). The asset library retains single-model preview at `/lab/asset`, including GLB imports, camera controls, selection, return to preset and renderer metrics. Core owns file lifecycles; Lab owns stable asset and representation references.

The implementation preserves source scale, reports external-resource dependencies, absent geometry and decoder failures, and keeps the previous usable model on failure. Each node loads and releases independent model resources; selecting one instance does not rewrite another's materials. World snapshots return every referenced asset, so model recovery does not depend on the first catalog page.

Three.js code is loaded with the Lab page and checked against production bundle budgets. Preview builds and software-rendering measurements do not establish target-hardware performance.

## Continue Development

Follow the [viewer guide](../guides/lab-viewer.md) for current behavior. Foundation V1 continues through [spec #1](https://github.com/CaiZongyuan/labworld/issues/1) and its implementation tickets; start with the [developer handoff](../handoffs/digital-twin-foundation-v1.md). [Module boundaries](module-boundaries.md) define ownership.

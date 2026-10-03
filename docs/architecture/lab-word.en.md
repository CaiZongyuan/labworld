# Product Scope And Architecture

Lab Word is a laboratory digital twin. The application currently provides persistent Labs, independent Entities, multi-node scenes, a server Asset Library, versioned definitions and backend lighting programs. See the [glossary](../../CONTEXT.md).

## Models And Equipment

```text
Lab ──registers──> Entity <──defined by── Asset
                    │
                    └──represented by Scene Node <──appearance── Asset Representation
```

This Foundation V1 identity relationship is implemented: an Equipment Model is a 3D representation, and an Equipment Instance is a device Entity. Scene Node identity and placement are independent of device identity. Multiple devices can share a model, and one device can have multiple nodes. Registration pins a definition version and snapshot. Simulated and physical objects have separate identities, and static objects require no Binding.

## Existing Implementation And Planned Integration

| Area                                             | Current state                                       | Future responsibility                           |
| ------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------- |
| Universal shell, identity, membership, knowledge | Existing application code                           | Host Lab and provide shared capabilities        |
| Lab and persistent Asset Library                 | Members/Agents share worlds, files and lighting API | Layout editing, relationships and more programs |
| Lab navigation and default entry after login     | Integrated through explicit composition             | Preserve shell and Lab ownership                |
| Foundation V1                                    | Experience accepted; spec/tickets published         | Build persistent worlds and virtual devices     |
| Physical devices and protocols                   | Future scope                                        | Add source adapters and execution contracts     |

[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)chooses the existing SaaS foundation: Lab owns equipment and layout behavior while Core owns common identity and membership. See [project structure](project-structure.md) for integration locations.

## Presentation Boundaries

The Lab entry has an object directory, multi-node scene and Inspector. Basic placement, configuration and references persist across browsers and Agents. Definition support, Binding implementation and current executability remain separate; absent observations are unknown. Independent backend lights distinguish command acceptance from observations, retain the last report when stopped and require explicit startup after interruption; see the [lighting tutorial](../tutorials/backend-lights.md). Interactive layout editing, relationships, continuous sensors, centrifuge tasks and reliable push follow in later slices. The asset library retains preview at `/lab/asset`; Core owns file lifecycles and Lab owns stable references.

The implementation preserves source scale, reports external-resource dependencies, absent geometry and decoder failures, and keeps the previous usable model on failure. Each node loads and releases independent model resources; selecting one instance does not rewrite another's materials. World snapshots return every referenced asset, so model recovery does not depend on the first catalog page.

Three.js code is loaded with the Lab page and checked against production bundle budgets. Preview builds and software-rendering measurements do not establish target-hardware performance.

## Continue Development

Follow the [viewer guide](../guides/lab-viewer.md) for current behavior. Foundation V1 continues through [spec #1](https://github.com/CaiZongyuan/labworld/issues/1) and its implementation tickets; start with the [developer handoff](../handoffs/digital-twin-foundation-v1.md). [Module boundaries](module-boundaries.md) define ownership.

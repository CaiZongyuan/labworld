# Product Scope And Architecture

Lab Word is a laboratory digital twin. The application provides persistent Labs, independent Entities, multi-node scenes, a server Asset Library and versioned definitions. Users can edit layouts, register manual relationships and run backend lighting, temperature and centrifuge programs. See the [glossary](../../CONTEXT.md).

## Models And Equipment

```text
Lab ──registers──> Entity <──defined by── Asset
                    │
                    └──represented by Scene Node <──appearance── Asset Representation
```

This Foundation V1 identity relationship is implemented: an Equipment Model is a 3D representation, and an Equipment Instance is a device Entity. Scene Node identity and placement are independent of device identity. Multiple devices can share a model, and one device can have multiple nodes. Registration pins a definition version and snapshot. Simulated and physical objects have separate identities, and static objects require no Binding.

## Existing Implementation And Planned Integration

| Area                                             | Current state                                                                                  | Future responsibility                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Universal shell, identity, membership, knowledge | Existing application code                                                                      | Host Lab and provide shared capabilities    |
| Lab and persistent Asset Library                 | Members/Agents share worlds, layouts, files, device programs, history and lifecycle operations | Combined scale validation                   |
| Lab navigation and default entry after login     | Integrated through explicit composition                                                        | Preserve shell and Lab ownership            |
| Foundation V1                                    | Persistent worlds, device programs, synchronization, retention and lifecycle are implemented   | Final combined validation                   |
| Physical devices and protocols                   | Future scope                                                                                   | Add source adapters and execution contracts |

[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)chooses the existing SaaS foundation: Lab owns equipment and layout behavior while Core owns common identity and membership. See [project structure](project-structure.md) for integration locations.

## Presentation Boundaries

The Lab entry has an object directory, multi-node scene and Inspector. Placement, configuration and references persist across browsers and Agents. Pointer transforms edit only Placement. Users register relationships with manual provenance. The API rejects invalid spatial cycles. Copies create independent Entities. Additional representations and node removal retain identity. Version conflicts keep the draft for explicit recovery. See the [layout tutorial](../tutorials/edit-layout.en.md).

Definition support, Binding implementation and current executability remain separate. Absent observations are unknown. [Backend lights](../tutorials/backend-lights.en.md) distinguish command acceptance from observations. Stopping retains the last report. Interruption requires explicit startup. Layout versions remain separate from runtime state. [World subscriptions](../tutorials/reliable-sync.en.md) provide persistent versions, property updates, bounded queues and snapshot recovery. Credential revocation ends existing access. Service readiness and persistent capability permission jointly determine operability.

[History](../tutorials/run-history.en.md) supports device, type, time range and cursor queries. Raw observations default to 24 hours. Ended commands, tasks and events default to 30 days. Cleanup keeps identities, configuration, last property observations and active tasks. Each retained property keeps its actual timestamps and freshness. Deleting expired current task records advances the world version. History gaps remain explicit. The asset library retains preview at `/lab/asset`. Core owns file lifecycles. Lab owns stable references.

[Entity lifecycle](../tutorials/entity-lifecycle.en.md) requires ended Tasks and a stopped program before archive or definition changes. Archive retains identity, nodes, real asset references and records within retention. Appearance replacement works during running programs and Tasks. It updates the Entity and its current nodes without changing device behavior. Explicit catalog selection records the definition version. Supported simulated definitions receive a new current Binding. Other choices leave no current Binding. Old Runs retain the original association and source. Scale and combined experience validation follow later.

Backend [temperature sensors](../tutorials/continuous-temperature.en.md) sample independently at 1Hz. Each property retains value, unit, source, timestamps and quality. Heartbeats do not refresh old measurements. Stopping a source keeps its last value. The report deadline determines expiry. Expiry advances the world version and preserves layout drafts.

The backend advances [centrifuge tasks](../tutorials/centrifuge-tasks.en.md) after browsers close. Commands, Runs, Tasks and results have separate queryable identities. Each task freezes its speed, temperature and duration. Timing starts after speed and temperature reach tolerance. Preparation and deceleration do not count towards task duration. Stop produces cancelled after deceleration. Normal completion produces completed after deceleration. Fault and uncertain outcomes cannot become completed. Backend restart marks the old Run and unfinished tasks interrupted. Users must start a new Run explicitly. The browser rotates built-in rotors from observed RPM. Imported GLB appearances have no rotor mapping.

The implementation preserves source scale, reports external-resource dependencies, absent geometry and decoder failures, and keeps the previous usable model on failure. Each node loads and releases independent model resources; selecting one instance does not rewrite another's materials. World snapshots return assets referenced by nodes and unplaced objects, so model recovery does not depend on the first catalog page.

Three.js code is loaded with the Lab page and checked against production bundle budgets. Preview builds and software-rendering measurements do not establish target-hardware performance.

## Continue Development

Follow the [viewer guide](../guides/lab-viewer.md) for current behavior. Foundation V1 continues through [spec #1](https://github.com/CaiZongyuan/labworld/issues/1) and its implementation tickets; start with the [developer handoff](../handoffs/digital-twin-foundation-v1.md). [Module boundaries](module-boundaries.md) define ownership.

# Archive An Entity And Replace Its Appearance

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: remove and restore a device's Scene Node. Replace its GLB appearance. Archive the device after its Task ends and program stops.

## Starting Version

Use the common version specified in the [complete journey](complete-foundation.en.md). Use the Node shared schema. Complete [run history](run-history.en.md) first. You need queryable records and retention.

Run commands from the repository root. Start services with `pnpm dev`. Use disposable Lab data. These operations change persistent data.

Members need an active session and CSRF for writes. Agents need an active `lab:full` key. Both callers follow the same lifecycle rules.

Source: [lifecycle HTTP](../../packages/server/src/lab/world/lifecycle.ts), [Inspector controls](../../packages/views/src/lab/entity-lifecycle-panel.tsx), and [migration](../../packages/server/migrations/0000_foundation.sql).

## Remove And Restore A Node

Use a device from the previous chapters. Record its Entity identity from **Object info**.

1. Select the device in Lab.
2. Select **Edit layout**.
3. Select **Remove node** beside its node identity.
4. Save the layout.

   The node disappears. The Entity, Binding, Run, Task and retained history remain.

5. Select **Unplaced objects only** in the object directory.
6. Select the device.
7. Select **Add representation of this object**.
8. Save the layout.

   The API creates a new Scene Node. The Entity identity stays the same.

## Replace An Appearance During A Run

Import a valid GLB in the Asset library before this procedure. Save or discard any layout draft first.

1. Select the device.
2. Start its program.
3. Select **Replace appearance** in **Entity lifecycle**.
4. Select the imported asset in **Appearance**.
5. Select **Save**.

   The API updates the Entity and all its current Scene Nodes. It keeps node identities and Placement. The layout version advances when nodes exist.

6. Check the Entity, Binding and Run identities.
7. Open **Tasks** in **Run history**.

   Identity, program, configuration and task history remain. Appearance changes also work during an unfinished Task.

An arbitrary GLB has no rotor mapping. The browser does not infer rotor nodes or axes. Device readings still show reported values and units. Built-in centrifuge appearances retain their explicit rotor mapping.

If a layout save returns `409 lab.layout_conflict`, keep the draft. Reload the saved layout, then reapply its edits. Appearance replacement changes the layout version to protect concurrent drafts.

## Reject And Recover An Archive

Finish or cancel an active Task before stopping its program. Cancellation finishes only after deceleration. A reserved `pending` Task also blocks lifecycle changes.

1. Select **Archive Entity** while its program runs.
2. Select **Archive** in the confirmation.

   The API returns `409 lab.entity_in_use`. Identity, configuration and records remain unchanged.

3. Select **Cancel** to close the confirmation.
4. Finish or cancel the current Task.
5. Wait for its final result.
6. Select **Stop program**.
7. Select **Archive Entity**.
8. Select **Archive** in the confirmation.

   The Inspector shows **Archived**. The directory opens **Archived objects**. The Entity and records within retention remain queryable.

9. Select the archived Entity.

   Program startup is disabled. Direct new actions return `409 lab.entity_archived`.

The viewport hides archived objects. Archiving keeps node data, relationships and asset references. It does not extend history retention. The API provides no Entity hard-delete operation.

## Select A Definition Explicitly

Use another unarchived simulated device. End its Task and stop its program first.

1. Select **Change definition and program**.
2. Select **Environmental temperature sensor · 1.0** in **Definition version**.
3. Select **Save**.

   The Entity keeps its identity. The API records the selected definition version and snapshot. A supported simulated definition receives a new Binding.

4. Start the program explicitly.

   The new Run uses the selected association. Old Runs retain their original definition, program and source. Old Tasks still refer to their original Runs.

The UI keeps configuration when the definition id stays the same. Selecting another definition starts with its default configuration and retains the label. HTTP callers provide the complete new configuration.

Only simulated `light`, `sensor` and `centrifuge` definitions receive an implemented Binding in this catalog. Static or descriptive choices leave no current Binding. Earlier Bindings remain as Run sources. Physical objects remain separate identities and have no implemented physical Binding. These objects have no program startup control.

The API accepts catalog definitions only. Users cannot edit arbitrary schemas or executable code. Invalid versions return `400 lab.invalid_reference`. Remove incompatible `simulates` or container relationships before changing their definition.

## Check Asset References

An archived Entity still protects its appearance asset.

1. Open the Asset library.
2. Attempt to delete its referenced asset.

   The API returns `409 lab.asset_in_use`. The asset remains available.

3. Select **Replace appearance** on each referencing Entity.
4. Select **Built-in appearance**.
5. Select **Save**.
6. Remove any remaining node-only references.
7. Delete the asset from the Asset library.

   Deletion succeeds only after all real references are removed. The existing Worker then reclaims the file.

## Use The Same HTTP Contract

The example archives the selected device. Use a disposable, stopped device without an unfinished Task. Get UUIDs from the Inspector and Asset library responses.

1. Set the API address.

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. Set the Lab identity.

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. Set the Entity identity.

   ```bash
   export LAB_ENTITY_ID='<entity-uuid>'
   ```

4. Set the imported representation identity.

   ```bash
   export LAB_REPRESENTATION_ID='<representation-uuid>'
   ```

5. Set its Asset identity.

   ```bash
   export LAB_ASSET_ID='<asset-uuid>'
   ```

6. Read an active API key.

   ```bash
   read -rs LAB_API_KEY
   ```

7. Export the key.

   ```bash
   export LAB_API_KEY
   ```

8. Run the example.

   ```bash
   node examples/lab/manage-entity.mjs
   ```

   It checks running rejection, appearance identity, an explicit `sensor@1.0` association, old Run meaning, archive and reference protection.

Complete requests and assertions:

<<< ../../examples/lab/manage-entity.mjs

| Operation  | Request                                                                          | Result                                                                           |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Archive    | `POST /api/v1/lab/labs/{lab_id}/entities/{entity_id}/archive`                    | Entity with `archived_at`; active Run or unfinished Task returns 409             |
| Appearance | `PUT .../appearance` with `representation_id`                                    | Entity and current nodes use the selected representation; null selects built-in  |
| Definition | `PUT .../definition` with `definition_id`, `definition_version`, `configuration` | Explicit association; active Run, unfinished Task or archived Entity returns 409 |
| Query      | `GET .../entities/{entity_id}` and existing Run/Task/history paths               | Retained identities and original source meaning                                  |

Same-key Command retries retain the earlier contract after definition changes or archive. A retained Command returns its original record. An expired Command returns 410. Changed parameters return 409. These checks never create new work.

## Next Stage

Continue with the [complete digital laboratory journey](complete-foundation.en.md). Combine this series in one Lab and reproduce the 100 Entity, 20 device, two-browser reference load. Physical equipment integration remains future scope.

# Import complete asset versions

Goal: publish equipment information and model representations as a fixed Asset Version, then register two independent equipment instances. Author geometry and scenes in Blender, Isaac Sim/Isaac Lab or Newton. This guide manages information and resources. It does not produce observations or enable control.

You need a running Lab World Server, an account and an API key with `lab:full`. Start the application using the [quick start](../getting-started/quickstart.en.md). Run commands from the repository root. They write assets to the current server.

## Publish the first version

1. Create a key with `lab:full` on the **API keys** page.
2. Enter the key at the hidden Bash prompt, then run the example:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/import-asset-version.mjs examples/lab/centrifuge.asset.json
```

The script prints the fixed version ID, asset ID, version and content digest. Repeating the same description returns the original version, even with new file IDs. The script cleans up only its own upload receipts. Published versions keep their resources.

3. Open the asset library. Find **Example centrifuge C** and select **View asset information**.

The information includes model details, specifications, configuration fields, state fields and units, capability descriptions, and representation resources. The geometry is a repository cube. The model information is also illustrative. This is not centrifuge geometry or a simulation. Current speed and temperature remain unknown.

<<< ../../examples/lab/centrifuge.asset.json

The example's `resources[].file` is a local path used only by the upload script. The script produces `file_id`, `sha256`, `size` and `format` for the public API. The Server does not read the author's local paths.

## Register two instances

Keep the environment variables above, then run:

```bash
node examples/lab/register-asset-instances.mjs
```

The script creates a teaching Lab and registers centrifuges A and B. It reads `GET world` and verifies different IDs, independent configurations of 4 and 20, and `binding=null` and `observation=null`. It prints Lab and instance IDs without the key. Each execution creates another teaching Lab.

<<< ../../examples/lab/register-asset-instances.mjs

Use the asset ID and exact version with `POST /api/v1/lab/labs/{lab_id}/entities`:

```json
{
  "name": "Centrifuge A",
  "definition_id": "tutorial/centrifuge-c",
  "definition_version": "1.0.0",
  "reality": "simulated",
  "configuration": { "initial_temperature": 4 }
}
```

Call it again for centrifuge B with a different name and temperature, such as 20. The Entities have different IDs and independent configurations and observations. Omitting `representation_id` selects the version's Web representation. Sharing resources does not merge instance identities.

A complete definition does not create a built-in centrifuge program binding. Rated speed and initial temperature are not measurements. Without a source report, observations are empty. Capability descriptions do not grant execution permission.

## Publish another version or recover a failure

When you change information, models or state structure, publish an explicit new version. Existing Entities and Recordings retain their original version. Publication does not automatically upgrade them.

Keep `1.0.0`, change only the example's model name and run the script again. The Server returns `409 lab.asset_version_conflict`. The library retains the original information. Restore the description and retry, or publish an explicit new version.

Missing resources, wrong digests, invalid GLB, wrong representation purposes and unsupported field rules produce a specific failure. The complete version remains unpublished. Previous versions remain readable. Cancel with `DELETE /api/v1/lab/asset-resource-uploads/{upload_id}`. This releases only that receipt's reference. Other versions and Recordings continue to protect their bytes.

## Interfaces and validation scope

| Interface                                                      | Purpose                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `POST /api/v1/lab/asset-resource-uploads`                      | Obtain one resource upload capability                          |
| `POST /api/v1/lab/asset-resource-uploads/{id}/complete`        | Verify bytes and stage a resource                              |
| `POST /api/v1/lab/asset-versions`                              | Publish the description and all resource references atomically |
| `GET /api/v1/lab/asset-versions`                               | Read pages; filter exact `asset_id` and `version`              |
| `GET /api/v1/lab/asset-versions/{id}`                          | Read fixed information, representations and resources          |
| `GET /api/v1/lab/asset-versions/{id}/resources/{key}/download` | Obtain a short download capability                             |

Members and full-access Agents manage the organization's shared receipts and versions. Source Machines do not receive these permissions. The library can also import JSON descriptions that reference resources already on the Server. It provides import and readonly queries, without an information editor.

Descriptions are limited to 192 KiB, 128 resources and 32 representations. Each representation supports up to 128 components. Configuration and state use nested JSON Schema with explicit `type`. Supported keywords include `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `const`, and numeric, length and count bounds. Annotations include `title`, `description`, `default` and `unit`. Unsupported keywords fail explicitly, including external and recursive references. Instance configurations follow their adopted schema. Defaults do not become measurements.

GLB uses the existing full decode validation. JSON must parse. PDF and USD receive header checks. URDF is stored as an unverified representation. The resource's `verification` field preserves this scope. Storing physics descriptions does not mean the Server can load or execute them. Existing file and decoded GLB budgets still apply.

[Public HTTP tests](../../tests/server/asset-versions.test.ts) cover fixed versions, independent instances, conflicts, retries, cancellation and retained Recording information. [Real browser tests](../../tests/e2e/lab-complete-assets.spec.ts) cover import, information, download and conflict recovery.

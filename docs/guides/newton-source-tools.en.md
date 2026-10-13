# Export an original Newton scene and sample real state

Use `tools/newton-source/cli.py` with the original IsaacLabTutorial SO-101 scene and existing policy. The tools create owned output directories. They keep the project, Python environment and checkpoint read-only. They do not register a Lab Source, connect to Server or train a policy.

Use an existing Linux/WSL Isaac Lab environment and checkpoint. Validation used Python 3.12, Isaac Lab 3.0.0, Newton 1.6.0rc1 and Warp 1.17.0. It also used MuJoCo/MJWarp 3.12.0, RSL-RL 5.4.1 and a CUDA GPU. USD conversion needs Blender; this run used Windows Blender 5.4.0 Alpha. Ordinary Node/Web startup does not need these dependencies.

## Capture current source state

Run from the repository root. Replace the paths with existing inputs. `capture` performs three policy inference and solver steps. It then stops the program that it created.

```bash
SOURCE_PYTHON=/path/to/IsaacLabTutorial/.venv/bin/python
SOURCE_PROJECT=/path/to/IsaacLabTutorial
SOURCE_CHECKPOINT=/path/to/model_799.pt
SOURCE_BLENDER=/path/to/blender

"$SOURCE_PYTHON" -B tools/newton-source/cli.py capture \
  --project "$SOURCE_PROJECT" --checkpoint "$SOURCE_CHECKPOINT" \
  --steps 3 --output .scratch/source-capture
```

A successful run returns `snapshot` and `baseline` paths. Read `samples.jsonl`. The first `post-reset` contains a valid initial state. The three `post-step` source times are 33,333,333, 66,666,667 and 100,000,000 nanoseconds. These values describe simulation time.

`native-witness.jsonl` independently reads the same instant through Isaac Lab articulation and rigid-object data views. `native-model.json` records stable paths and joint types. The original model has six revolute joints, one fixed joint and two free joints: 20 raw coordinates. Motion supports the six angular coordinates in radians. Body poses describe free-body motion; raw joint values remain keyed by joint identity.

Model readiness alone is not a valid initial state. The sampler uses official RecorderTerm reset/step hooks and refreshes required FK before reading. It saves the authored baseline before the first policy step. Later motion does not rewrite that baseline.

For startup composition in an existing player, add `tools/newton-source` to its Python module path. Set `cfg.recorders = source_adapter.recorders(output_directory, metadata_path, source_run_id)` before creating the environment. The player must provide the output directory and own its cleanup. The factory attaches official RecorderTerms; importing the module alone does not attach them. The standalone `capture` command performs this configuration and owns its output ledger.

## Export Web representations

```bash
"$SOURCE_PYTHON" -B tools/newton-source/cli.py export \
  --scene .scratch/source-capture/source-baseline.usdc \
  --snapshot .scratch/source-capture/current-snapshot.json \
  --source-id 7e99f905-7839-4bf2-80f6-001102031989 \
  --blender "$SOURCE_BLENDER" --output .scratch/source-export

python3 -B tools/newton-source/cli.py validate \
  --manifest .scratch/source-export/scene.json
```

The source ID identifies an independent world configuration. The example is not a credential. Export does not authorize or create Server identities.

The original scene exports four objects: Robot, Vial, Rack and Mat. Robot has seven components. Each other object has one. The ten GLBs use component-local origins. `initial_state` separately records current world poses. Static Mat geometry is included without a physics body.

The manifest retains original paths, hierarchy, purpose and visibility. Its 65 source meshes contain 32 visible meshes, 32 guides and one hidden mesh. Guides and hidden geometry retain their classification and do not appear as ordinary Web geometry. Materials use USD Preview Surface or constant PBR approximations. Web provides lighting. Complex MDL programs are not preserved exactly.

`body_to_visual` compensates for the existing Viewer's centering and floor alignment. Do not bake the world pose into a GLB and apply it again to a Scene Node. `scene_hash` includes authored structure, static placement, physics declarations and resource hashes. Current state and source time do not change that structure hash.

## Provide asset references

Use `--metadata source-metadata.json` to declare stable object keys and exact asset versions. Business category and capabilities remain unknown without a reference.

```json
{
  "root_path": "/World/envs/env_0",
  "objects": [
    {
      "source_path": "/World/envs/env_0/Robot",
      "object_key": "Robot",
      "asset_ref": { "asset_id": "example/so101", "version": "1.0.0" },
      "asset_description": "assets/so101.json"
    }
  ]
}
```

The description path is relative to the metadata file. Its asset ID and version must match the reference. The tool copies the description and its explicit `resources` entries, recording content hashes. The asset import interface validates the full business schema. Geometry does not generate capabilities or observations. Omit `asset_description` when providing only a reference; downstream consumers must resolve its exact version.

## Verify and recover

Use the official GLB decoder and independent USD geometry check:

```bash
LAB_WORLD_SOURCE_PYTHON="$SOURCE_PYTHON" node scripts/verify-newton-source-geometry.mjs \
  .scratch/source-capture/source-baseline.usdc \
  .scratch/source-export/scene.json .scratch/source-export/geometry-report.json
```

Check the report's 32 visible source paths and vertex matches. Valid resources do not prove task success, GUI pause behavior or browser synchronization.

Run `export` once with an incorrect source path. It must identify the failing path and produce no valid `scene.json`. Restore the input and retry with a new output directory. Existing directories are preserved. Failed output and its ledger remain available for diagnosis.

Use `--reset-after 2` to check an explicit source reset. `pre-reset` retains the previous episode's terminal state. The new `post-reset` changes episode identity and clears old results. Global source time continues. Do not interpolate across this boundary. Results remain unknown without an explicit success report.

Each output directory contains `owned-resources.json`. Caches stay inside it by default. `--cache-directory` can reference an explicitly owned cache and records the consumer. Interruption, timeout and failure stop created processes while retaining output and caches. Cleanup does not remove another project's resources or shared caches. RecorderTerm observes state; the application's launcher owns the external program.

If the launcher was forcibly terminated, run `python3 -B tools/newton-source/cli.py cleanup --output <owned-output-directory>`. This entrypoint only reconciles matching recorded processes. It retains evidence and caches and rejects another owner's directory. Linux recovery also checks process start identity against PID reuse. WSL checks native Blender against the recorded job path.

Source: [CLI](../../tools/newton-source/cli.py), [sampling hooks](../../tools/newton-source/source_adapter.py) and [scene export](../../tools/newton-source/scene.py). Source registration and shared observation consume the same manifest and actual state, with separate acceptance.

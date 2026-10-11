# Pin Newton and observe SO-101

Continue from [Recording](recording.md). This chapter uses one SO-101, a vial, a four-hole rack and a mat. Newton/MJWarp solves on Linux or WSL GPU. Two Lab Viewers observe the same Session. Ordinary Node/Web startup needs no Python physics dependencies.

## Pin inputs and the environment

Use CPython 3.12.3, Newton 1.6.0rc1, Warp 1.17.0, MuJoCo/MJWarp 3.12.0 and websockets 15.0.1. The probe and Recording source header record actual versions. This adapter uses Newton directly and starts no Isaac Sim Kit. The header records Isaac Lab when installed, or `null` when absent.

You can use an existing environment read-only. Keep installations and outputs out of existing user projects and environments. Create an owned environment when installation is needed. Run these commands from the repository root:

```bash
uv venv --python 3.12.3 .scratch/newton-env
uv pip install --python .scratch/newton-env/bin/python -r tools/newton-motion/requirements.txt
PYTHONDONTWRITEBYTECODE=1 .scratch/newton-env/bin/python -B tools/newton-motion/prepare.py --output .scratch/newton-scene
```

`prepare.py` checks the ten repository-owned GLBs and recovers the exact physics archive inside the base GLB through the production loader. The archive retains 13 original maker STLs, six follower and five moving derived collision files, licenses and provenance. This step uses no network or new collision generation. Use a new output directory and preserve a failed directory for diagnosis.

Assets come from [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100/tree/a758567c3978dfeefe282ede0500085a48fe8f78/Simulation/SO101). The checked-in descriptions and meshes use its Apache-2.0 publication. Lab Word authors the vial, rack and mat. See [NOTICE](../../tools/newton-motion/scene/NOTICE.md) and [LICENSE](../../tools/newton-motion/scene/LICENSE) for sources and credits. This chapter distributes no uncleared NVIDIA conversion and claims no equivalent dynamics.

## Check the actual GPU first

```bash
PYTHONDONTWRITEBYTECODE=1 .scratch/newton-env/bin/python -B tools/newton-motion/probe.py \
  --base-glb .scratch/newton-scene/base.glb --cache .scratch/newton-probe-cache \
  --steps 120 --output .scratch/newton-probe.json
```

The probe must initialize `cuda:0`, load the fixed scene and execute 120 physics steps. It records dependencies, device, setup, solver, control and batch readback windows. It proves no browser, Recording or grasp acceptance. Diagnose the scene, initial state and drives before changing a failed physical baseline. Keep the contact criteria unchanged.

The base GLB retains a fixed physics ZIP. The loader checks trusted whole-file and archive hashes before allowlisted extraction. Matching extras alone cannot authorize a scene. Missing, transformed or changed archives fail before solver import.

## Install and Start

Follow [Quickstart](../getting-started/quickstart.md) to create Node data and log in. Configure the fixed source before startup:

```bash
LAB_WORD_NEWTON_SESSION=true \
LAB_WORD_NEWTON_PYTHON="$PWD/.scratch/newton-env/bin/python" \
LAB_WORD_NEWTON_SCENE_DIRECTORY="$PWD/.scratch/newton-scene" \
pnpm dev
```

The server owns temporary caches, process ledgers and a shared compilation cache. It manages one local GPU source at a time. Preparation takes no Publisher lease. After readiness, it obtains the lease, epoch and Recording credentials. Existing heartbeat and durable-capture deadlines remain unchanged. You can Stop preparation; parent exit or stdin closure ends its source.

Create a Lab. Import the ten generated GLBs into the Asset Library. Select **Install SO-101 Newton scene** in the Session panel. An Agent key with `lab:full` can also perform the complete installation:

```bash
node tools/newton-motion/install_scene.mjs --server http://127.0.0.1:3000 \
  --lab <lab-uuid> --directory .scratch/newton-scene --output .scratch/newton-install.json
```

Provide the key through `LAB_WORD_API_KEY`. Keep it out of commands and ledgers. The script creates persistent Assets and a Scene Installation. On failure, retain completed assets and the ledger for inspection. It removes no other assets.

Select `so101-vial@1` and Start. Open another authenticated browser for the same Lab. Both viewers should show the same solved link and vial poses. Cameras and selection remain independent. The fixed trajectory supplies joint targets only. Formal robot Command/Task control belongs to the following work.

## Compare three physical moments

Compare stationary, physically lifted and released moments using independent source and Viewer world transforms. Set `LAB_WORD_NEWTON_EVIDENCE_DIRECTORY` to an owned verification directory before startup when needed. The source retains at most 900 raw sampling witnesses with actual contact and state. This explicit measurement mode adds contact and velocity readback; its cost is recorded separately. A stage name describes a target; it does not prove success.

The program keeps the original initial state and vial-local cap centre `z=0.094 m`. It enters horizontally at cap height along the grip axis. Targets close to `0.4 rad`, then `0.3 rad` during lift and `0.2 rad` during held/lower. The internal lift goal is `0.012 m`. Real GPU evidence reached about 9.00 mm rise and passed ten consecutive bilateral control samples above 6 mm. After release, 15 consecutive samples met the seated criteria from step 3448 through 3560. The last sample at step 4320 did not meet those criteria; this validates the measured window, not permanent seating. The trail also records brief shoulder/lower-arm contact at step 968, so it does not establish clearance over the entire path. Viewer and Recording acceptance remains separate.

Native coordinates use right-handed Z-up, metres and XYZW. Wire coordinates use right-handed Y-up, metres and XYZW. Conversion maps native `(x,y,z)` to `(x,z,-y)`. GLB centering remains child-local; the fixed `body_to_visual` correction is composed once. Links share one robot Entity with distinct visual targets. The vial, rack and mat retain independent identities.

Physics runs at 240 Hz; control and reliable selected sampling run at 30 Hz. Each readback batches fixed body/joint keys. Sampling, encoding and writers have separate ownership. Start the same initial conditions with HTTP `live_rate_hz: 15` and `30`. Compare outcomes at identical physics steps. The 15 Hz setting selects fewer live frames; reliable sampling and GPU readback stay at 30 Hz. Correlated lifecycle boundaries always send after exact durable ACKs.

Pause freezes physics and simulation time. Resume continues that state. Reset creates a new Session/Recording from the original snapshot. A later ordinary Start uses the latest saved layout. This fixed profile requires unit visual scale and rejects unsupported scaling.

## Inspect Recording and one failure

Follow [Recording inspection](recording.md) to check integrity, source sequences and events after Stop. The header must identify `newton` and actual software, GPU, driver, profile and live rate. Formal Recording file references retain the archive and every GLB.

Read a retained dependency through:

```text
GET /api/v1/lab/labs/{lab_id}/recordings/{recording_id}/resources/{file_id}
```

Find `file_id` in the manifest's `snapshot.world.assets[*].representation`. The response contains verified original bytes. Recording can supply them after the current Asset or local cache disappears. Foreign files, deleted Recordings and unknown files return controlled 404. The opened stream retains custody during reading; cancellation releases it.

Substitute a same-named GLB with another hash in the installation mapping. Installation must return `lab.newton_representation_mismatch`. A Publisher with a wrong HELLO `scene_hash` cannot inject motion. Restore the fixed files and explicitly Start a new Session. Sources do not reconnect or replay old experiments automatically.

After Stop, verify `cleaned` process ledgers and removed extraction directories. Shared Warp compilation caches and explicit witnesses can remain with their owner and purpose recorded. Actual public and cross-host acceptance requires the later deployment environment; loopback results cannot replace it.

Implementation: [scene generation](../../tools/newton-motion/prepare.py), [trusted loading](../../tools/newton-motion/scene_loader.py), [Newton sampling](../../tools/newton-motion/physics.py), and [independent writer](../../tools/newton-motion/publisher.py).

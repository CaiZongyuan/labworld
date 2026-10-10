# From a Synthetic Publisher to two Lab Viewers

Goal: use one Python Synthetic Publisher to move real GLB objects in two browsers. Each Viewer keeps its own camera and Inspector selection.

Complete [Persistent Labs and objects](persistent-world.en.md) and [Persistent digital assets](persistent-assets.en.md) first. Use the repository Node and pnpm versions, Python 3.10+ with venv and pip, and a desktop browser. Run commands from the repository root. Use Linux or WSL Ubuntu for these Bash and browser verification commands. This local loopback fixture needs no GPU, Newton, or Docker.

## Start isolated test data

Stop previous development services. Start a test instance:

```bash
pnpm install --frozen-lockfile
LAB_WORD_MOTION_FIXTURE=true LAB_WORD_DATA_DIR=.scratch/motion-tutorial-data pnpm dev
```

Open <http://127.0.0.1:5173/lab>. Register a test user and create a Lab named `Synthetic motion`. Import `tests/fixtures/lab/cube.glb` in the asset library. Fill in its name, source, license, and version. Use this asset for one object in the Lab. This adds it to the current Lab asset list.

1. Open **Synthetic motion**.
2. Select the imported GLB and keep `30 Hz`.
3. Click **Prepare and join test session**.
4. Close the dialog and observe 20 new model objects.

The status first waits for a Publisher. Initial preparation registers 20 Entities and Scene Nodes with their initial Placement. Motion frames do not change these records or Registered Location.

Open the same Lab in a second browser tab with the same logged-in user. Click **Synthetic motion → Join existing session**. The second Viewer can select `15 Hz`. Closing the dialog keeps the motion connection open.

## Start the Python Publisher

Create a key with `lab:full` on the **API keys** page. The key must belong to the user who created the fixture. Other members can watch but cannot request its Publisher ticket.

Create an isolated Python environment:

```bash
python3 -m venv .scratch/motion-python
.scratch/motion-python/bin/python -m pip install -r tools/synthetic-motion/requirements.txt
```

Enter the key at the hidden Bash prompt:

```bash
read -rsp 'Lab API key: ' MOTION_API_KEY
export MOTION_API_KEY
```

Find the Lab identity. This command prints only Lab names and UUIDs:

```bash
.scratch/motion-python/bin/python - <<'PY'
import json, os, urllib.request
request = urllib.request.Request('http://127.0.0.1:3000/api/v1/lab/labs',
    headers={'Authorization': 'Bearer ' + os.environ['MOTION_API_KEY']})
with urllib.request.urlopen(request, timeout=10) as response:
    for lab in json.load(response)['data']:
        print(lab['name'], lab['id'])
PY
```

Replace `<lab-uuid>` with the test Lab UUID. Run:

```bash
.scratch/motion-python/bin/python docs/examples/motion-launch.py --lab-id <lab-uuid> --duration 600
unset MOTION_API_KEY
```

The [launch example](../examples/motion-launch.py) reads fixture metadata and requests a one-use Publisher ticket through authenticated HTTP. It passes the ticket to the [Publisher](../../tools/synthetic-motion/publisher.py) on stdin. The ticket does not appear in command arguments. The Publisher and Viewers use the same Node listener port.

Both browsers should show 20 GLB objects moving along smooth paths. Rotate each camera, select an object, and open its Inspector. Camera and selection changes in one tab do not affect the other. Leave the second Viewer during the run, then click **Join existing session**. It receives the current full Snapshot immediately.

## Check the trajectory and boundaries

The Synthetic Publisher samples at 30 Hz. It sends 20 body poses and 6 joint values. Each full binary Snapshot contains 632 bytes. The Viewer maps its receive monotonic clock to simulation rate `1`. It interpolates inside a bounded buffer. Display frame rate and network message rate are separate measurements.

Let `t = sim_time_ns / 1e9` and `phase = i × 0.2`. Body index `i` runs from 0 to 19:

```text
x = (i % 5 - 2) × 1.6 + 0.45 × sin(t + phase)
y = 0.65 + 0.15 × sin(2 × t + phase)
z = (floor(i / 5) - 1.5) × 1.4 + 0.35 × cos(t + phase)
yaw = 0.4 × t + i × 0.1
joint[j] = 0.5 × sin(t + j × 0.2), j = 0..5
```

The wire uses right-handed coordinates, Y up, metres, and XYZW quaternions. Each pose updates the Scene Node root in world space. The centered GLB child offset and static scale `0.35` remain. The [protocol](../../packages/contracts/src/motion/index.ts), [Python codec](../../tools/synthetic-motion/motion_codec.py), and [synthetic trajectory](../../tools/synthetic-motion/synthetic.py) define public contracts.

The Gateway keeps the current frame in memory. Each Viewer has one pending latest slot. Actual WS `bufferedAmount` has a 64 KiB soft budget and 256 KiB hard budget. A Viewer blocked for two seconds disconnects. The soft budget reduces its rate to 15 Hz. Fast Viewers do not wait for slow Viewers.

The fixture requires `LAB_WORD_MOTION_FIXTURE=true` and a loopback server bind. HTTP and WS check the actual connection source and reject proxy forwarding headers. Viewer admission uses a one-use ticket valid for 30 seconds. Scene mapping starts after admission. A separate ticket and fixed route determine Publisher authority.

HTTP DTOs are generated from the [Node routes](../../packages/server/src/lab/motion/routes.ts) through OpenAPI. High-frequency poses do not write the database, `world_clock`, or SSE. Existing HTTP and business SSE keep their responsibilities. Fixture bindings end when the server stops. Registered objects, assets, and initial layouts remain in the test directory.

## Verify the source

Install Chromium once. Run the short check and full acceptance separately:

```bash
pnpm exec playwright install chromium
pnpm test:e2e tests/e2e/lab-synthetic-motion.spec.ts --grep 'motion smoke:'
pnpm test:e2e tests/e2e/lab-synthetic-motion.spec.ts --grep 'motion full:'
```

Both commands use `.scratch/motion-python/bin/python` from the setup above. Set `MOTION_E2E_PYTHON=/absolute/path/python` to use another isolated environment. The runner checks installed websockets against the exact version in tracked requirements.

The [motion profile](../../scripts/e2e-server.mjs) builds the same-origin application and enables the fixture only in its owned backend. It creates isolated data, listener ports, and an observer directory. The backend preload records actual Gateway/WS counters. It does not replace values or block the target. Browser, Publisher, and slow TCP reader owners record and clean their resources. Evidence stays in this run's directory under `.scratch/vnext-m1/`.

The short check covers real Python, two GLB Viewers, admission refusal, raw wire, Object3D trajectories, visible pixels, and socket release. Default `pnpm test:e2e` and `web-journeys` CI select this short motion check. They retain all other profiles.

`motion full:` also covers at least 600 seconds after both Viewers are ready, real slow TCP, stale freeze, independent cameras and selection. It verifies late joins, repeated switches, and resource convergence. This separate full acceptance is mandatory for delivery. The default suite's short check does not cover its long-run assertions. Record the command, source commit, environment, samples, and cleanup receipts.

## Fail once and recover

1. Press Ctrl+C in the Publisher terminal.
2. Observe interrupted or stale status and frozen last trusted poses in both Viewers.
3. Repeat the hidden key prompt and launch command to request a new Publisher ticket and server epoch.
4. Observe a new mapping handshake, then resumed current Snapshots in both Viewers.

After a Viewer error, click **Leave motion**, then **Join existing session**. Reused tickets, old epochs, repeated sequences, or wrong mappings fail explicitly. The Viewer does not interpolate across epochs, time rollback, or long gaps.

To finish, click **Leave motion** in both Viewers. Stop the Publisher, then stop `pnpm dev`. The development supervisor stops its Node and Web processes. The test directory contains this tutorial's persistent assets and objects. Keep it if you need those records.

Synthetic generates deterministic mathematical trajectories. It does not compute physical contact or create production Simulation Sessions or Lab Recordings. Newton, remote deployment, and reliable recording remain later work.

TS/Python golden checks require system Python 3. Set `PYTHON` to override the executable. Normal Node/Web startup and builds remain Python-independent.

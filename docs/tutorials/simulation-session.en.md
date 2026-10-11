# Install a fixed scene and manage a Simulation Session

Goal: explicitly run one fixed scene and observe the same Simulation Session in two desktop Viewers. Each Viewer keeps its camera, selection, and Inspector.

Complete [Persistent Labs and objects](persistent-world.en.md) and [Persistent digital assets](persistent-assets.en.md) first. Use the repository Node and pnpm versions, Python 3.10+ with venv and pip, and Linux or WSL Ubuntu. Run Bash commands from the repository root. They create isolated development data. This chapter uses development synthetic motion. It needs no GPU, Newton, or Docker. Each Session automatically creates a reliable Lab Recording; see [Capture and inspect a Recording](recording.en.md) to read segments, check integrity, and delete it.

## Configure the owned source

Stop your previous development instance with Ctrl+C. Create the Python environment and start the application:

```bash
pnpm install --frozen-lockfile
python3 -m venv .scratch/session-python
.scratch/session-python/bin/python -m pip install -r tools/synthetic-motion/requirements.txt
LAB_WORD_SYNTHETIC_SESSION=true LAB_WORD_SYNTHETIC_PYTHON="$PWD/.scratch/session-python/bin/python" LAB_WORD_DATA_DIR=.scratch/session-tutorial-data pnpm dev
```

Open <http://127.0.0.1:5173/lab>. Register or sign in as an ordinary Member. Create an empty Lab named `Shared Session`. Import `tests/fixtures/lab/cube.glb` in the asset library, with its source, license, and version. Return to the Lab. The installation picker uses the saved asset library and needs no existing Lab object.

Normal Node/Web startup and builds need no Python. The explicit setting enables the loopback development source. The server starts Python only after Start. Its [source supervisor](../../apps/server/src/synthetic-source.ts) owns the process, stdin pipe, and cleanup ledger. It sends the fixed startup conditions once and holds the pipe open. Do not run `publisher.py --startup-stdin` manually. The separate [synthetic fixture tutorial](synthetic-motion.en.md) keeps its own explicit launch contract.

## Install and Start

1. Open **Simulation Session**.
2. Select your imported asset under **GLB model**.
   Use **Load more** if it is on a later page. If the list fails, use **Retry GLB models**.
3. Click **Install fixed scene**.
4. Select the resulting **Scene Installation** and keep `30 Hz`.
5. Click **Start**.
6. Wait for **Running** and **Motion connected**. Close the dialog.

The fixed package is `development-synthetic@1`. Installation creates 20 independent Entities and Scene Nodes, with six joint keys. A second Installation creates different object identities. This chapter does not upgrade packages or create a business Entity for each robot link.

Start fixes the actual saved layout, Installation, assets, parameters, and initial state. The first source frame reproduces that initial state. **Starting** means the server is waiting for it. The server allocates a machine identity, a unique Publisher lease, and its epoch. The Viewer cannot choose an epoch or replace the Publisher.

Open the same Lab in a second browser tab. The Viewer automatically observes the active Session. Open **Simulation Session** and select `15 Hz`. Rotate its camera and select another Entity. Both Viewers show the same Session UUID and source state. Camera and Inspector choices stay independent. **Leave observation** closes only that Viewer subscription. **Observe Session** obtains a fresh ticket. **Close** keeps observation open.

## Pause and Resume

1. Click **Pause** in either Viewer.
2. Wait for **Paused · simulation time and pose frozen**.
3. Keep both Viewers open for several seconds. Open a third tab during Pause.
4. Confirm that all three display the same frozen pose.
5. Click **Resume** and wait for **Running**.

**Pausing** and **Resuming** are accepted requests, not completed source actions. The source sends a new complete boundary frame and a correlated acknowledgement. Pause displays that exact boundary, including at `15 Hz`. It does not freeze an older interpolated pose. The simulation clock stays fixed while heartbeat continues. A paused late join receives the fixed mapping and complete cached pose.

Resume excludes paused wall time. Its trusted boundary starts a new receive-clock segment. Sequence stays increasing within the server epoch. The Viewer does not interpolate across Pause or use duplicate WELCOME to reset its buffer. Motion reception freshness, connection health, and Session lifecycle remain separate.

## Compare Reset and the next Start

1. Pause the Session and note its UUID.
2. Close the dialog. Select an installed object and open **Edit layout**.
3. Change its X Placement and scale, then save the layout.
4. Return to **Runtime**. The Session still uses the original fixed geometry and pose.
5. Open **Simulation Session** and click **Reset**.
6. Wait for the new Session to run. Its UUID changes; its startup snapshot remains the original snapshot.
7. Click **Stop** and wait for **Stopped**. The Viewer returns to the latest saved layout.
8. Click **Start**. This ordinary Start uses the newly saved Placement and scale.

The layout editor previews the next Start. Saving leaves the active simulation fixed. Reset ends and fences the old Session, clears Viewer buffers, and obtains new Session-bound tickets and mapping. It preserves saved Placement and Registered Location. An active Installation cannot silently change object ownership or asset bindings. A refused structural edit leaves it unchanged. Other Lab objects and Device Program Runs retain their own behavior. The Inspector reads live Entity facts.

## Check conflict and denial

Keep the Session running or paused. Stop controls in other tabs. In the authenticated Lab page's browser Console, list the Lab UUIDs:

```js
(await (await fetch('/api/v1/lab/labs')).json()).data.map(({ id, name }) => ({
  id,
  name,
}));
```

Paste the complete function below into that Console. Then call `await checkSessionRefusals('<lab-uuid>')` with the `Shared Session` UUID:

<<< ../examples/session-refusals.js

Expect `{ conflict: 409, denied: 403, unchanged: true, session_id: ... }`. The first request uses a stale revision. The second omits CSRF. Neither changes the Session. The browser and a valid `lab:full` Agent use the same Lab policy. A Core machine credential is independent. It can only use its dedicated Session admission contract.

The dialog shows conflicts, denied access, unavailable source, and offline state. It retains choices. **Retry** reads current authority and reconnects observation. It does not replay Start, Reset, or another accepted action.

## Interrupt and finish

Stop `pnpm dev` with Ctrl+C during a Session. Restart with the same command and data directory. The previous Session reads **Session interrupted**. Explicitly Start a new Session. Restart never resumes an old experiment or replays actions.

If Python is unavailable, Start reports source failure or an interrupted Session. Check the configured executable, restart the service, and Retry. The service uses finite acknowledgement and motion-loss deadlines. Missing acknowledgement, lost heartbeat, or stalled running source fails closed. Deliberate Pause is exempt from running-source progress checks.

To finish, Stop the Session, close its dialog, and stop `pnpm dev`. The supervisor releases its owned source processes and sockets. Its ledgers remain under `.scratch/session-tutorial-data/runtime/synthetic-sources/`. Keep the tutorial data directory and Python environment if needed. Do not remove another worktree's processes or data.

Sources: [Session owner](../../packages/server/src/lab/sessions/service.ts), [HTTP routes](../../packages/server/src/lab/sessions/routes.ts), [SDK lifecycle stream](../../packages/sdk/src/simulation-session.ts), [controls](../../packages/views/src/lab/simulation-session-controls.tsx), [motion buffer](../../packages/sdk/src/motion-buffer.ts), and [body-to-visual correction](../../packages/views/src/lab/motion-scene.ts). Source parameters default to translation amplitude `0.45`, angular speed `1`, and joint amplitude `1`. Start HTTP accepts finite values from `0` to `10` for each. These mathematical trajectories do not compute physical contact.

Continue with [Capture and inspect a Recording](recording.en.md) or [the spatial workbench](spatial-workbench.en.md). Production Newton, remote ingress, and robot tasks remain separate work.

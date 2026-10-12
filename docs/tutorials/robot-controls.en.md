# Control the robot and confirm task results

Continue from [Newton setup](newton-motion.md) and [secure viewing](secure-motion.md). Keep the same Lab, SO-101 installation, and fixed GLB files. Use the current checkout, Node 24, and the Python environment from those chapters. These operations persist Commands, Tasks, and an independent Recording.

Goal: submit Home, six joint targets, or a gripper target. Use two Lab Viewers to distinguish acceptance, physical completion, and cancellation end. This chapter does not provide cross-location Pick & Place.

## Start a controllable scene

1. Configure and start Lab World Server as described in the Newton chapter.
2. Sign in and open **Simulation Session** for that Lab.
3. Select `so101-vial@2`.

   New installations use version 2. An old `so101-vial@1` runs a fixed demo trajectory. With no active Session, select **Enable robot controls**. The upgrade keeps Entities, GLB files, and layout. It does not change a running snapshot.

4. Select **Start**.
5. Wait for **Running** and **Motion connected**.
6. Select SO-101. Open **Robot controls** in the Inspector's **Operations** tab.
7. Open another signed-in browser. Select the same Lab and robot.

Start holds the initial pose and waits for an action. The six links and base still belong to one Entity. A generic robot with only capability definitions has no executable Newton controls. The source must confirm the Runtime Binding before the panel provides actions.

## Submit an action and observe its result

1. Select **Home · initial pose**.
2. Observe **Request accepted · waiting for source receipt**.
3. Wait for **Action completed** under **Current / most recent robot task**.

Home uses `[0,0,0,0,0,0.7] rad`, including the gripper target. The source checks actual joint error and velocity. Ten consecutive 30 Hz samples must meet both limits: error at most `0.02 rad`, and absolute velocity at most `0.05 rad/s`. Sending a target or receiving HTTP `202` does not meet this criterion.

4. Set `so101/shoulder_pan` to `0.2 rad`.
5. Select **Apply six joint targets**.
6. Wait for the source-confirmed result.
7. Set **Gripper target (rad)** to `0.7`, then select **Apply**.

Sliders and inputs edit the target draft. They do not change physics or the world layout. The six joints follow `profile.joint_order` in the Session snapshot. Bounds use the same profile's exact `joint_limits`. The gripper is the sixth revolute joint; its unit is radians. Contact can produce `failed` / `target_not_reached`.

Both Viewers receive states from the same world and task service. The source reports `moving`, `settling`, or `cancelling`. Actual joints, velocity, and source time are Observations. They remain separate from target drafts. The browser does not predict task success.

## Use the formal interface from Node or Python

Get the Lab and robot Entity UUIDs from Inspector **Details**. An Agent needs an active `lab:full` API key created in Settings. A member uses the existing login Cookie and sends `x-csrf-token` for writes. Both identities use the same action path.

Set these variables from the repository root. Replace UUID placeholders with the actual identities:

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID='<lab-uuid>'
export ROBOT_ID='<robot-entity-uuid>'
read -rs LAB_API_KEY
export LAB_API_KEY
export ROBOT_REQUEST_KEY="$(node -e 'console.log(crypto.randomUUID())')"
ROBOT_ACTION=home node docs/examples/robot-controls.mjs
```

The example prints the request key, Command ID, and Task ID. It submits one action, then reads that Task and its result for up to 30 seconds. Success is `completed`; cancellation is `cancelled`. Failed, unknown, or unfinished results cause a nonzero exit. The example does not resend actions.

Complete Node example:

<<< ../examples/robot-controls.mjs

Use the Python standard library for the same operation:

```bash
export ROBOT_REQUEST_KEY="$(node -e 'console.log(crypto.randomUUID())')"
ROBOT_ACTION=home python3 docs/examples/robot-controls.py
```

Complete Python example:

<<< ../examples/robot-controls.py

Create a new request key for each new action. Use `ROBOT_ACTION=joints` with `ROBOT_JOINTS='[0.2,0,0,0,0,0.7]'` for joint targets. Use `ROBOT_ACTION=gripper` with `ROBOT_GRIPPER=0.7` for a gripper target.

| Action            | Request to `POST .../entities/{entity_id}/actions`                             |
| ----------------- | ------------------------------------------------------------------------------ |
| Home              | `{"capability":"robot.home","parameters":{}}`                                  |
| Six joint targets | `{"capability":"robot.move_joints","parameters":{"joints":[0.2,0,0,0,0,0.7]}}` |
| Gripper target    | `{"capability":"robot.set_gripper","parameters":{"position":0.7}}`             |
| Cancel            | `{"capability":"robot.cancel","parameters":{}}`                                |

Read `.../commands/{command_id}` for acceptance and execution. Read `.../tasks/{task_id}` for that Task. Read `.../results/{result_id}` for its result. All paths are under `/api/v1/lab/labs/{lab_id}/entities/{entity_id}`.

## Check busy refusal and Cancel

1. Start a joint target task.
2. Before it ends, submit Home with another new request key.

   The API returns `409` / `lab.device_busy`. The original Task stays unchanged. The Inspector disables new Home, joint, and gripper actions while keeping **Cancel task** available.

3. Select Cancel, or run the example with `ROBOT_ACTION=cancel` and a new request key.
4. Observe **Cancel requested · waiting for end**.
5. Wait for **Cancellation ended**.

Cancel stops the trajectory and holds measured joint positions. Cancellation end does not mean the vial was placed. You can request Cancel while paused; it does not implicitly Resume. If settling needs further physics steps, explicitly Resume, or Stop and check the final result.

Pause freezes simulation time, pose, and task progress. Resume continues the task. Reset ends the old Session and Recording, then creates new identities from the original snapshot. An ordinary Start uses the latest saved layout.

## Recover an unknown result and inspect the Recording

If the HTTP acceptance response is lost, keep the original key and exact parameters. The Inspector provides **Retry same command**. For the CLI, keep `ROBOT_REQUEST_KEY` and explicitly run the same input. The service returns the original Command without a duplicate Task. Changed parameters with the same key return `409` / `idempotency.conflict`. Expired keys return `410` / `lab.command_expired`.

Source loss, server restart, or Recording write failure interrupts unfinished tasks. A disconnect during Cancel can also leave an unknown result. Confirmed completions remain recorded. Do not interpret `unknown` or `interrupted` as successful completion or cancellation. Read the original Command, Task, result, and Recording before explicitly starting a new Session. The service does not replay old actions automatically.

Use the [Recording chapter](recording.md) to read this Session's Recording. Check command acceptance, individual property observations, and Task transitions captured when they occur. Simulation time and server audit time remain separate. Live frames or final database rows cannot replace the complete operation history.

This chapter delivers Home, joint targets, gripper targets, and Cancel. Cross-location Pick & Place, stable destination placement, actual remote hosts, and soak tests need later implementation and acceptance. The earlier 9 mm lift evidence describes only the fixed demo's verified window.

Sources: [control panel](../../packages/views/src/lab/robot-panel.tsx), [formal actions](../../packages/server/src/lab/devices/use-cases.ts), and [Newton controller](../../tools/newton-motion/controller.py).

# Create a source configuration and connect a program

Goal: connect a source before any Scene Installation or Observation Segment exists. The source belongs to the selected Lab. Source Run identity and connection generation are separate. Online describes connection health.

Complete [Quick start](../getting-started/quickstart.en.md) first. Normal Node/Web startup needs neither Newton nor Python. The source client below needs Python 3.10+ and only its standard library. It installs no packages and reads no GPU state. Use a desktop browser to configure access. The existing program owns its execution.

## Create the one-time configuration

1. Sign in at `/lab` and create or select the target Lab.
2. Open **Sources** in the toolbar.
3. Enter a **Source name**, such as `Original SO-101 world`.
4. Click **Create source configuration**.
5. Click **Copy configuration** and save a private JSON file, such as `.scratch/my-source.json`.
6. Close the dialog. The displayed credential clears. Ordinary source queries never return it.

This registers a persistent Lab Source and creates a credential valid for 30 days. The configuration contains the service address and Lab, source and Machine identities. Keep the complete file. Keep its contents out of logs, URLs, Git and public resource ledgers. On Linux/WSL, use `chmod 600 .scratch/my-source.json` to restrict reading.

Reuse this file when restarting the same world. Use a different source configuration for another independent world. **Rotate configuration · revoke previous credential** replaces access and ends the previous connection while preserving source identity. The credential cannot be read again. If lost, generate a new configuration for the registered source.

## Check normal admission first

Run from the repository root:

```bash
python3 -B tools/source-client/presence.py \
  --config .scratch/my-source.json --phase ready --duration 20
```

Return to **Sources**. The source should show **Source connected**, **Adapter ready** and the last heartbeat time. This command only establishes independent presence. It creates no scene or device reports and proves no solver progress. The toolbar continues to show the connected source count when the dialog closes.

After 20 seconds, the client releases its own connection. The interface shows **Source offline**. After an abnormal exit, it shows offline when the last heartbeat is over five seconds old. The recorded heartbeat time stays unchanged. Run the same command again: source identity stays fixed, while run identity and connection generation are separate.

## Load the callback in the original program

Isaac Lab launch entries supporting `--external_callback` can load this repository's lightweight callback. Keep the original launch command and add these settings. Replace `<repo>` with the repository's absolute path and `<private-config>` with the JSON file's absolute path.

```bash
PYTHONPATH="<repo>/tools/source-client:$PYTHONPATH" \
LAB_WORLD_SOURCE_CONFIG="<private-config>" \
<original Python and launch arguments> --external_callback isaaclab_presence.install
```

Keep the program's GUI or headless arguments. The callback works independently of rendering and starts a separate heartbeat thread. Keep the original project and Python environment read-only. No code needs to be copied into that project.

If the original command already has `--external_callback`, save that callback name in `LAB_WORLD_SOURCE_CALLBACK`. Replace the existing option's value with `isaaclab_presence.install`. Do not append a duplicate option or discard the original callback. The original SO-101 evaluation entry uses `isaaclab_tutorial.utils.evaluation.install_episode_counter`:

```bash
LAB_WORLD_SOURCE_CALLBACK=isaaclab_tutorial.utils.evaluation.install_episode_counter \
PYTHONPATH="<repo>/tools/source-client:$PYTHONPATH" \
LAB_WORLD_SOURCE_CONFIG="<private-config>" \
<original Python and launch arguments> --external_callback isaaclab_presence.install
```

Presence calls the original callback first and returns its unconsumed arguments unchanged. Without an original callback, it returns `None`, preserving all Hydra arguments. Overrides such as `presets=newton_mjwarp` and `env.sim.dt=0.0125` remain in the original command. Use `--cfg job` on the normal entrypoint to inspect the resolved configuration first. This mode runs no solver or experiment.

Other Python entries can use `start_presence(config_path)` from [presence.py](../../tools/source-client/presence.py). Keep the returned client. Call `set_phase('ready')` when adapter initialization finishes and `close()` when the program normally ends. Network failure and authorization refusal only update client `status`; they do not stop the caller, model or solver. `close()` releases only this client's connection.

This chapter delivers source presence. Scene extraction, synchronization and live observation require their corresponding integration features. This callback discovers no uninstrumented Newton processes and creates no motion, measurement or experiment results.

## Check refusal and recovery

While connected, click **Revoke source access**. The source should show **Access revoked** and **Source offline**. The next request from the previous configuration is refused. The independent client reports `authorization_failed`. The original program continues running.

Run two clients with the same configuration. The second receives a connection conflict. It waits until the first connection is released or times out; it cannot replace a healthy source. Create another configuration for another independent world.

Generate a new configuration for the registered source and start the client again. Source identity stays fixed. Previous credentials, connection UUIDs and epochs cannot overwrite new state. Expired credentials also require replacement. After Lab World Server restarts, old connections show offline and continuing clients report their presence again.

[Source routes](../../packages/server/src/lab/sources/routes.ts) provide the API and generated SDK. Member/Agent registration, configuration and revocation retain `lab:full` and Cookie/CSRF boundaries. Source credentials access only their own connection in the permitted Lab. Their authentication scope differs from legacy Session Publishers.

Stop your own clients when finished. Keep or remove your own private configuration. Preserve other sources and native services. Use no global process cleanup.

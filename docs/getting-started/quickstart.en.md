# Quick start

Start the Node service and Web application, create an account and open a persistent Lab. Use Linux or Windows with [Node 24.18.0](../../.node-version) and [pnpm 11.17.0](../../package.json).

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
pnpm dev
```

Run commands from the repository root. The service initializes its embedded database and recovery before accepting HTTP. It listens at `http://127.0.0.1:3000`; Web opens at `http://127.0.0.1:5173`. Data stays in `data/` across restarts. The startup output names the owned development-process ledger.

## Open the application

1. Open <http://127.0.0.1:5173/register> and register with a password of 12–128 characters. The first account is Owner; later accounts are Members.
2. Login and registration open Lab. Create a Lab, then open its space.
3. Open Assets, upload a GLB with source, license and version, and wait for validation. The previous valid model stays available after a rejected import.
4. Register an Entity and place its Scene Node in the Lab. Save the layout and refresh; the same Lab and selected Entity can be opened through the address.
5. Continue with the [Lab guide](../guides/lab-viewer.md), [World](../guides/server-world.md) and [Devices](../guides/server-devices.md). Users and Agents share the retained API and backend device programs.

The shared home remains at `/`. Settings and API-key links work at `/settings` and `/api-keys`. Removed-module bookmarks show an unavailable page with a way home.

## Verify and stop

Keep development running and use another terminal:

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/api/v1/system/status
```

Ready responses return HTTP 200 with `x-request-id`; system status reports the applied schema. Press Ctrl+C in the development terminal to drain and stop both processes. Persistent data remains. After an abnormal supervisor exit, use the printed ledger with `pnpm dev:recover <ledger>` before restarting. Preserve active services and unknown data.

Copy [.env.example](../../.env.example) to an untracked `.env` to change Node and Web settings. Node entry commands load that file and Vite reads it from the repository root. See [generated configuration](site:reference/config.md) and [separate directories and ports](../guides/server-foundation.md).

For stopped-service backup, restore into a new or empty directory and password recovery, follow [server operations](../guides/server-operations.md). A forgotten password uses the operator CLI.

```bash
pnpm typecheck
pnpm test:server
pnpm test:frontend
pnpm contracts:check
```

See [development and validation](../testing/t01-feedback-loop.md) for browser checks and complete coverage.

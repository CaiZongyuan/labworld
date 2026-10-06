# Start the TypeScript service foundation

This guide is for developers of Lab Word Server. The current foundation provides health, system status, error envelopes, a persistent database and contract generation. Identity, memberships, API keys, audit, limits and file capabilities are implemented. The Web app can use Core identity, persistent assets, Labs, Entities, Scene Nodes and layouts. Devices, business subscriptions and history remain in migration. Continue with [Platform Core](server-platform.md).

## Get the first result

Use Linux or Windows and the Node 24 and pnpm versions specified by the repository. Run these commands at the repository root. Docker, Rust and an external database are not required.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The service listens on `127.0.0.1:3000` by default. Web uses `http://127.0.0.1:5173`. Vite proxies `/api/v1`, `/api/openapi.json`, `/objects` and `/health` to the new service. Open a second terminal:

```bash
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/api/v1/system/status
```

Both health responses contain `{"status":"ok"}`. System status retains the compatible identifier `labos-threejs-api`. `version` comes from the service package. `schema_version` reports only migrations that were actually applied. If the database or migration metadata is unavailable, readiness and system status return 503 with error code `database.unavailable`.

Press Ctrl+C to stop both development processes. Development data remains in `data/`. The startup output names the development ownership ledger. After an abnormal creator termination, run `pnpm dev:recover <development-owned-resources.json>` to verify and stop only its recorded or marked consumers. This command preserves development data. Restart `pnpm dev` after a service code change. Web continues to use Vite hot updates.

## Use a separate directory and ports

Configuration is implemented in [config.ts](../../apps/server/src/config.ts). This file owns the complete defaults and validation:

<<< ../../apps/server/src/config.ts

Linux shell example:

```bash
LAB_WORD_DATA_DIR=.scratch/my-foundation-data SERVER_PORT=3100 WEB_PORT=5180 APP_ORIGIN=http://127.0.0.1:5180 pnpm dev
```

The same example in PowerShell:

```powershell
$env:LAB_WORD_DATA_DIR = '.scratch/my-foundation-data'
$env:SERVER_PORT = '3100'
$env:WEB_PORT = '5180'
$env:APP_ORIGIN = 'http://127.0.0.1:5180'
pnpm dev
```

Only one process can open a canonical data directory. If a second start fails, preserve the original process and directory. Do not delete the directory to remove exclusivity. The default loopback listener is for local development. Team access requires an HTTPS reverse proxy supplied by the deployment owner.

## Verify failure and recovery

```bash
pnpm typecheck
pnpm test:server
pnpm contracts:m1:check
pnpm check:m1
```

Service tests start real child processes. They verify health, errors, persistence, reopening, microsecond timestamps, transaction rollback, SQL counting and directory exclusivity. The error test requests a missing resource. Its 404 response contains `code`, `details`, `message` and `request_id`. The request ID matches the `x-request-id` response header. Responses use `cache-control: no-store`.

`contracts:m1:check` generates OpenAPI from Zod routes. The existing SDK generator writes to `.scratch/vnext-m1/generated/`. The check compares the 29 migrated paths and 62 recursively referenced schemas, including five file DTOs, compiles a generated caller and confirms that the official contracts and SDK are unchanged. A partial service does not overwrite complete client contracts.

`check:m1` runs service, Web, retained tooling, boundary, bundle and documentation checks. Current CI focuses on Web and does not build or run Electron. The old service, complete business contracts and browser journeys remain pending their migration stages. This command does not claim that Migration Gate has passed.

## Replay the persistence spike

```bash
pnpm spike:server --duration-seconds 1800 --output .scratch/my-foundation-spike
```

This command uses a separate test process and temporary database. It writes 1 Hz samples for 20 synthetic device shapes, keeps two real SSE subscribers and performs concurrent reads and writes. It is not complete Device Program or business SSE acceptance.

The report retains each sample cycle's commit time, acknowledged data, actual SQL statement counts, subscriber counts and resource cleanup receipts. Drift uses the process monotonic clock and a fixed sampling start. The nominal UTC schedule projects the initial wall time. The actual sample timestamp reads wall time for each sample; it is not a queue-delay measurement. Delaying the next cycle cannot hide it. Existing SQL and payload budgets remain in effect. Cold start, directory size and memory are reports only.

Process and data-directory ownership is recorded in `.scratch/vnext-m1/<run>/owned-resources.json`. Normal completion, failures and interruption clean up owned temporary data. After an abnormal termination, confirm that the original creator has stopped, then recover from the receipt:

```bash
pnpm server:recover .scratch/vnext-m1/<run>/owned-resources.json
```

Recovery checks process creation identity, run markers and directory ownership. An active creator, replaced PID, unknown consumer or mismatched directory marker causes a safe refusal. Do not replace these checks with global cleanup or deletion of existing data.

## Database choice and code boundaries

The database uses pinned PGlite 0.5.8 and Drizzle 0.45.3. Effective configuration and Linux/Windows evidence are recorded in [ADR 0011](../adr/0011-pglite-embedded-database.md). Force-kill tests prove acknowledged commits after the tested process termination. They do not prove an operating-system crash or power-loss guarantee.

The [database platform](../../packages/server/src/platform/db/index.ts) owns the driver, migrations and execution queue. Reads, writes and background operations use the same queue. Transactions do not wait for network, file or timer operations. Timestamp columns retain strings with six fractional digits instead of losing microseconds through JavaScript Date.

The [use-case context](../../packages/server/src/platform/context.ts) defines database, clock, BlobStore, audit and event interfaces. The current composition uses the database, clock, local blob storage and Core audit. [FileService](server-files.md) supplies file capabilities. Later modules supply Lab behavior. Domain rules do not depend on Node, Hono or the database driver. Platform Core does not import Lab.

# Web and same-origin hosting

Use the complete Node SDK with the real Lab application. First follow [quick start](../getting-started/quickstart.md) and [server operations](server-operations.md). Run commands from the repository root.

## Development

```bash
pnpm dev
```

Vite serves Web at `http://127.0.0.1:5173` and proxies `/api/v1`, `/api/openapi.json`, `/objects` and `/health` to Node. `/api-keys` and `/settings` remain Web document routes. Authentication uses Session cookies and CSRF; Agents use API keys with the same retained business operations.

## Serve a built application

Stop your development supervisor, then build Web and select a separate data directory:

```bash
pnpm build
LAB_WORD_DATA_DIR=.scratch/hosted-lab SERVER_PORT=3100 APP_ORIGIN=http://127.0.0.1:3100 FILE_PUBLIC_ORIGIN=http://127.0.0.1:3100 LAB_WORD_WEB_DIR=apps/web/dist pnpm start
```

PowerShell:

```powershell
pnpm build
$env:LAB_WORD_DATA_DIR = '.scratch/hosted-lab'
$env:SERVER_PORT = '3100'
$env:APP_ORIGIN = 'http://127.0.0.1:3100'
$env:FILE_PUBLIC_ORIGIN = 'http://127.0.0.1:3100'
$env:LAB_WORD_WEB_DIR = 'apps/web/dist'
pnpm start
```

`pnpm start` runs the compiled service. The build includes its SQL, JSON catalog and WASM codecs; installed dependencies remain pinned by pnpm.

Open <http://127.0.0.1:3100/register>, create an account and open a Lab. Upload a GLB, open it from Assets and refresh the Lab with its selected Entity. Direct document entry at `/api-keys` and `/settings` loads the application. Signed PUT/GET capabilities use the same origin and preserve the verified asset bytes.

`LAB_WORD_WEB_DIR` must contain a built `index.html`. Empty configuration starts an API service. The server serves build files and supplies the Web document for application routes, including unavailable-module bookmarks. Missing API, health and object requests preserve their JSON status/errors. Missing build files also return an error. The static fallback does not turn those failures into an HTML document.

The default listener remains `127.0.0.1`. For team access, provide an HTTPS reverse proxy and set `APP_ORIGIN` and `FILE_PUBLIC_ORIGIN` to that public origin. Ctrl+C drains owned service work; the selected data directory remains. Stop the service before the [backup/restore journey](server-operations.md).

## Generate and verify

```bash
pnpm generate
pnpm contracts:check
pnpm contracts:baseline:check
pnpm typecheck
```

The [generator](../../scripts/generate-contracts.mjs) reads [Node OpenAPI](../../apps/server/src/openapi.ts) and writes the official contracts and SDK. Retained route, DTO, operationId, status/error and security semantics match the migration baseline. The browser consumes this SDK; JSON DTOs have one generated source. The [Lab application](../../packages/views/src/lab/app.tsx) directly declares routes, navigation and messages while heavy views stay lazy.

Owners: [production hosting](../../apps/server/src/web.ts), [configuration](../../apps/server/src/config.ts), [Vite proxy](../../apps/web/vite.config.ts), [router](../../apps/web/src/router.tsx), [generated SDK](../../packages/sdk/src/index.ts) and [owned Node browser supervisor](../../scripts/e2e-server.mjs).

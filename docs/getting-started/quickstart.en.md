# Quick Start

Goal: start the existing Lab Word application and verify HTTP and Web access. Validated Viewer evidence currently comes from a [separate preview](../guides/lab-viewer.md); record production Lab integration acceptance separately.

## 1. Install And Start

Prepare Docker/Compose and the pinned versions: Rust 1.96.0, Node 24.18.0, pnpm 11.17.0 and just 1.58.0. Consult the [Rust toolchain](../../rust-toolchain.toml), [Node version](../../.node-version), [package configuration](../../package.json) and [tool versions](../../.tool-versions).

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

Run from the repository root. The first launch downloads dependencies and compiles Rust. The development script starts PostgreSQL, Redis, RustFS and Mailpit, applies migrations, initializes storage, then runs API, Worker and Web. It writes to local development volumes.

Defaults come from [.env.example](../../.env.example); create an untracked `.env` to override them. See the [generated API configuration](site:reference/config.md).

## 2. Observe The Result

Keep development running and use another terminal:

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/api/v1/system/status
```

Expect HTTP 200 with `x-request-id`. Live reports the running process; ready checks dependencies and migrations; status returns the actual system state.

Open <http://127.0.0.1:5173/register> to create a development account. The first account is Owner; later accounts are Members. Passwords contain 12–128 characters. Read development email at <http://127.0.0.1:8025>. Existing platform behavior exercises authentication and business operations. Lab behavior follows its version's integration acceptance.

## 3. Check Dependency Failure And Recovery

Only in your own development environment, stop PostgreSQL:

```bash
just db-down
curl -i http://127.0.0.1:3000/health/ready
```

Ready should return 503 while live remains 200. Restore the database:

```bash
docker compose up -d --wait postgres
curl -i http://127.0.0.1:3000/health/ready
```

Ready should return 200 again. For migration mismatches, check the source revision and run `just migrate`. API startup does not migrate automatically. After adding SQL, migrate and restart development so the embedded migration set is refreshed.

## Stop And Continue

`Ctrl+C` stops API, Worker and Web; `just services-down` stops containers while retaining volumes. For port conflicts, keep APP_BIND, VITE_API_PROXY and APP_ORIGIN consistent. Database port changes require both POSTGRES_PORT and DATABASE_URL.

Next, [run the Lab Viewer preview](../guides/lab-viewer.md) or read the [project structure](../architecture/project-structure.md). Run documentation with `just docs` at <http://127.0.0.1:5174/labworld/en/docs/>.

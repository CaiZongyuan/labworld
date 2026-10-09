# Quick Start

Goal: start Lab Word and check HTTP and Web access. Current Viewer validation comes from a [separate preview](../guides/lab-viewer.md). Record acceptance of the production Lab integration separately.

## 1. Install And Start

Install Docker with Compose. Use these tool versions:

| Tool | Version | Source                                      |
| ---- | ------- | ------------------------------------------- |
| Rust | 1.96.0  | [Rust toolchain](../../rust-toolchain.toml) |
| Node | 24.18.0 | [Node version](../../.node-version)         |
| pnpm | 11.17.0 | [Package configuration](../../package.json) |
| just | 1.58.0  | [Tool versions](../../.tool-versions)       |

Run these commands to clone the repository and start development:

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

Run project commands from the repository root. The first launch downloads dependencies and compiles Rust. The development script starts PostgreSQL, Redis, RustFS and Mailpit. It applies migrations and initializes storage. It then starts the API, Worker and Web. The script writes data to local development volumes.

Default settings come from [.env.example](../../.env.example). To change them, create an untracked `.env` file. See the [generated API configuration](site:reference/config.md).

## 2. Observe The Result

Keep development running. Run these commands in another terminal:

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/api/v1/system/status
```

Each response should return HTTP 200 and include `x-request-id`.

| Endpoint                | Expected information                   |
| ----------------------- | -------------------------------------- |
| `/health/live`          | The API process is running.            |
| `/health/ready`         | Dependencies and migrations are ready. |
| `/api/v1/system/status` | The current system state.              |

Passwords must contain 12–128 characters.

1. Open <http://127.0.0.1:5173/register>.
2. Create a development account.

The first account is Owner. Later accounts are Members. Read development email at <http://127.0.0.1:8025>.

Use the existing platform to check authentication and business operations. Lab behavior depends on the integration acceptance for its version.

## 3. Check Dependency Failure And Recovery

Run this failure check only in your own development environment.

1. Stop PostgreSQL:

```bash
just db-down
```

2. Check readiness:

```bash
curl -i http://127.0.0.1:3000/health/ready
```

`/health/ready` should return 503. `/health/live` should still return 200.

3. Start PostgreSQL:

```bash
docker compose up -d --wait postgres
```

4. Check readiness again:

```bash
curl -i http://127.0.0.1:3000/health/ready
```

`/health/ready` should return 200 again.

If migrations do not match, first check the source revision. Then run `just migrate`. API startup does not apply migrations automatically.

After you add SQL migrations:

1. Run `just migrate`.
2. Restart development.

The restart updates the migration set in the binary.

## Stop And Continue

Press `Ctrl+C` to stop the API, Worker and Web. Run `just services-down` to stop containers. This command keeps the development volumes.

If you change the API port, update `APP_BIND`. Set `VITE_API_PROXY` to a reachable address for that API.

If you change the Web address, set `APP_ORIGIN` to the browser origin, including scheme, host and port.

If you change the database port, update both `POSTGRES_PORT` and `DATABASE_URL`.

Next, [run the Lab Viewer preview](../guides/lab-viewer.md) or read the [project structure](../architecture/project-structure.md).

To open the documentation:

1. Run `just docs` from the repository root.
2. Open <http://127.0.0.1:5174/labworld/en/docs/>.

# Lab Word

Laboratory digital twin, starting with a Three.js viewer for equipment models.

English | [简体中文](README.zh-CN.md)

## Current Stage

The application includes a preset equipment model, browser-local GLB import, camera controls, click selection and renderer metrics. Lab Viewer and the session-local Asset Library are integrated; follow the [Lab Viewer guide](docs/guides/lab-viewer.en.md) to use them.

The Rust/Axum API, React Web client, Electron shell, identity, membership, files, background jobs and knowledge base provide the foundation. Persistent worlds and server-owned virtual devices are the next stage: the Foundation v1 experience is accepted, and [spec #1](https://github.com/CaiZongyuan/labworld/issues/1) with implementation issues #2–#11 is published. Foundation business implementation has not started.

Start Foundation work with the [developer handoff](docs/handoffs/digital-twin-foundation-v1.md). See also [product architecture](docs/architecture/lab-word.en.md) and the [glossary](CONTEXT.md).

## Run The Application

Install Docker/Compose and the pinned versions in [rust-toolchain.toml](rust-toolchain.toml), [.node-version](.node-version), [package.json](package.json) and [.tool-versions](.tool-versions).

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/register>. `just dev` starts PostgreSQL, Redis, RustFS and Mailpit, applies migrations, initializes storage, then starts API, Worker and Web. Verify readiness with `curl -i http://127.0.0.1:3000/health/ready`.

The first registered account becomes Owner; later accounts are Members. After login, Lab is the default business entry. `just dev-stop` stops this worktree's API, Worker and Web processes; Docker data services are managed separately with `just services-down`. The handoff explains how to run the accepted Foundation preview in its own worktree.

## Documentation

Run `just docs` and open <http://127.0.0.1:5174/labworld/en/docs/>. The Chinese and English documentation explains the current source, runnable tasks and failure boundaries.

- [Quick start](docs/getting-started/quickstart.en.md)
- [Project structure](docs/architecture/project-structure.en.md) and [module boundaries](docs/architecture/module-boundaries.en.md)
- [Lab Viewer and Asset Library](docs/guides/lab-viewer.en.md)
- [Existing platform capabilities](docs/guides/platform.en.md)
- [Testing](docs/testing/t01-feedback-loop.en.md) and [documentation maintenance](docs/guides/maintain-docs.en.md)

API and configuration references are generated from implementation. Docs publishing is configured for the `labworld` repository; see the [publishing guide](docs/getting-started/publish-docs.en.md). Publication is a separate step from local validation.

## Repository Layout

```text
apps/          API, Worker, Web, Desktop and documentation
crates/        Application modules and platform infrastructure
packages/      Contracts, SDK, client core, UI and shared views
migrations/    PostgreSQL schema history
scripts/       Development, validation and operations
docs/          Product documentation, decisions and plans
```

Lab Word builds on [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template). Internal package, database and storage identifiers retain `labos-threejs` for compatibility; the product name is **Lab Word** and the repository slug is `labworld`.

## License

[MIT](LICENSE). Original template attribution is retained.

# Lab Word

Laboratory digital twin, starting with a Three.js viewer for equipment models.

English | [简体中文](README.zh-CN.md)

## Current Stage

The product starts with a preset equipment model, browser-local GLB import, camera controls, click selection and renderer metrics. The [Lab Viewer v1 preview](docs/guides/lab-viewer.en.md) runs these interactions in isolation. The preview is accepted; production integration and validation are pending.

The application contains the inherited Rust/Axum API, React Web client, Electron shell, identity, membership, permissions, files, background jobs and knowledge base. Production Lab integration is in progress and awaits acceptance. Live equipment data and scene placement editing are future work.

See the [development plan](docs/plans/lab-viewer-m0.md), [product architecture](docs/architecture/lab-word.en.md) and [glossary](CONTEXT.md).

## Run The Application

Install Docker/Compose and the pinned versions in [rust-toolchain.toml](rust-toolchain.toml), [.node-version](.node-version), [package.json](package.json) and [.tool-versions](.tool-versions).

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/register>. `just dev` starts PostgreSQL, Redis, RustFS and Mailpit, applies migrations, initializes storage, then starts API, Worker and Web. Verify readiness with `curl -i http://127.0.0.1:3000/health/ready`.

The first registered account becomes Owner; later accounts are Members. This runs the existing application. To inspect the separate 3D preview, follow the [Lab Viewer guide](docs/guides/lab-viewer.en.md).

## Documentation

Run `just docs` and open <http://127.0.0.1:5174/labworld/en/docs/>. The Chinese and English documentation explains the current source, runnable tasks and failure boundaries.

- [Quick start](docs/getting-started/quickstart.en.md)
- [Project structure](docs/architecture/project-structure.en.md) and [module boundaries](docs/architecture/module-boundaries.en.md)
- [Lab Viewer preview](docs/guides/lab-viewer.en.md)
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

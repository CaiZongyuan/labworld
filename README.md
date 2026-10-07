# Lab Word

Laboratory digital twin with a Three.js workbench and server-owned device programs.

English | [简体中文](README.zh-CN.md)

The application includes persistent Labs, assets, Entities, Scene Nodes, saved layouts, observations, Commands, Tasks, records and trends. Users and Agents share the retained HTTP/SSE contract. A single Node service owns the embedded database, local file bytes and runtime; the React Web application consumes its generated SDK.

The migration is in progress under [#45](https://github.com/CaiZongyuan/labworld/issues/45). Frozen Rust and container sources remain until final cleanup; ordinary development and official contract generation use Node. See [product architecture](docs/architecture/lab-word.en.md) and [domain vocabulary](CONTEXT.md).

## Run the application

Use Linux or Windows with the pinned [Node](.node-version) and [pnpm](package.json).

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/register>. The first account becomes Owner; later accounts are Members. Login opens Lab. The Node service listens on `127.0.0.1:3000`; check `curl -i http://127.0.0.1:3000/health/ready`. Ctrl+C drains both development processes and preserves `data/`.

Copy [.env.example](.env.example) to an untracked `.env` to configure Node and Web. The startup output names its owned development ledger; after an abnormal supervisor exit, `pnpm dev:recover <ledger>` stops only recorded consumers and preserves persistent data.

## Documentation and checks

```bash
pnpm docs:dev
pnpm typecheck
pnpm test
pnpm contracts:check
```

Open <http://127.0.0.1:5174/labworld/en/docs/> for bilingual guides.

- [Quick start](docs/getting-started/quickstart.en.md) and [Lab](docs/guides/lab-viewer.en.md)
- [Node service foundation](docs/guides/server-foundation.en.md), [World](docs/guides/server-world.en.md) and [Devices](docs/guides/server-devices.en.md)
- [Backup, restore and password recovery](docs/guides/server-operations.en.md)
- [Web and same-origin hosting](docs/guides/server-web.en.md)
- [Project structure](docs/architecture/project-structure.en.md) and [verification](docs/testing/t01-feedback-loop.en.md)

API and configuration references come from the official Node contract and running configuration parser. See the [publishing guide](docs/getting-started/publish-docs.en.md) for the separate docs publication workflow.

```text
apps/          Node service, Web, shared Desktop source and documentation
packages/      Server domains/platform, contracts, SDK, client core, UI and views
scripts/       Development, validation and operations
docs/          Guides, domain vocabulary, decisions and plans
```

Lab Word builds on [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template). Internal identifiers retain `labos-threejs` for compatibility; the product is **Lab Word** and the repository slug is `labworld`.

[MIT](LICENSE). Original template attribution is retained.

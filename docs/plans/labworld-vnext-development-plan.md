# Lab Word vNext 开发与迁移总纲

> 版本：v2.0
> 日期：2026-10-05
> 状态：已完成 grill，作为后续 spec 与 tickets 的输入；数据库选择（[ADR 0011](../adr/0011-pglite-embedded-database.md)）待 M1 spike 定案。
> 目标：把当前 `Axum + PostgreSQL + Redis + RustFS + Worker + Docker Compose` 后端迁移为单个 TypeScript 服务进程，并保持既有行为不变；随后恢复暂停中的产品工作，再进入数字孪生阶段。

术语以 [CONTEXT](../../CONTEXT.md) 为准；暂停现场与跨票合同见 [PM 工作台暂停交接](../handoffs/pm-workbench-refactor-pause-2026-10-05.md)。

---

## 0. 一页结论

Lab Word 是实验室数字孪生产品，核心是 **Lab World Model** 与 **实验室运行信息底座**：组织实验室对象、关系、能力、状态与操作记录，供人和 Agent 理解及访问同一个实验室世界。真实设备控制、机器人执行属于后续阶段，现阶段不以控制平面定位。

本计划分三段，每段有独立门禁：

1. **迁移**：Rust 后端换成单个 TypeScript 服务进程 **Lab Word Server**，删除 Rust、Docker 及全部相关内容。只验收“行为一致”，不加新功能。→ Migration Gate
2. **产品恢复**：在新架构上完成 #29–#40。→ Product Completion Gate
3. **数字孪生**：本计划只记录方向；开始前单独走 grill → spec → tickets。

### 技术决策

| 领域 | 决策 |
| --- | --- |
| 语言 | TypeScript；Python 只用于未来的 Isaac Sim 扩展 |
| Web | React + TanStack Router + TanStack Query + Three.js（现有，保留） |
| 服务 | 单个 Node 24 进程 Lab Word Server；Hono 只作为 HTTP 适配层 |
| 合同 | Zod 声明 → OpenAPI → `@hey-api/openapi-ts` 生成 SDK（沿用现有生成链路） |
| 数据访问 | Drizzle，PostgreSQL 方言 |
| 数据库 | PGlite + Node 文件系统（ADR 0011，proposed）；spike 失败则改用随 npm 分发的原生 PostgreSQL |
| 文件 | 本地数据目录，按 SHA-256 内容寻址；数据库只存元数据 |
| 后台工作 | 进程内调度器；删除独立 Worker 与通用任务队列 |
| 设备程序 | 服务端运行，语义不变（[ADR 0006](../adr/0006-server-owned-virtual-device-programs.md)） |
| 实时 | SSE，沿用现有世界订阅合同 |
| 限流 | 进程内实现，沿用现有限额 |
| 邮件 | 移除；密码由服务端命令重置 |
| 部署 | 默认只监听 `127.0.0.1`；团队访问由部署方提供 HTTPS 反向代理；不提供镜像 |
| 桌面 | Electron 壳连接 Lab Word Server（现状） |
| 移除 | Rust、Cargo、Redis、PostgreSQL 服务器、RustFS、Mailpit、Caddy、可观测性栈、全部 Docker 配置、`just` |
| 推迟 | Browser Standalone、Electron 内嵌服务、Cloudflare、数字孪生实现 |

### 开发体验

```bash
pnpm install
pnpm dev
```

不需要 Docker、PostgreSQL、Redis、RustFS、Mailpit、Rust 工具链或 `just`。

---

## 1. 已确认的决策

2026-10-05 grill 的结论。需要长期追溯的取舍写在 ADR，术语写在 CONTEXT。

| # | 决策 | 记录 |
| --- | --- | --- |
| 1 | 产品名保持 Lab Word，`labworld` 只是仓库名；定位用 Lab World Model + 实验室运行信息底座，不用 Control Plane | CONTEXT |
| 2 | 只保留 Lab 与 Platform Core；移除知识库、示例组装与删例、通知、通用任务队列、邮件；彻底移除 Rust、Docker 及相关内容 | [ADR 0009](../adr/0009-lab-word-product-only.md)、[ADR 0010](../adr/0010-single-typescript-lab-word-server.md) |
| 3 | 设备程序完全沿用 ADR 0006：服务端运行、按程序频率持久化 Observation、重启后标记 interrupted、由用户显式重启 | ADR 0006 |
| 4 | 模拟与真实设备保持独立 Entity，用“模拟对应”关系关联 | [ADR 0007](../adr/0007-separate-simulated-and-physical-entity-identities.md) |
| 5 | Browser Standalone 移出本计划；保留浏览器计算原则和“领域规则不依赖 Node API”的约束 | CONTEXT、§4.4 |
| 6 | 迁移期冻结产品票；Migration Gate 只验收行为一致；#29/#30 进入产品恢复第一波 | §6、§9 |
| 7 | 旧开发数据不迁移；旧 Docker 卷在用户明确授权前保留 | §5.6 |
| 8 | 先写 TypeScript 黑盒 HTTP 合同测试并在 Rust 栈跑绿，再让新实现通过同一套测试 | §6 M0、§7 |
| 9 | 数字孪生只记录方向，DT0 前单独 grill → spec → tickets | §10 |
| 10 | SaaS Core 改称 Platform Core，Core 不引用 Lab | CONTEXT |
| 11 | 服务进程命名为 Lab Word Server | CONTEXT |
| 12 | 默认只监听 `127.0.0.1`，团队访问用部署方的 HTTPS 反代，不提供镜像 | ADR 0010 |
| 13 | Electron 保持壳形态；内嵌服务的一体化桌面版是 Gate 之后的产品票 | §6 M5、§9 |
| 14 | 移除邮件密码重置，Gate 内提供服务端命令重置密码 | ADR 0009 |
| 15 | 备份归档改为服务端命令：停服、清单校验、只恢复到新目录；删除 compose 时代的运维术语 | CONTEXT、§5.7 |
| 16 | 服务端代码按业务模块组织，而不是按技术层拆包 | §4.3 |
| 17 | 迁移期 OpenAPI 差异必须为空（被移除模块除外） | §6 M5、§7 |
| 18 | Rust/Docker 只读保留到新栈通过合同测试，之后一次删除并打 tag | ADR 0010、§6 M6 |

---

## 2. 当前基线

核对时间：2026-10-05。

### 2.1 代码与交付状态

- `main` 为 `8bc9c3f`。Foundation V1（#2–#11）已交付；工作台 #26、#27、#28 已集成；PR #44（趋势 SQL 计量维护）已合并；workflow 与 skill 改动已在 `1707c82` 提交。
- #29、#30 有未提交的实现，保存在各自 worktree 及 `refs/handoffs/20261005T040315Z-pm-pause/*`；#31–#40 未开始。#29–#40 均为 OPEN。
- Rust 约 4 万行，其中测试约 2.2 万行；28 个 migration。业务模块行数：Lab 5.4k、知识库 3.4k、身份 1.2k、文件 1.0k、任务队列 0.9k、限流 0.6k、API key 0.5k、组织 0.5k，其余较小。前端 TypeScript 约 4 万行，Playwright spec 27 个。

### 2.2 现有基础设施的实际职责

| 组件 | 实际职责 | vNext 去向 |
| --- | --- | --- |
| Redis | 注册、认证与资源请求限流；知识库文档的可选缓存 | 限流改为进程内；缓存随知识库移除 |
| RustFS | 资产、附件与导出的对象存储；签名上传与下载 | 本地内容寻址存储；签名链接改指向服务自身 |
| Worker | 密码重置邮件、文件清理与重扫、知识库清理与导出、任务结果通知 | 文件清理与重扫进入进程内调度；其余随模块移除 |
| Mailpit / SMTP | 密码重置邮件 | 移除 |
| PostgreSQL 行锁 | Lab 运行时、世界版本、布局、资产、保留清理等十余处 `FOR UPDATE` | 单连接串行执行器（§5.2） |
| 任务队列 | `FOR UPDATE SKIP LOCKED`、lease、heartbeat、fencing | 移除 |
| 服务器统计（#44） | 趋势等 SQL 语句预算的计量 | 执行器内语句计数 |
| Caddy、`compose.production.yaml`、Dockerfile | 生产部署与 HTTPS | 移除；同源静态资源由服务托管 |
| OpenTelemetry 采集与 Prometheus/Loki/Tempo/Grafana | 可观测性 | 移除；保留结构化日志与 request ID |
| 世界订阅 | SSE：先快照后版本化更新，单事件 1 MiB、8 条待发，周期复核凭据 | 外部语义不变，内部改为进程内事件通知 |

### 2.3 迁移必须保持的行为

这些行为是合同测试的范围（§6 M0）：

- **Foundation V1（#2–#11）**：持久资产库与 GLB 校验；Lab 与独立 Entity；两台照明的命令—观测闭环；布局、登记位置与保存冲突；1Hz 传感器与新鲜度；离心任务与重启后的 interrupted；实时同步与断线恢复；历史查询与保留清理；归档与外观替换；综合旅程与参考负载。
- **工作台（#26–#28）**：`/lab` 默认显示真实三维空间；Lab 混合记录 API；有界趋势 API。
- **Platform Core**：注册、登录、会话与 CSRF；成员管理；API key 与 Agent 认证；文件生命周期；审计；幂等；限流；`/health/live` 与 `/health/ready`。

跨票合同（暂停交接第 1–5 条）同样不得放宽，要点如下：

1. Lab、Entity、Scene Node 身份稳定；Command 被接受不等于真实 Observation。
2. 当前观测要同时满足值、时效与 source time、good 质量、当前 Binding、运行中的 Device Program Run；旧来源、旧 Run 的最后值可以展示，但不能当作当前可信实时值。
3. 趋势不跨缺口连线，不伪造聚合值；真实 `received_at` 排序，保留来源、单位、质量、Binding 与 Run。
4. 既有容量、CSRF 与身份撤销、SSE 限制、1000 Entity/1000 Scene Node、记录与趋势上限、包体预算不因迁移放宽（§8.1）。

暂停交接第 6–8 条（个人进度、receipt、guide）属于尚未交付的票，在产品恢复阶段适用。

---

## 3. 范围

### 3.1 移除清单

由 M6 一次执行。确切路径在删除票里用 `rg` 盘点，以下是类别和已知位置：

- **Rust**：`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`crates/`、`apps/api/`、`apps/worker/`、`target/`，以及 `.tool-versions` 中的 Rust 项。
- **容器与部署**：`compose.yaml`、`compose.production.yaml`、`compose.observability.yaml`、`.dockerignore`、`deploy/`。
- **旧迁移**：`migrations/` 下 28 个文件，只在 tag 中保留，不建 `legacy/` 目录。
- **脚本**：依赖 Docker、Rust、Redis、RustFS、Mailpit 或 compose 的脚本，例如 `migrate.mjs`、`worker.mjs`、`bootstrap-storage.mjs`、`test-backend.mjs`、`test-storage.mjs`、`production-*.mjs`、`observability.mjs`、`knowledge-observability-smoke.mjs`、`perf-query-plans.mjs`，以及 `scripts/lib` 中对应的工具；`justfile` 由 `pnpm` 脚本取代。
- **业务**：知识库前后端（库、授权、文档、附件、导出、删除）、通知、密码重置页面、示例组装与删例工具及其测试。
- **E2E**：知识库、附件、导出、删除、任务恢复、密码重置相关的 spec，按实际内容逐个核对。
- **配置**：`.env.example` 中 PostgreSQL、Redis、S3、Mail、Worker、Export、Telemetry 相关项。
- **文档**：模板教程（实现自己的业务、移除示例）、知识库教程、Docker 与 `just` 相关说明；保留的文档改写为新命令。
- **CI**：`.github/workflows` 中 Rust、容器与可观测性相关的 job。

### 3.2 本计划不做

- Browser Standalone（推迟到独立 spec）；
- 多实例、服务器数据库、Enterprise 部署；
- 任何 Docker 镜像或容器化打包；
- Cloudflare 的任何运行时依赖；
- 旧数据迁移；
- 迁移期的 DTO 或路由改进；
- Electron 内嵌服务；
- 邮件能力；
- 微服务、Kubernetes、为假想的未来数据库预先设计多实现 Repository；
- 数字孪生的实现；
- 重写已经可复用的 React/Three.js 界面。

---

## 4. 目标架构

### 4.1 Lab Word Server

```text
Browser / Electron 壳 / Agent
            │  HTTP + SSE（生成 SDK 或 API key）
            ▼
┌────────────────────────────────────────────┐
│ Lab Word Server（单个 Node 进程）             │
│                                            │
│  Hono：会话/CSRF、校验、OpenAPI、错误映射、SSE  │
│  Platform Core 模块                         │
│  Lab 模块                                   │
│  设备程序运行时（ADR 0006）                   │
│  进程内调度：保留清理、文件清理与重扫            │
│  数据库串行执行器 → PGlite                    │
│  BlobStore → 本地文件                        │
└────────────────────────────────────────────┘
            │
          data/
```

Lab Word Server 是权威状态与安全边界。浏览器关闭不影响设备程序；服务重启按 ADR 0006 处理中断。

### 4.2 网络与部署

- 默认监听 `127.0.0.1`。生产由服务同源托管 Web 构建产物，会话 cookie 继续依赖同源。
- 开发时 Vite 把 API 请求代理到服务，沿用现有 `VITE_API_PROXY` 思路。
- 生产形态：`pnpm build` 产出 Web 静态资源和服务端产物，运行时只需要 Node 与数据目录。
- 团队或局域网访问需要部署方自备 HTTPS 反向代理；文档写明这个要求，仓库不维护代理配置或运行栈。

### 4.3 仓库结构

```text
apps/
  web/          React / TanStack / Three.js（现有）
  server/       组合根：配置、进程生命周期、Hono app、静态资源托管、CLI
  desktop/      Electron 壳（现有）
  docs/         VitePress 文档站（现有）

packages/
  server/       服务端业务，按模块组织
  contracts/    由 OpenAPI 生成的公共类型（现有，来源改为 Hono）
  sdk/          由 OpenAPI 生成的客户端（现有）
  core/ ui/ views/   现有前端包

tests/
  contract/     黑盒 HTTP 合同测试
  e2e/          Playwright（现有）
  desktop/ frontend/ tooling/ fixtures/ support/   现有
```

`packages/server/src` 按模块划分，命名对应现有 Rust 模块，方便逐个对照迁移：

```text
platform/  db（PGlite 启动、串行执行器、语句计数、迁移）
           blob-store  clock  scheduler  http（错误信封、request ID）
core/      system  identity  organization  api-keys  files  audit  idempotency  rate-limit
lab/       assets  world  layout  relationships  devices  runtime  sync
           history  records  trends  lifecycle
```

每个模块在自己的目录内包含领域规则、用例、Drizzle 表结构和 Hono 路由。并行开发时，一条轨道只改自己的模块目录（§11）。

### 4.4 依赖规则

由改写后的 `check-boundaries.mjs` 检查 TypeScript import 图：

- `core/*` 不引用 `lab/*`。
- 领域规则不引用 `node:*`、Hono、Drizzle 或 PGlite，为以后的 Browser Standalone 保留可移植性。
- 路由只调用用例；用例通过上下文获得数据库、时钟、BlobStore、审计与事件发布。
- 只有 `platform/db` 直接接触 PGlite。
- 设备程序运行时、调度器与路由调用同一批用例，不各自实现业务规则。
- 前端只通过生成的 SDK 访问服务。

### 4.5 Hono 的定位

Hono 是 Lab Word Server 的 HTTP 适配层，负责：

- HTTP 路由；
- 会话与 CSRF；
- 请求校验；
- OpenAPI；
- 错误映射；
- SSE；
- 组合。

业务状态机不属于 Hono。同一个用例可以由三种入口调用：路由、设备运行时或调度器、测试。

### 4.6 合同链路

路由用 Zod 声明请求与响应，生成 OpenAPI，再由现有 `scripts/generate-contracts.mjs` 生成 `packages/contracts` 与 `packages/sdk`。整条链路和现在相同，只是 OpenAPI 的来源从 Rust 换成 Hono。

路径、operationId、tag、状态码与错误信封都与现有 OpenAPI 保持一致，所以前端业务代码不需要随迁移改动。

---

## 5. 数据与文件

### 5.1 数据库选择

默认使用 PGlite（ADR 0011，proposed），理由：

- 没有原生依赖，Linux/Windows/macOS 行为一致；
- 保留 PostgreSQL 方言，现有表结构、约束与 jsonb 语义可以直接沿用；
- 为以后的 Browser Standalone 保留同一个数据库。

M1 spike 的判据见 §6 M1。spike 失败时改用随 npm 分发的原生 PostgreSQL，Drizzle 方言与迁移不变，只替换 `platform/db`。

### 5.2 单连接串行执行模型

PGlite 只有一个连接，服务端据此约定：

- 一个数据库实例、一个执行队列。所有读写（包括只读查询）都排队执行。
- 事务必须短。事务内不等待网络、文件或定时器；文件字节先写入 BlobStore 临时文件，再用短事务登记。
- 原有 `FOR UPDATE` 行锁不再承担正确性。并发冲突继续由显式版本检查表达：布局版本、世界版本、`expected_revision`、幂等键。这些检查本身是 HTTP 合同的一部分，必须保留。
- 执行器记录每个请求和每次后台操作执行的 SQL 语句数，供性能合同使用。
- 所有查询都受现有上界约束，不得引入无上界扫描；否则一条长查询会阻塞设备采样和全部请求。

### 5.3 数据目录

```text
data/
  pgdata/    数据库文件
  blobs/     内容寻址文件：<sha256 前缀>/<sha256>
  tmp/       上传与写入中的临时文件
  backups/   备份归档
  logs/      结构化日志
```

开发默认使用仓库内的 `./data`（加入 `.gitignore`）。测试、合同测试和负载报告各自使用独立的临时数据目录，跑完即删除。服务启动时对数据目录加锁，防止两个进程同时打开。

### 5.4 文件存储

- GLB、HDR、纹理、USD 等大文件的字节不进数据库。数据库只存 `file_id`、hash、size、mime、相对位置、状态与元数据。
- 写入流程：流式写入 `tmp/` → 计算 SHA-256 并校验大小与格式 → fsync → rename 到 `blobs/` → 短事务登记为 ready。
- 现有 FileService 生命周期保留：上传会话、ready 状态、默认 20 MiB 上限（可配置）、确认没有引用后才进入清理。
- 签名上传与下载链接的响应形态不变（URL 与过期时间），只是目标从 RustFS 换成服务自身的签名路由。
- 清理与重扫由进程内调度器执行。

### 5.5 Schema 策略

- 不逐条复制 28 个旧 migration：读取最终 schema 和行为合同，按模块编写 Drizzle schema。
- 迁移期由 drizzle-kit 生成迁移，允许重建；M6 前压缩为单一的 `0000_baseline`，之后只追加。
- 不包含被移除模块的表：知识库、通知、任务队列、密码重置、邮件材料、导出。

PostgreSQL 特有用法的处理：

| 用法 | 处理 |
| --- | --- |
| `FOR UPDATE` 行锁 | 由串行执行器取代，保留版本检查 |
| `SKIP LOCKED`、lease、heartbeat、fencing | 随通用任务队列移除 |
| 服务器统计计数（#44） | 改为执行器语句计数 |
| `lab.` 等 schema 限定表名 | spike 验证后保留 |
| 服务端 UUID 生成 | spike 验证；不可用时由应用生成 |
| jsonb、约束、索引、CTE、`RETURNING` | 保留 |
| 连接池配置、Redis 缓存、Docker 健康检查 | 删除 |

### 5.6 旧数据

旧数据不迁移，删除草案中的 `legacy-postgres-to-pglite` 脚本。

根项目的四个服务容器（postgres、rustfs、redis、mailpit）和持久卷 `labos-threejs_postgres-data`、`labos-threejs_rustfs-data`、`labos-threejs_rustfs-logs` 保留到用户明确授权删除。M0 使用 Docker 时，按 AGENTS.md 的资源规则登记并清理本次创建的临时资源。

### 5.7 备份与恢复

- **`backup` 命令**：要求服务已停止（检测数据目录锁）。打包数据库文件和被数据库引用的 blobs，生成清单（文件列表、大小、SHA-256、schema 版本、生成时间）。核对“数据库登记为 ready 的文件都存在且哈希一致”，不一致则失败并报告。
- **`restore` 命令**：先校验清单，然后只恢复到不存在或为空的新数据目录，不原地覆盖。
- 归档不含密钥。会话密钥等由部署配置提供。
- 恢复演练是常驻测试：备份 → 恢复到临时目录 → 启动 → 合同测试抽样通过。

---

## 6. 迁移阶段

每个阶段完成后再进入下一阶段。M2、M3 内部可以按模块并行（§11）。

### M0 — 冻结与合同测试基线

- **冻结**：Rust 不再增加业务，#29–#40 不开工。唯一允许的 Rust 改动是为黑盒测试暴露测试专用配置，且不改变生产默认值。优先使用现有配置项（如保留期环境变量）和真实的进程重启。
- **编写 `tests/contract/`**：
  - 用 TypeScript + Vitest 编写。harness 负责启动、停止、重启被测服务，并为每个被测服务准备独立数据；目标服务通过配置切换。
  - 覆盖 §2.3 的全部范围。每条用例标注来源票号，汇总成 `tests/contract/behavior-matrix.md`。
  - 只通过公开 HTTP/SSE 交互；ID 与分页游标视为不透明值，只验证往返一致。
  - 在合同测试中断言可观察的预算：响应字节、点数、分页上限、时间范围。SQL 语句预算两边的测量方式不同，属于服务端内部测试。
- **在 Rust 栈上全部跑绿**：这是最后一次使用 Docker。
- **保存 `tests/contract/api-baseline.json`**：Rust OpenAPI 去掉被移除模块后的版本，作为 M5 差异比对的基准。

完成标准：合同测试在 Rust 栈全绿；behavior-matrix 覆盖 §2.3 全部条目，未覆盖的缺口逐条记录。

### M1 — TypeScript 基础与 PGlite spike

建立：

- `apps/server` 与 `packages/server` 骨架：配置、Hono 组合、Zod 校验、与现有一致的错误信封、request ID、结构化日志、`/health/live` 与 `/health/ready`；
- `platform/db`：PGlite 启动、串行执行器、语句计数、Drizzle 迁移运行器；
- 把 OpenAPI 生成接入 `generate-contracts.mjs`；
- 合同测试 harness 能启动新服务；
- 改写后的边界检查（§4.4）。

PGlite spike 的判据：

1. 现有最终 schema 可以载入，包括 schema 限定名、jsonb、约束和部分索引。
2. 20 台 1Hz 设备形态的合成写入、两个 SSE 订阅和并发写请求持续运行至少 30 分钟。期间现有 Lab 预算达标，采样时间漂移不超过一个采样周期。
3. 在写入循环中强制终止进程，重复至少 20 次。每次都能重新打开数据库，已确认提交的数据完整。
4. Linux 与 Windows 各跑通一次启动、迁移和合同测试子集。
5. 记录冷启动时间、数据目录体积与内存，只作报告，不设门槛。

判据全部通过，ADR 0011 改为 accepted；任一项失败，则切换到备选数据库并更新 ADR。

完成标准：`pnpm install`、`pnpm dev`、`pnpm test`、`pnpm typecheck` 都不依赖 Docker；spike 结论已写入 ADR 0011。

### M2 — Platform Core

按顺序迁移：

1. system 与健康检查；
2. identity：注册、登录、会话、CSRF；
3. organization 与 membership；
4. api-keys 与 Agent 认证；
5. audit；
6. idempotency；
7. rate-limit（进程内）；
8. files 与 BlobStore：上传会话、签名链接、清理、重扫；
9. scheduler；
10. `reset-password` 命令。

每个切片的完成定义：用例、表结构、路由、OpenAPI 齐备；对应的合同测试在新栈通过；服务端内部测试（含语句预算）通过。不要先迁完所有表再做 API。

### M3 — Lab

按顺序迁移：

1. Assets；
2. Labs、Entities、Scene Nodes；
3. Relationships、Layout 与保存冲突；
4. Runtime Binding 与 Device Program（`light.v1`、`sensor.v1`、`centrifuge.v1`）；
5. Device Command、Device Program Run、Device Task；
6. Observation 与新鲜度；
7. 世界订阅 SSE；
8. History 与保留清理；
9. Records；
10. Trends；
11. 归档与外观替换。

完成定义与 M2 相同。设备程序语义严格按 ADR 0006。

### M4 — 进程生命周期与运维命令

启动顺序：

```text
锁定数据目录
→ 打开数据库并迁移
→ 恢复：运行中的 Run 与未结束的 Task 标为 interrupted；不重放已提交的 Command；按幂等与 receipt 规则恢复
→ 启动调度器
→ 设备运行时可用
→ 世界订阅
→ HTTP 监听
```

关停顺序：停止接收新请求 → 结束 SSE → 停止调度 → 关闭数据库 → 释放锁。

运维命令通过统一入口提供：`migrate`、`backup`、`restore`、`reset-password`。

测试：重启相关的合同测试（中断标记、结果保留、不重复执行），以及备份恢复演练。

### M5 — 前端与桌面切换

- 从 Hono OpenAPI 重新生成 SDK，与 `api-baseline.json` 的差异必须为空（被移除模块除外）。
- 移除知识库、通知、密码重置相关的视图与路由。其余 UI 路由和登录后的默认入口保持现有用户可见行为；组装点简化为 Lab 直接注册。
- 生产由服务同源托管 Web，开发由 Vite 代理。
- Electron 壳连接 Lab Word Server，`desktop-smoke` 通过。
- 保留的 Playwright spec 全部通过。

### M6 — 删除旧栈与文档收尾

- 在最后一个包含 Rust 的主线提交上打 tag `legacy-rust-final`。
- 用一个 PR 执行 §3.1 移除清单。之后用 `rg` 盘点 Rust、Docker、Redis、RustFS、Mailpit、knowledge、`just` 的残留引用，结果为零，或逐条说明保留原因。
- CI 改为 §7.4 的形态，提供 `pnpm check` 取代 `just check`。
- 把 Drizzle 迁移压缩为 `0000_baseline`。
- 更新文档：README（中英）、快速开始、教程中的命令、架构文档（`lab-word`、`module-boundaries`、`project-structure`）、测试策略与 T01 反馈循环、AGENTS.md 与 `docs/agents/*` 中对 `just`、Docker 和 Foundation 交接的引用、性能基线说明。
- 盘点并报告根项目的 Docker 资源；删除需要用户授权。

### Migration Gate

以下全部满足才算通过：

- 新克隆的仓库执行 `pnpm install && pnpm dev`，即可启动完整的 Lab Word Server 与 Web。Docker、PostgreSQL 服务器、Redis、RustFS、Mailpit、Rust 工具链和 `just` 都不参与。
- M0 的合同测试在新栈全绿。
- OpenAPI 与基线的差异为空（被移除模块除外）。
- 保留的 Playwright 旅程和 desktop smoke 通过。
- 性能基线中的全部确定性预算通过，SQL 语句数使用新的计量方式。
- 备份恢复演练与 `reset-password` 通过。
- ADR 0011 已改为 accepted，或已切换备选并更新。
- §3.1 移除完成，tag 已存在，文档里的命令可以运行。
- 通过项目流程要求的 reduce-complexity、独立 Standards + Spec 审查与最终 CI。

#29/#30 不属于本门禁。

---

## 7. 测试体系

### 7.1 层级

| 层 | 对象 | 方式 |
| --- | --- | --- |
| 领域 | 纯规则：观测有效性、状态转换、趋势缺口、幂等判定、设备程序推进 | 无 I/O 单元测试 |
| 用例 | 用例 + 内存 PGlite | 直接调用，包含语句预算 |
| 路由 | Hono | `app.request()`，不开端口 |
| 合同 | 公开 HTTP/SSE | `tests/contract/`，启动真实服务进程 |
| 前端 | React、Three.js | Vitest + jsdom（现有） |
| E2E | 用户旅程 | Playwright + 真实 Chromium（现有） |
| 桌面 | Electron 壳 | desktop smoke（现有） |

Isaac Sim 等外部环境的测试将来使用独立 profile，普通 `pnpm test` 不依赖它们。

### 7.2 合同测试的长期定位

合同测试在迁移期充当新旧实现之间的对照基准，迁移后保留为常驻的 HTTP 回归层。任何公开合同变化都要在同一个 PR 中更新合同测试与 OpenAPI。

### 7.3 性能合同在新栈上的测量

- **包体**：沿用现有 `perf-bundle.mjs`。
- **SQL 语句数**：使用执行器计数，取代 #44 的服务器统计。保留 #44 的测试意图：1 个与 100 个 Entity 时语句数不变；计入认证和事务控制语句；真实并发请求下仍不超过上限。
- **字节、点数、分页、时间范围**：由合同测试断言。
- **查询计划**：如果 PGlite 支持 `EXPLAIN`，生成计划作为审阅材料，不设门槛。
- **负载报告与桌面长测**：nightly 运行，使用独立临时数据目录。

### 7.4 默认 CI

```bash
pnpm install --frozen-lockfile
pnpm check        # 格式、lint、类型、合同、边界、工具/服务端/前端/合同测试、性能预算、应用与文档构建
pnpm test:e2e
pnpm desktop:smoke
```

CI 以 Linux 为主；Windows 上运行启动与合同测试子集。不启动任何容器。

---

## 8. 性能约束

### 8.1 不放宽的预算

现有 `scripts/perf/baselines.json` 的预算继续有效，调整只能走基线调整：

- 初始包 ≤ 400 KiB gzip，单个异步 chunk ≤ 500 KiB gzip。
- 世界快照、记录、趋势各 ≤ 10 条 SQL（含认证）。
- 世界订阅：单事件 1 MiB，最多 8 条待发。
- 历史与记录：每页 100 项、256 KiB、31 天。
- 趋势：默认 600 点、最多 1000 点、256 KiB、24 小时。
- 每个 Lab 最多 1000 个 Entity 和 1000 个 Scene Node。

### 8.2 服务端

- 遵守 §5.2 的串行执行约定：事务短，查询有界。
- 避免 N+1 查询，高频查找建索引；历史按 `entity + property + received_at` 建索引。
- 大 payload 不放进数据库行。

### 8.3 浏览器

- 主线程只负责 React 渲染、用户输入、Three.js 场景提交和轻量的状态协调。
- GLB 元数据提取、大 JSON 解析、图表降采样、压缩等重计算逐步移入 Worker。这类优化作为 Gate 之后的产品票或性能票，不放进迁移。
- 数据库不进入前端 bundle。
- Three.js、图表、资产编辑等重型功能继续按路由与能力懒加载。

### 8.4 3D

- geometry、material、texture 去重；大量重复对象用 InstancedMesh；纹理优先使用 KTX2。
- 大模型按需加载；替换资产时显式 dispose。
- Observation 更新不重建整个场景；Entity 状态与 Three.js 对象身份分离，只更新变化的 transform 与属性。
- 标签做可见性和优先级裁剪；场景图不绑定大范围的 React 重渲染。
- 保留 renderer metrics。

### 8.5 虚拟设备与持久化

- 设备程序按程序频率产生并持久化 Observation，例如传感器 1Hz（ADR 0006）。
- 呈现层的插值不写库，例如转子按观测 RPM 在客户端旋转。
- 未来的高频仿真流（例如 Isaac 位姿）不逐帧持久化，只持久化 Command、阶段转换、结果和按需的采样。
- 频率分层：物理仿真在内部高频运行 → 运行时以有界增量推送 → UI 状态在有用时约 10–20 Hz → 渲染使用 `requestAnimationFrame` → 持久化按事件或检查点。所有频率可配置，不写进业务合同。

---

## 9. 产品工作恢复

在 Migration Gate 之后进行。

### 9.0 恢复前置

- 逐票重新核对新的代码路径、合同与 CONTEXT，在 issue 下以评论记录新架构中的实现入口。不改写已发布的正文和父规格（[issue tracker](../agents/issue-tracker.md) 规则）。
- 旧实现只作为行为参考：从 `refs/handoffs/20261005T040315Z-pm-pause/*` 和源码包中提取规则、测试与教程语义，在新模块上重写；不 cherry-pick，不 apply patch。
- 新表以新迁移追加，不沿用旧的 `0029` 编号。
- 如果需要缩小某张票的原有范围（例如窄屏验收），先由用户明确决定，并在票上记录覆盖关系。

### Wave A — #30、#29

**#30 同一设备详情中的读数、操作和任务结果**（优先级最高）。要保留的行为：

- Operations / Records / Details 分层；
- 实际值与目标值分离；Command 被接受与 Observation 区分；当前有效值与最后报告值区分；
- 当前 Binding、Run、Task 与结果可查询，不从旧属性来源猜测；
- Stop Task 与 Stop Run 区分；Source Stop → Start 后恢复；
- 两台设备的输入与结果互相独立；
- 认证失效、会话失效与断线时的失败和恢复。

迁移方式：`observation-state.ts` 的纯规则先迁入；设备呈现回到 `packages/views`；接入新 SDK。原票包含 320×640、320×844 长名称的窄屏验收，旧候选在该视口下存在场景与 Inspector 的裁剪缺陷。恢复时按 9.0 确认这项验收是否仍在范围内；仍在范围内则先修复该缺陷。

**#29 当前用户的私人引导进度**（优先级最高）。要保留的合同：

```text
GET/PUT guide progress
revision CAS
missing = revision 0 / not_started
per-user isolation
Member / valid Agent identity
write failure rollback
no World side effects
```

需要重新验证：两用户隔离、Member 与 Agent、409 CAS、非法引用、审计写入失败回滚、SDK 生成。

### Wave B — #31、#36

**#31 三维表示、相机与标签**：按已发布范围交付，包括真实 GLB/HDR、原始尺度、主动定位与全景、减少动态、标签避让、材质实例隔离、资源释放。必须交付版本化的几何合同（边界、原点、实验台支撑面），供 #34/#35 使用。

数字孪生需要的轴向等字段不在 #31 中提前实现；几何合同采用版本化结构，以后可以扩展。

**#36 浏览器布局草稿恢复**：草稿按部署（API base）、用户、Lab、格式版本隔离；草稿只属于当前浏览器，保存后的布局才是 Lab Word Server 中的权威状态。只有确认保存或明确丢弃后才清除草稿；冲突时显式恢复；数值必须是有限值且在有效范围内。

### Wave C — #32、#33、#34

**#32 趋势 UI**：先重新核对 `@tanstack/charts` 的兼容性与包体。要求：UTC 时间尺度；1/6/24 小时与一分钟入口；断点、孤立点与尖峰；来源 tooltip 与表格；只在可见时节流刷新；隔离晚到的响应。降采样与渲染放在浏览器完成。

**#33 记录、活动与 CSV**：有界筛选；游标分页；固定上界；失败时保留当前页；显示真实的操作者身份；当前页 CSV 安全处理（引号、换行、公式前缀）。

**#34 创建与登记的安全重试和初始摆放**：这是以后 Agent 操作 Lab Word 的重要事务边界。要求：

```text
idempotency key
same key + same params -> recover
same key + different params -> 409
expired committed attempt -> readonly recovery, never replay
business receipt + association atomic
```

### Wave D — #35、#37

**#35 基础、完整、空白模板**：模板生成真实的 Entity、Scene Node、Relationship 和初始 Placement；房间不能只是装饰网格；模板创建后不启动 Run。

**#37 运行总览与设备筛选**：复用 #30 的设备详情、#32 的趋势、#33 的活动和当前观测有效性规则。默认入口仍是空间视图，总览需要显式进入。

### Wave E — #38、#39、#40

**#38 首次真实旅程与动态指引**：Driver 只定位普通业务控件，不拥有业务状态。

**#39 跨上下文续接与位置回顾**：在另一个浏览器中恢复个人进度；本地草稿缺失时如实说明，不能声称已经保存。

**#40 最终里程碑验收**：验收完整旅程：

```text
默认空间 → 设备详情 → 趋势 / 任务 / 记录 → 模板 → 登记与布局保存 → 引导 → 续接与回顾
```

同时运行：100 Entity、20 台 1Hz 设备、两个真实浏览器、确定性的 24 小时趋势、包体预算、真实 WebGL 与图表证据、独立的 Standards + Spec 审查。

### Product Completion Gate

#29–#40 全部完成并集成，#40 最终验收通过。

### 候选后续票

以下需要用户批准后再发布：

- 内嵌 Lab Word Server 的一体化 Electron 桌面版；
- 管理员在界面中重置成员密码；
- 把浏览器重计算移入 Worker（资产解析、降采样）；
- Browser Standalone 的独立 spec。

---

## 10. 数字孪生方向（非约束）

### 10.1 进入条件

- Product Completion Gate 已通过。
- 单独完成 grill → spec → tickets。本节只是输入，不是已批准的范围。
- Isaac Sim 运行在用户的 Windows 机器上，环境细节在 DT spec 中处理。

### 10.2 已确定的原则

- **状态权威**：
  - 设计状态归 Lab Word：Lab、资产与 Entity 身份、布局、关系、能力、仿真配置；
  - 仿真状态归当前的仿真后端：位姿、关节、速度、接触、传感器；
  - 物理状态归真实设备与传感器；
  - Three.js 只负责呈现，不拥有任何事实。
- **身份**：遵循 ADR 0007。Isaac 中的模拟设备对应一个模拟 Entity；真实设备是另一个 Entity，两者用“模拟对应”关系关联；同一个 Entity 不会同时挂模拟和真实两种 Binding。实验台、墙等静态物体如何映射到 Isaac Prim，在 DT spec 中决定。
- **资产多表示**：同一个 Asset 可以有 Web 表示（GLB）和仿真表示（USD），两者共享 Asset 与 Entity 身份。
- **持久化**：高频仿真流不逐帧持久化（§8.5）。
- **仿真后端可替换**：首个高保真后端是 Isaac Sim。PhysX 为默认物理引擎，Newton 为实验选项；物理引擎是否必须在仿真开始前选定、一个会话能否只有一个活动引擎，在 DT spec 中复核。

### 10.3 方向性阶段

| 阶段 | 方向 |
| --- | --- |
| DT0 | 几何与资产表示合同：在 #31 的版本化几何上扩展单位、轴向、原点、边界、支撑面；GLB 与 USD 表示共享身份；冻结 Placement 坐标含义 |
| DT1 | 仿真会话概念：把现有设备程序与将来的外部仿真后端纳入同一个会话模型；是否需要浏览器内逻辑后端，取决于 Browser Standalone spec |
| DT2 | Isaac 连接器：connect/health、load world、spawn/remove、set/get transform、play/pause/reset/step、状态增量推送 |
| DT3 | 双向往返：Lab Word 摆放同步到 Isaac；Isaac 物理状态同步到 Three.js；断线后用快照 + 版本恢复；不逐帧写库 |
| DT4 | PhysX 稳定基线；Newton smoke test，并明确标注为实验状态 |
| DT5 | 优先使用 Isaac 的 ROS 2 Simulation Control 标准能力；接入一个机器人关节状态和一个相机或传感器 |

### 10.4 初级数字孪生的目标定义

以下内容由 DT spec 细化：

- **World**：持久 Lab，包含真实的 Entity、Scene Node、Relationship；GLB 与 USD 表示有正式映射。
- **Runtime**：可以启动仿真会话；现有设备程序与 Isaac 后端都可用；Runtime Binding 能定位 Isaac Prim。
- **Sync**：Lab Word → Isaac 的摆放同步；Isaac → Three.js 的状态同步；快照 + 版本重连；不逐帧写库。
- **Device**：至少一台设备（建议离心机）完成 Command → Simulation → Observation → UI → History。
- **Robot**：至少一个机器人或可动关节物体可以被 Isaac 加载，在 Lab Word 中有 Entity 身份，关节或位姿状态至少一种可观测。
- **Recovery**：Isaac 重启、浏览器刷新、服务重启后，都不会产生新的 Entity 身份，也不会重复执行已提交的 Command。

### 10.5 更远阶段

- **Physical Twin**：ROS 2、OPC UA LADS、SiLA 2、MQTT、厂商 API。
- **Sim-to-Real**：Isaac Sim → 控制器或策略 → 真实机器人。
- **Agentic Lab**：Observe → Plan → Simulate → Validate → Human gate → Execute → Observe result。
- **Dark Lab**：从 L0 dry run 逐步演进到 L3 lights-out loop。

---

## 11. 并行开发策略

### 11.1 必须串行的 Foundation

由一个 owner 完成以下内容并合并，稳定之前不开并行的实现 Agent：

- M0：合同测试 harness、用例约定、behavior-matrix 结构；
- M1：仓库结构、tsconfig、`platform/*`、错误信封、OpenAPI 约定、用例上下文、BlobStore 接口、测试 harness、边界检查。

### 11.2 按模块并行

M0 的合同测试可以按模块分开编写：Core、Lab 世界、设备运行、历史与记录与趋势。

M2–M5 的轨道：

```text
轨道 A  core/identity、organization、api-keys、audit、idempotency、rate-limit
轨道 B  core/files、platform/blob-store、scheduler
轨道 C  lab/assets、world、layout、relationships
轨道 D  lab/devices、runtime（依赖 C）
轨道 E  lab/sync、history、records、trends、lifecycle（依赖 D）
轨道 F  进程生命周期与运维命令（M4）
轨道 G  前端与桌面切换、E2E（M5）
```

共享文件由 Foundation owner 合并：`apps/server` 组合根、OpenAPI 汇总、迁移目录、性能基线。

### 11.3 Worktree 与资源规则

- 一票一 worktree，PR 提前开为 Draft；在 issue 中记录真实的 blocker。
- Agent 不能自行修改依赖的合同；共享文件的修改走 Foundation owner。
- 旧交接 patch 只在隔离的 tree 中查看，不套用到新主线。
- 只有 M0 使用 Docker，按 AGENTS.md 登记、清理和核对资源。

---

## 12. 执行顺序

```text
M0  冻结与合同测试基线（在 Rust 栈跑绿）
M1  TypeScript 基础 + PGlite spike → ADR 0011 定案
M2  Platform Core
M3  Lab
M4  进程生命周期与运维命令
M5  前端与桌面切换
M6  删除 Rust / Docker / 知识库 / 模板工具，更新文档
    ── Migration Gate ──
Wave A  #30 #29
Wave B  #31 #36
Wave C  #32 #33 #34
Wave D  #35 #37
Wave E  #38 #39 #40
    ── Product Completion Gate ──
数字孪生：独立 grill → spec → tickets
```

这个顺序保证两件事：

- 迁移不改变产品语义，所以合同测试能判定对错；
- 产品工作在一个稳定的新基线上恢复，不会被迁移无限期拖延。

---

## 13. ADR 状态

| ADR | 状态 |
| --- | --- |
| [0001](../adr/0001-single-organization-deployment.md) 单企业部署 | 有效 |
| [0002](../adr/0002-executable-removable-reference.md)、[0003](../adr/0003-static-example-composition.md) 可移除示例与静态组合 | 被 0009 取代 |
| [0005](../adr/0005-lab-digital-twin-on-saas-foundation.md) 在 SaaS 底座上发展 Lab | 知识库兼容与组装部分被 0009 取代 |
| [0006](../adr/0006-server-owned-virtual-device-programs.md) 服务端设备程序 | 有效，迁移不改变 |
| [0007](../adr/0007-separate-simulated-and-physical-entity-identities.md) 模拟与真实独立身份 | 有效 |
| [0008](../adr/0008-full-lab-access-for-users-and-agents.md) Member 与 Agent full access | 有效 |
| [0009](../adr/0009-lab-word-product-only.md) 只保留实验室产品 | accepted |
| [0010](../adr/0010-single-typescript-lab-word-server.md) 单个 TypeScript 服务进程 | accepted |
| [0011](../adr/0011-pglite-embedded-database.md) PGlite 嵌入式数据库 | proposed，M1 spike 后定案 |

到对应阶段再写的 ADR：

- Browser Standalone 的权威模式（会修订 ADR 0006 的适用范围）；
- 数字孪生的状态权威与仿真后端；
- 将来如果需要，多实例或服务器数据库。

---

## 14. 外部事实

使用前必须复核。以下事实影响 M1 和 DT 阶段，均为待复核状态：

1. PGlite 是单连接，并发查询与事务在实例内串行执行。
2. PGlite 在 Node 文件系统上的持久化方式，以及进程被强制终止后的一致性。
3. PGlite 内嵌的 PostgreSQL 版本，以及对多 schema、jsonb、`gen_random_uuid()`、`EXPLAIN` 的支持。
4. Drizzle 对 PGlite 驱动与 drizzle-kit 迁移的官方支持。
5. 备选方案（随 npm 分发的原生 PostgreSQL）的平台支持与体积。
6. Isaac Sim 的 ROS 2 Simulation Control 能力，以及 PhysX/Newton 的切换约束（DT 阶段复核）。

Browser Standalone 相关的事实（浏览器 VFS、OPFS、多 tab worker、WASM 体积）和 Cloudflare 的限额，在对应的 spec 中再核对。

---

## 15. 最重要的工程判断

这次迁移不是把 `Axum` 翻译成 `Hono`、把 `PostgreSQL` 翻译成 `PGlite`，而是：

```text
旧：多容器、多进程、按服务器 SaaS 模板组织的底座
新：单进程 Lab Word Server + 模块化领域代码 + 可执行的合同基准
```

保留的是产品行为与领域合同，换掉的是运行时与基础设施。迁移结束后，主线开发围绕以下方向推进：

```text
World → Device Runtime → Simulation → Physical → Agent
```

而不是继续围绕缓存、队列、对象存储服务器和容器编排。

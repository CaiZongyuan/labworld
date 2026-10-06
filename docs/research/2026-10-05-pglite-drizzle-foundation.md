# PGlite 与 Drizzle：M1 基础调查

核对日期：2026-10-05。本文是 maintainer 研究笔记，供 [总纲 M1、§5、§14](../plans/labworld-vnext-development-plan.md) 使用；不是公共文档路由、集成完成或 spike 通过记录。[ADR 0011](../adr/0011-pglite-embedded-database.md) 仍为 proposed。本次仅读取官方文档、源码和 npm metadata，没有安装依赖、启动数据库、运行 Node/Docker spike、修改 tracker 或 ADR。

## 来源快照

npm `latest` 分别为 PGlite `0.5.8`、Drizzle ORM `0.45.3`、Kit `0.31.11`。PGlite 固定源码提交为 `ae182ff8bd5ba4acb887d6c925d607a1498aa0b5`，Drizzle 固定为 `15454dbe49d827c6081f3d0231e2e7985e517295`；各提交的包 manifest 与上述版本对应。本文所有来源均在 2026-10-05 读取。这是包与源码快照，本项目尚未选择或安装这些版本。[PGlite metadata][pglite-npm]、[PGlite manifest][pglite-package]、[ORM metadata][orm-npm]、[ORM manifest][orm-package]、[Kit metadata][kit-npm]、[Kit manifest][kit-package]

Drizzle 官方网站本次返回 403，改读官方文档仓库固定提交 `236d7ea7aaa3178af732aabca5511bd639ae6a2f`。连接页面混有 `@rc` 示例，实施时应明确发布通道并锁定版本。[connection docs][drizzle-connect]

## 已确认的文档与源码事实

| 问题 | 官方事实 | M1 仍须验证 |
| --- | --- | --- |
| 单连接、并发 | 官方 README 限制为 single user/connection；常规 `query()`、`exec()` 和整个 `transaction()` 回调使用同一个 transaction mutex，内部语句另受 query mutex 保护。回调 resolve 后提交、reject 后回滚。 | 统一 `platform/db` 入口、队列上界与语句计数是应用规则。事务回调等待外部 I/O 时也占用 mutex；底层协议接口不能被视为同等保护。[README][pglite-readme]、[base source][pglite-base]、[mutex source][pglite-source] |
| Node 持久化 | NodeFS 使用 Node API，把数据目录挂载到 Emscripten `NODEFS`；其继承的 `syncToFs()` 是空实现。`relaxedDurability` 默认关闭，但等待所选 filesystem 的同步不能被称为已执行磁盘 `fsync`。 | 目录重新打开、并发进程目录锁与强杀后的实际完整性。[NodeFS][nodefs]、[filesystem base][fs-base]、[API/source][pglite-source] |
| 默认耐久参数 | `defaultStartParams` 包含 `--single` 和 `-F`，注释为“turn fsync off”；API 允许自定义启动参数。 | 保存实际 `SHOW fsync`、有效启动参数和 filesystem。不能假定删去 `-F` 就获得特定 VFS 耐久保证。[source][pglite-source]、[API][pglite-api] |
| PostgreSQL 版本 | 上述 PGlite 提交的 PostgreSQL submodule 是 `b133782cd759f08b3aeb263b80a963b39c7b7af1`，其 `configure.ac` 声明 `18.3`。 | npm 包的实际 WASM 未运行；记录 `SELECT version()` / `SHOW server_version`。[tree][pglite-tree]、[configure.ac][pg-configure] |
| Schema、JSONB、UUID | PostgreSQL 18 官方支持多 schema、限定表名、JSONB 和内置 `gen_random_uuid()`；PGlite 类型层支持 JSON/JSONB 解析。 | PostgreSQL 官方能力与 PGlite parser 存在都不能代替本项目最终 schema、约束、部分索引、JSONB SQL 和 UUID default 的装载结果。[schemas][pg-schema]、[JSONB][pg-json]、[UUID][pg-uuid]、[types source][pglite-types] |
| `EXPLAIN` | PGlite 官方 basic test 使用 `EXPLAIN SELECT COUNT(*) FROM t` 并检查没有 `Gather`。 | 本次未运行该测试；实际查询计划仍待收集。[basic tests][pglite-tests] |
| Drizzle 驱动、迁移 | 官方提供 `drizzle-orm/pglite` 与 `drizzle-orm/pglite/migrator`。Kit 的 PGlite 分支导入该 migrator 并等待 client ready；官方配置使用 `dialect: 'postgresql'`、`driver: 'pglite'`、目录型 `dbCredentials.url`，`migrate` 应用 `generate` 的 SQL。 | 迁移生成、第一次应用、重新启动不重复应用及失败恢复。迁移 CLI 不应与服务同时打开同一目录。[connect][drizzle-connect]、[migrator][drizzle-migrator]、[Kit source][kit-connections]、[config][drizzle-config]、[migrate docs][drizzle-migrate] |
| Node 24、Linux/Windows、原生依赖 | PGlite 发布包是 WASM/client，没有声明 runtime 或 optional dependencies、`engines`；upstream 开发仓库要求 Node `>=20`。官方 Node 用法是 import `PGlite` 后创建内存实例或传目录。README 的 Docker 要求属于从源码构建 WASM。 | `>=20` 不是 Node 24 精确运行证据，也没有证明 Linux/Windows 文件系统、路径、锁与终止行为一致。[metadata][pglite-npm]、[root manifest][pglite-root]、[getting started][pglite-start]、[README][pglite-readme] |

**耐久性结论仍 pending。** 本次官方资料没有证明本项目在任意写入时刻强杀后，所有已向客户端确认提交的数据均完整；也不能据默认 `-F` 直接宣布测试必然失败。进程强杀、操作系统崩溃和断电是不同故障范围，报告须准确记录实测范围。

“PGlite 没有原生依赖”只描述数据库包。Kit `0.31.11` 依赖 `esbuild ^0.25.4`，esbuild 官方说明会安装平台对应的 native executable；不能据此把整个开发工具链称为没有任何原生二进制。[Kit metadata][kit-npm]、[esbuild docs][esbuild]

## `received_at` 与 history 的微秒保真

PostgreSQL timestamp/timestamptz 分辨率为 1 microsecond，precision 可取 0–6；JavaScript `Date` 的时间值为整数毫秒，经过 Date 再格式化不能恢复微秒末三位。[datetime][pg-datetime]、[ECMAScript Date][date-spec]

- 直接 PGlite 的 DATE/TIMESTAMP/TIMESTAMPTZ 默认 parser 使用 `new Date(x)`，Date serializer 使用 `toISOString()`；string 输入原样保留。官方支持按 OID 配置 constructor/query parser，可对 `types.TIMESTAMP` 与 `types.TIMESTAMPTZ` 使用 identity parser。[types source][pglite-types]、[API][pglite-api]
- Drizzle PGlite session 已使用 timestamp identity parser，但默认 timestamp column mapper 又调用 `new Date()`。`timestamp({ mode: 'string', withTimezone: true, precision: 6 })` 选择字符串 column，string mapper 原样返回，提供了避免 Date 精度损失的源码路径。[session][drizzle-session]、[timestamp column][drizzle-timestamp]

建议 M1 保留精确时间字符串直到公开 JSON/history/游标输出，实际排序使用数据库时间值。数据库文本形态与时区不等于 API 已约定的 UTC ISO 形态，规范化也要保留微秒。以上是集成建议，尚未实现或实测。最小验证加入同一毫秒内的 `.123456Z` / `.123457Z` 两个时间，核对直接 PGlite、Drizzle string column、公开 HTTP/history 的精确读回、排序和游标；同时检查 UTC/非 UTC 输入。

## npm 分发 native PostgreSQL 备选

`leinelissen/embedded-postgres` 官方 npm `latest` 为 `18.4.0-beta.17`，`engines.node >=16`，metadata `gitHead` 为 `8c8c16d1b81bec8ae3315d59a050654086a85e23`。维护者 README 支持矩阵包含 Windows x64、Linux x64/arm/arm64/ia32/ppc64、Darwin x64/arm64；这不证明 Windows arm64、所有 Linux libc 或本项目 Node 24 已通过。[metadata][embedded-npm]、[README][embedded-readme]

源码通过 `child_process.spawn()` 启动 `initdb` 和 `postgres`，管理数据目录与 TCP port；Windows 停止路径使用 `taskkill`，其他系统使用 SIGINT。官方说明必须允许运行 post-install scripts 来创建所需 symlinks。因此它引入 native 子进程、端口和安装脚本管理边界。完整平台安装体积、冷启动 RSS 和数据目录体积均为 **unknown**；wrapper 的 npm unpacked size 不能作为 PostgreSQL 总体积。[source][embedded-source]、[README][embedded-readme]

## 待实测与对 spike 的影响

M1 尚未因这份笔记解锁或完成。按总纲在独立临时目录、锁定版本与有效配置上执行：最终 schema 装载；20 台 1Hz 设备形态写入、两个 SSE 与并发请求至少 30 分钟，记录预算和采样漂移；至少 20 次写入中强杀，以已收到确认的提交为核对集合；Linux/Windows 各跑启动、迁移与合同子集；记录冷启动、目录体积和内存。加入微秒精度与迁移重开检查。全部结果仍 pending，ADR 0011 定案留待这些证据。

[pglite-npm]: https://registry.npmjs.org/@electric-sql%2Fpglite
[pglite-package]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/package.json
[pglite-tree]: https://api.github.com/repos/electric-sql/pglite/git/trees/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5
[pglite-readme]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/README.md
[pglite-start]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/docs/docs/index.md
[pglite-source]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/src/pglite.ts
[pglite-api]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/docs/docs/api.md
[pglite-base]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/src/base.ts
[nodefs]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/src/fs/nodefs.ts
[fs-base]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/src/fs/base.ts
[pglite-root]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/package.json
[pglite-types]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/src/types.ts
[pglite-tests]: https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/tests/basic.test.ts
[pg-configure]: https://github.com/electric-sql/postgres-pglite/blob/b133782cd759f08b3aeb263b80a963b39c7b7af1/configure.ac
[pg-schema]: https://www.postgresql.org/docs/18/ddl-schemas.html
[pg-json]: https://www.postgresql.org/docs/18/datatype-json.html
[pg-uuid]: https://www.postgresql.org/docs/18/functions-uuid.html
[pg-datetime]: https://www.postgresql.org/docs/18/datatype-datetime.html
[date-spec]: https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-time-values-and-time-range
[orm-npm]: https://registry.npmjs.org/drizzle-orm
[kit-npm]: https://registry.npmjs.org/drizzle-kit
[orm-package]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-orm/package.json
[kit-package]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-kit/package.json
[drizzle-connect]: https://github.com/drizzle-team/drizzle-orm-docs/blob/236d7ea7aaa3178af732aabca5511bd639ae6a2f/src/content/docs/pg/connect-pglite.mdx
[drizzle-config]: https://github.com/drizzle-team/drizzle-orm-docs/blob/236d7ea7aaa3178af732aabca5511bd639ae6a2f/src/content/docs/drizzle-config-file.mdx
[drizzle-migrate]: https://github.com/drizzle-team/drizzle-orm-docs/blob/236d7ea7aaa3178af732aabca5511bd639ae6a2f/src/content/docs/pg/drizzle-kit-migrate.mdx
[drizzle-session]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-orm/src/pglite/session.ts
[drizzle-migrator]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-orm/src/pglite/migrator.ts
[drizzle-timestamp]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-orm/src/pg-core/columns/timestamp.ts
[kit-connections]: https://github.com/drizzle-team/drizzle-orm/blob/15454dbe49d827c6081f3d0231e2e7985e517295/drizzle-kit/src/cli/connections.ts
[esbuild]: https://esbuild.github.io/getting-started/#simultaneous-platforms
[embedded-npm]: https://registry.npmjs.org/embedded-postgres
[embedded-readme]: https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/README.md
[embedded-source]: https://github.com/leinelissen/embedded-postgres/blob/8c8c16d1b81bec8ae3315d59a050654086a85e23/packages/embedded-postgres/src/index.ts

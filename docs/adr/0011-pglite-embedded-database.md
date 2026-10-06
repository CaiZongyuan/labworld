---
status: accepted
---

# Lab Word Server 使用 PGlite 作为嵌入式数据库

决定日期：2026-10-06。采用锁定的 PGlite 0.5.8、Drizzle ORM 0.45.3 和 Node 24.18.0，使用 PGlite 的 NodeFS 持久目录。数据库在 Lab Word Server 进程内运行，没有 PostgreSQL 附属进程。M1 的已批准判据已经实际通过，因此不启用 npm 分发原生 PostgreSQL 的备选。

PGlite 保留 PostgreSQL 方言、限定 schema、JSONB、UUID、约束、索引、CTE 与 RETURNING。一个数据库实例对应一个串行执行器，全部读取、写入、迁移与后台操作都进入队列。布局与世界版本等冲突语义仍由显式版本检查承担；事务内不等待网络、文件或定时器。数据库驱动只由 `platform/db` 拥有，领域规则与 Platform Core 的依赖边界保持原决定。

## 实际配置与故障范围

构造参数固定为本地 `dataDir`、`relaxedDurability: false`，并为 timestamp/timestamptz 配置字符串解析。Drizzle 时间列采用字符串模式、时区和六位精度。没有覆盖 PGlite 0.5.8 的 `startParams`；发布包默认参数包含 `--single`、`-F`、`-O`、`-j`，以及禁用后台/并行 worker 和使用同步 I/O 的设置。实际 SQL metadata 报告 PostgreSQL 18.3、`fsync=off`、`synchronous_commit=on`。

NodeFS 的 `syncToFs` 为空，与默认 `-F` 一起被明确记录。这些事实不能代替项目试验，也不能据此声称磁盘 fsync 或断电保证。本决定的持久性证据覆盖实际服务进程在连续写入中的 force-kill，以及重开后所有外部已确认提交的完整身份与内容；没有测试操作系统崩溃或断电。

## 已完成的判据

| 判据 | 实际证据 |
| --- | --- |
| 保留的最终 schema | 31 张保留职责的表；限定名、JSONB、UUID default、CHECK/复合 FK、部分索引、延迟 task/result FK、历史与世界触发器、CTE/RETURNING 均实际执行；不加载移除业务或旧 28 次迁移。失败的实际 Drizzle 迁移回滚，重开后初始迁移只应用一次。 |
| 持续合成写入与并发 | Linux 持续 1,800,183.57 毫秒，20 个 1 Hz 设备形态累计 36,000 样本；17,136 次并发读取、8,568 次写入；两个真实 SSE 订阅各收到 44,568 个样本。最大单调时钟采样提交漂移 19.9783 毫秒，27,506 次请求数据库操作均完成，实际提交 SQL（含认证形态查询与事务控制）最多 5 条，未放宽既有预算。 |
| 强杀与目录独占 | Linux 和 Windows 都通过连续写入中至少 20 次真实 force-kill；每次重开核对累计 60 个外部确认的完整提交。两个服务同时打开同一目录被拒绝，原 owner 仍可用。资源恢复、创建身份、运行标记和活跃目录保护也有实际反证。 |
| 微秒保真 | `.123456Z` / `.123457Z` 在直接驱动、Drizzle、公开试验输出、排序、游标和重开中保持不同；包含非 UTC 输入与反向 ID 顺序。 |
| Linux 与 Windows | [CI 37445684661](https://github.com/CaiZongyuan/labworld/actions/runs/37445684661) 的 `verify` 与 `windows-foundation` 均成功，实际运行启动、迁移、非零 HTTP/持久化/进程合同子集、隔离生成和两个 SSE 订阅的短试验。完整业务合同仍待迁移。 |

正式长测的固定排程使用进程单调时钟；`scheduled_at` 是初始墙钟的 UTC 投影，逐次采样时间则读取实际墙钟。两种时间源之间观察到的差异没有被归因为数据库排队。原始长测没有保存最后三请求同时发生传输拒绝的全部客户端结果，因此不宣称零客户端传输错误；完整确认数据、操作日志、并发比例、订阅计数和采样周期判据已独立回读通过。未来 runner 已增加最终失败检查和真实拒绝反证。

冷启动、目录体积和 RSS 只报告，不是数据库选型门槛。Linux 本次冷启动 2,778.77 毫秒、目录 91,005,178 字节；完整内存序列随报告保存，不以单次测量宣称泄漏或跨机器性能。

## 范围与后续责任

当前服务入口支持并实际验证 Linux 与 Windows。数据目录租约使用 Linux abstract Unix socket 和 Windows named pipe，由操作系统在进程退出时释放；macOS 入口尚未交付，不声称可运行。Browser Standalone 仍是后续独立决定，不能由本数据库选择推定为已实现。

本次合成负载证明基础设施可承载规定的写入和并发形态；它不替代真实 Device Program、业务 SSE、凭据撤销、世界/记录/趋势预算或完整用户旅程的后续合同。全栈迁移、备份恢复和最终客户端切换仍由 Migration Gate 验证。若之后出现可复现的实际数据库判据失败，按已批准备选改用 npm 分发原生 PostgreSQL，更新本 ADR 并重证受影响合同；需要诚实报告其附属数据库进程。

复现入口见 [TypeScript 服务基础](../guides/server-foundation.md)，官方事实与固定源码见 [M1 研究笔记](../research/2026-10-05-pglite-drizzle-foundation.md)。本机完整证据位于 `.scratch/vnext-continuation-20261006/evidence/m1-spike-30m/`、`m1-formal-load-readback.md`、`m1-spike-30m-input/` 及 force-kill/平台回执；CI 提供可发布的平台运行链接，本机文件缺失不会替代实际验证要求。

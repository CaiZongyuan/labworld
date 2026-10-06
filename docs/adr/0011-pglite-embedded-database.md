---
status: proposed
---

# Lab Word Server 使用 PGlite 作为嵌入式数据库

Lab Word Server 需要无原生依赖、可在 Linux/Windows/macOS 一致运行的嵌入式数据库，并保留现有 PostgreSQL 方言的表结构、约束与 JSON 语义；PGlite 同时为日后的 Browser Standalone 保留同一数据库。PGlite 只有一个连接，服务端的全部数据库访问经同一串行执行器完成：正确性依靠串行化和版本检查而不是行锁，事务内不做外部 I/O。

M1 spike 通过前本决定保持 proposed：现有 schema 可载入；20 台 1Hz 设备、并发请求与 SSE 同时运行时预算达标且采样不滞后；强制终止进程后数据库可打开、已提交数据完整；Linux 与 Windows 均可运行。任一项失败则改用随 npm 分发的原生 PostgreSQL，沿用同一 Drizzle 方言与迁移，并更新本 ADR。

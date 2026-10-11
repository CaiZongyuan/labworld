---
status: accepted
---

# 以单个 TypeScript 服务进程取代 Rust 后端与容器依赖

用户要求普通开发只需 `pnpm install` 与 `pnpm dev`，前后端共用 TypeScript。vNext 由一个 Node + Hono 的 Lab Word Server 持有权威状态：进程内运行设备程序、调度、实时推送与限流，文件按内容哈希保存在本地数据目录，数据库嵌入进程（见 [ADR 0011](0011-pglite-embedded-database.md)）。Rust/Axum API、独立 Worker、Redis、RustFS、Mailpit、Caddy、可观测性栈和全部 Docker 配置，在新实现通过同一套黑盒合同测试后一次移除，只以 Git tag 保留。

代价是放弃多实例水平扩展和容器化部署：服务默认只监听 `127.0.0.1`，团队访问由部署方提供 HTTPS 反向代理，仓库不提供镜像。迁移期公开 HTTP 合同除被移除模块外保持不变，[ADR 0006](0006-server-owned-virtual-device-programs.md) 的设备程序语义与 [ADR 0007](0007-separate-simulated-and-physical-entity-identities.md) 的身份划分不随运行时改变。将来需要多实例或服务器数据库时作为新决定引入，不恢复旧栈。

2026-10-11 补充：远程 Motion 可以在同一个 Node 监听器上配置可选 HTTPS/WSS 证书与私钥。默认回环监听保持不变，部署方也可继续提供 HTTPS 代理，并验证 Node TLS upstream。实际 TLS socket 决定安全接入，调用者的代理头不能代替它。此能力不恢复 Caddy、Docker 或其他独立运行栈，见[安全 WSS 教程](../tutorials/secure-motion.md)。

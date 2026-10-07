# 停服备份并恢复到新目录

目标：备份当前 Node 数据，再恢复到独立的新目录。先完成[Node 运行追溯](server-traceability.md)，准备已发布资产和已确认的业务记录。需要仓库指定的 Node 24 与 pnpm。以下 Bash 命令从仓库根目录运行；它们写入指定归档和恢复目录。

## 创建离线归档

停止使用源目录的服务。在运行 `pnpm dev` 的终端按 Ctrl+C，等进程退出。

```bash
export LAB_WORD_DATA_DIR=data
pnpm server backup --output .scratch/archives/lab-backup
```

成功输出 `status: backed-up`。归档是一个目录，包含 `manifest.json`、数据库快照和已验证对象字节。命令独占源目录，逐页读取 ready 文件引用，再流式核对大小和 SHA256。数据库事务不等待文件读取。活动服务仍持有源目录时，备份失败。

归档正向包含数据库和 ready 对象。它不包含原始 `secrets/file-signing-key`、上传暂存、日志或环境文件。数据库里的密码、会话和 API key 哈希仍是身份数据，不会被删除。

## 恢复并读回

选择不存在或为空的目录；不要选原来的服务目录。

```bash
export LAB_WORD_DATA_DIR=.scratch/restored-lab
pnpm server restore --archive .scratch/archives/lab-backup
pnpm dev
```

成功输出 `status: restored`。恢复先核对格式、路径和每个文件，再在所属 staging 检查实际数据库历史和 ready 引用。完成校验后才取得目标目录锁并发布数据。非空目标、错误内容和不支持的历史会失败；修正输入或选择新目录后重试。

登录原账户，打开原 Lab 并下载资产。身份和文件字节保持相同。用原键与原参数重试已成功 Command，得到原结果。旧运行在启动时显示 interrupted；不会自动重放命令或恢复长任务。新签名器生成新的字节 URL。

当前格式只支持本实现验证过的 Node 迁移历史和数据库格式。后续压缩 baseline 时，必须提供已验证的兼容路径，或在修改目标前拒绝旧历史。保留早期 Node 目录与归档；本命令不转换或删除旧 Rust/PostgreSQL 数据。

源码归属：[CLI 组合](../../apps/server/src/operations.ts)、[数据库历史与打开能力](../../packages/server/src/platform/db/index.ts)、[关闭后的数据库快照](../../packages/server/src/platform/db/snapshot.ts)和[Files ready 引用](../../packages/server/src/core/files/archive.ts)。当前统一入口提供 backup 与 restore；迁移和密码重置入口继续在本轮运维实现中组合。

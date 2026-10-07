# 停服备份并恢复到新目录

目标：备份当前 Node 数据，再恢复到独立的新目录。先完成[Node 运行追溯](server-traceability.md)，准备已发布资产和已确认的业务记录。需要仓库指定的 Node 24 与 pnpm。以下 Bash 命令从仓库根目录运行；它们写入指定归档和恢复目录。

## 创建离线归档

停止使用源目录的服务。在运行 `pnpm dev` 的终端按 Ctrl+C，等进程退出。

```bash
export LAB_WORD_DATA_DIR=data
pnpm server backup --output .scratch/archives/lab-backup
```

成功输出 `status: backed-up`。归档是一个目录，包含 `manifest.json`、数据库快照和已验证对象字节。命令独占源目录，逐页读取 ready 文件引用，再流式核对大小和 SHA256。数据库事务不等待文件读取。活动服务仍持有源目录时，备份失败。

输出可用新目录或现有空目录。安全的 `dataDir/backups` 可用；输出和临时归档不能落入被复制的 `pgdata` 树。路径别名按真实目录检查，避免快照递归复制自身。发布只移除确认为空的输出目录，不递归删除已有内容。

归档正向包含数据库和 ready 对象。它不包含原始 `secrets/file-signing-key`、上传暂存、日志或环境文件。数据库里的密码、会话和 API key 哈希仍是身份数据，不会被删除。

## 恢复并读回

选择不存在或为空的目录；不要选原来的服务目录。

```bash
export LAB_WORD_DATA_DIR=.scratch/restored-lab
pnpm server restore --archive .scratch/archives/lab-backup
pnpm dev
```

成功输出 `status: restored`。恢复逐级拒绝归档中的链接目录，先核对格式、路径和每个文件，再核对实际复制到 staging 的大小与 SHA256。随后在所属 staging 检查实际数据库历史和 ready 引用。完成校验后预留目标的规范路径锁，不提前创建目标，再通过一次目录重命名发布。发布失败时，新目标保持不存在，原空目录会恢复。非空目标、错误内容和不支持的历史会失败；修正输入或选择新目录后重试。

Linux 的 SIGTERM/SIGINT 会取消归档操作，等待正在进行的复制结束，再关闭数据库并释放目录所有权。进程异常退出可能在临时目录旁留下 `.lab-word-backup-*.json` 或 `.lab-word-restore-*.json` 所有权记录。确认旧进程停止后，用相同命令和目标重试。命令同时取得目标与 staging 的排他权，只核对有效且匹配的记录，并验证目录创建身份；若发布中断，先恢复原空目标，再清理所属 staging。活跃 staging 使用者会阻止回收。创建身份缺失或变化时拒绝清理并保留目录。未知目录、无效记录与其他目标的记录保持原样。Windows 进程终止走这一异常退出恢复路径。已经成功发布的目录保留，仍按非空目标拒绝覆盖。

登录原账户，打开原 Lab 并下载资产。身份和文件字节保持相同。用原键与原参数重试已成功 Command，得到原结果。旧运行在启动时显示 interrupted；不会自动重放命令或恢复长任务。新签名器生成新的字节 URL。

当前格式只支持本实现验证过的 Node 迁移历史和数据库格式。后续压缩 baseline 时，必须提供已验证的兼容路径，或在修改目标前拒绝旧历史。保留早期 Node 目录与归档；本命令不转换或删除旧 Rust/PostgreSQL 数据。

## 迁移与密码恢复

统一入口也提供 serve、migrate 和 reset-password。`pnpm server` 默认启动服务。停服后运行：

```bash
pnpm server migrate
read -rs recovery_password
printf '%s\n' "$recovery_password" | pnpm server reset-password --email member@example.test
unset recovery_password
```

迁移输出实际验证的 schema 版本，不启动设备或清理循环。密码操作通过标准输入读取新密码，不把密码写入输出。它保留用户身份，撤销旧会话并记录 system 审计。重新启动服务后，用新密码登录。原 `pnpm reset-password --email ...` 入口仍可用。

源码归属：[统一 CLI](../../apps/server/src/cli.ts)、[归档组合](../../apps/server/src/operations.ts)、[staging 所有权与恢复](../../apps/server/src/archive-workspace.ts)、[共享密码操作](../../apps/server/src/password-operation.ts)、[数据库历史与打开能力](../../packages/server/src/platform/db/index.ts)、[关闭后的数据库快照](../../packages/server/src/platform/db/snapshot.ts)和[Files ready 引用](../../packages/server/src/core/files/archive.ts)。

## 启动与关闭的资源归属

服务先取得目录锁并迁移，完成设备中断恢复，再启动各自的调度器、设备循环、订阅和 HTTP。每个 owner 取得资源时立即登记关闭动作；后续准备失败也会调用这些动作。

关闭先停止 HTTP 接入，同时结束订阅、停止服务定时器与设备接入。全部已登记 owner 都尝试关闭；一个错误不会跳过其他 owner。服务等待已接入 HTTP 校验、设备报告和数据库操作，再关闭数据库并释放目录锁。原始启动或关闭错误保留在结果与日志中，失败退出不描述为成功。

组合入口见 [runtime](../../apps/server/src/runtime.ts)。原 prepared.stop 回调继续受支持；新增 owner 使用 RuntimeControl.ownStop 在取得资源时登记。

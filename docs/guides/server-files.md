# 发布文件与业务引用

目标：在真实 Application 用例中复用 FileService，保持文件、业务记录、引用与审计的提交边界。先完成[平台指南](server-platform.md)。需要已有的 `FoundationContext`、`AuthPolicy` 与初始化的 `FileService`；[runtime.ts](../../apps/server/src/runtime.ts)拥有实际组合。

当前服务注册签名字节路由 `/objects/:id`。它没有通用文件 JSON API；下方操作是供真实 Application handler 使用的服务端能力。Lab GLB 规则和业务路由由 Lab 拥有，仍待迁移。

## 创建上传并发送字节

在 Application handler 中，先通过 `requireAccess(context, auth, headers, requestId, 'lab:full', true)` 取得 actor。请求已位于 Core 的 HTTP operation 计量范围中。然后在现有 `DbSession` 中调用 `service.start(tx, actor, input)`。

`input` 是 `UploadInput`：`file_name`、`content_type`、`size` 与 64 位十六进制 `sha256`。`size` 为实际字节数。读取源字节并计算摘要在数据库事务之外完成。返回值包含 `upload_id`、状态和 `upload` capability。

调用方按 capability 返回的完整 URL、method 和 headers 发送原始字节。不要手工拼接 URL。

```ts
if (!capability.upload) throw new Error('No pending upload');
const response = await fetch(capability.upload.url, {
  method: capability.upload.method,
  headers: capability.upload.headers,
  body: bytes,
});
if (response.status !== 204) throw new Error('Upload failed');
```

`PUT` 成功为 204。服务流式检查字节上限与 SHA-256，并保存 staging 字节；此时文件还没有发布给业务。返回 400 的错误摘要不会发布文件。重新发送正确字节可恢复。URL 过期返回 410；开始新的上传。

## 验证同一份不可变字节并发布

完整最小适配代码位于 [attach-file.ts](../examples/attach-file.ts)。它接受真实业务的 validator、publish 与逻辑引用；不创建模拟 Lab 表或新的 JSON 路由。

<<< ../examples/attach-file.ts

`validate(candidate)` 在摘要、声明大小和通用格式检查完成后运行。它通过 `candidate.read()` 读取刚验证并采用的不可变字节。验证期间持有该哈希的文件锁，未持有数据库事务。validator 应流式读取并施加自己的业务预算。拒绝时抛出 `PublicFailure`，其状态与错误码会保留；未知错误返回 503。validator 必须避免数据库写入与不可逆副作用。

`publish(tx, file, transitioned)` 在最终数据库事务中运行。业务在这里写入自己的记录与审计。示例随后在同一 `tx` 调用 `pin`，将文件关联到 `ownerType` 和 `ownerId`。Core 同时提交 ready 状态、candidate 和 `files.complete` 审计。回调或审计失败会一起回滚；已采用的物理字节可能留下，后续清理负责回收。

重试已 ready 的文件仍会验证真实字节并执行回调。`transitioned` 为 false 时表示本次没有从 pending 转为 ready；业务必须处理自己的 replay，不可再次插入相同业务结果。Core 只在实际状态转换时写一次完成审计。

最终事务重查原会话或 key 的精确身份与资格。I/O 期间退出、撤销、过期或停用创建者都不能凭原 actor 发布。取得新的有效凭据后，按业务恢复路径重试；不能把旧 actor 当成新的授权。

## 下载、释放与清理

授权后，在 `DbSession` 中调用 `service.download(tx, actor, fileId)`。返回 `DownloadCapability` 包含 GET URL、headers、期限和文件元数据。GET 200 返回原字节；用同一 GET capability 请求 HEAD 返回 403。到期后重新请求下载 capability。签名 URL 本身允许持有者在期限内读取字节；撤销凭据会拒绝后续发布和新的 capability，不自动撤销已发出的 URL。

业务删除或替换引用时，在同一事务调用 `service.release(tx, fileId, reference)`。需要显式删除逻辑文件时调用 `dispose`。仍有 pin 或真实外键消费者时返回 409；先移除自己拥有的业务引用，再重试。相同哈希可属于多个独立逻辑文件，释放一个不会删除另一个的字节。

Core 文件 scheduler 重试 deleting intent、到期 staging 与孤儿对象。每次清理最多处理 50 个逻辑文件；rescan 每次处理 100 个目录项并推进游标。目录发现仍读取和排序全部名称，这不是恒定延迟保证。未知格式名称、活跃文件、pin 与真实外键引用均保留。

字节和 staging 存在 `LAB_WORD_DATA_DIR/blobs`；稳定签名密钥存在 `secrets/file-signing-key`。新密钥写入并 sync 临时文件，再通过 no-overwrite link 发布。普通失败移除该临时文件；强杀可以留下私有临时文件。启动保留已有有效 key，遇到未知短 key 时拒绝启动，不自动覆盖。已有签名在同目录进程重启后仍可使用，直到其原期限；这不是断电耐久性保证。

## 验证拒绝与恢复

从仓库根目录执行：

```bash
pnpm typecheck
node --test --experimental-strip-types tests/server/core-files.test.ts tests/server/core-file-authority.test.ts
```

类型检查包含教学适配代码。实际能力测试运行真实 HTTP 字节路由与嵌入数据库，验证大小、格式、摘要、不可变 validator、撤销、回调和审计回滚、GC/adoption 并发、签名与恢复。测试使用拥有的临时目录，完成后删除；不会打开 `data/`。实际 Lab GLB 验证仍由后续 Lab 断言负责，见[逐断言映射](../testing/vnext-core-assertions.md)。

配置与 DTO 以[生成配置](site:reference/config.md)和[生成 API](site:reference/api.md)为准。Core [FileService](../../packages/server/src/core/files/use-cases.ts)拥有逻辑生命周期，[Platform BlobStore](../../packages/server/src/platform/blob-store.ts)拥有流式物理 I/O，Application 拥有业务 validator、引用与事务回调。

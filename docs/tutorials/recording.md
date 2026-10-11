# 采集和检查一次 Lab Recording

目标：运行一次 Simulation Session，读取它的初始条件、可靠运动片段和事件，再检查完整性并独立删除录制。

先完成[固定场景与仿真会话](simulation-session.md)。保留该章的 `Shared Session` Lab、Installation、GLB 资产和开发数据目录。使用仓库指定的 Node、pnpm，以及安装了固定 `websockets` 依赖的 Python 环境。以下 Bash 命令从仓库根目录运行。本章使用 Synthetic 开发来源，不需要 Newton、GPU 或 Docker。

## 采集一次运行

如果前一章的服务已停止，用相同目录启动：

```bash
LAB_WORD_SYNTHETIC_SESSION=true LAB_WORD_SYNTHETIC_PYTHON="$PWD/.scratch/session-python/bin/python" LAB_WORD_DATA_DIR=.scratch/session-tutorial-data pnpm dev
```

1. 打开 <http://127.0.0.1:5173/lab>，以普通 Member 登录。
2. 打开 `Shared Session` Lab 和**仿真会话**。
3. 选择原 Installation，点击 **Start**。
4. 等待**正在运行**和**运动已连接**。
5. 点击 **Pause**，等待已暂停。
6. 等待数秒，再点击 **Resume**。
7. 等待运行数秒，点击 **Stop**，等待已停止。

Start 自动创建一份 Recording。服务先保存并同步初始条件，再接受可靠来源的版本头和第一帧。正在运行表示初始可靠采集和实时运动都已通过准入。它不表示机器人任务成功。

来源在选定采样处保留每个完整运动帧，再交给直播发送槽。直播可以覆盖较旧的待发送帧。没有 Viewer、Viewer 离开或较慢时，Recording 仍保留每个选定采样。这里的选定采样不等于每个物理求解步。

## 读取录制和实际片段

在已登录 Lab 页面的浏览器 Console 中运行：

```js
(await (await fetch('/api/v1/lab/labs')).json()).data.map(({ id, name }) => ({
  id,
  name,
}));
```

把 `Shared Session` 的 UUID 替换到下面的请求中。它读取有界的第一页，不改变 Lab：

```js
(
  await (await fetch('/api/v1/lab/labs/<lab-uuid>/recordings?limit=5')).json()
).data.map(({ id, session_id, status, integrity, reason }) => ({
  id,
  session_id,
  status,
  integrity,
  reason,
}));
```

找到刚结束的 Session 对应的 Recording UUID。将下面的完整示例粘贴到 Console：

<<< ../examples/recording-inspection.js

运行 `await inspectRecording('<lab-uuid>', '<recording-uuid>')`。

预期结果包含 Recording 和 Session 身份、`status`、`integrity`、`reason`、可靠 `prefix`、版本摘要、片段及事件第一页。正常 Stop 完成后，`status` 和 `integrity` 为 `complete`，`prefix.source_ended` 为 `true`。如果仍在完成最后片段，稍后重新读取。不要把暂时的 `open` 当作已完成。

示例最多读取五项片段和五项事件，并读取其中一个已封存片段。它检查该片段的字节数和 SHA-256，再核对最前面的最多 16 个 LWF 记录。`first_record` 通常是启动头。`source_header` 显示这些记录中已接受的来源版本头。它为 null 时，需要继续检查后续记录，不能推断依赖版本。`verified_segment_id` 为 null 时，该页还没有已封存片段；Stop 后重新读取。

片段是原始事实容器。每个 LWF 记录包含小端 u32 JSON 长度、32 字节 SHA-256 和 UTF-8 JSON。`source.packet` 记录中的 `packet_base64` 保存原始 LWR1 字节；运动批次保留原始 LWM1 帧。这些字节可独立核对，不用 Gateway 的最新帧推断录制内容。

## 理解时间和完整性

| 字段                               | 如何读取                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `snapshot_hash`、`manifest_sha256` | 当次固定快照和清单的身份。当前布局与资产更新不会改写它们。                                |
| `capture_baseline`                 | 采集开始时普通设备的实际状态、在途 Command 和时间。Reset 保留原物理快照，并另存当前基线。 |
| `versions`、`source.header`        | 服务版本与来源报告的代码、Python、依赖版本。未知值保持 null；来源报告不是独立的安装证明。 |
| `recorded_at`                      | 服务记录事实的真实时间。普通设备的时间在物理 Pause 期间继续。                             |
| `sim_time_ns`                      | 来源的仿真时间，使用十进制字符串。普通 Device Program 事件为 null。                       |
| `prefix`                           | 已同步确认的连续来源前缀。运动序号、来源事件序号和全局记录 ordinal 各有含义。             |
| `incomplete`、`reason`             | 只保证已保留的有效事实。未确认的尾部可能未知，不能把它解释为没有活动。                    |

Pause 和 Resume 各保存一个新边界帧及 `lifecycle.applied` 事件。Resume 边界可以与 Pause 边界具有相同仿真时间，但序号递增。Stop 还保存最终来源序号与来源结束事实。完成状态还要求服务器事件和最终片段已保存。

Reset 结束旧 Session 和 Recording，再创建两个新身份。新来源从仿真时间零开始。旧 Recording 的时间不倒退。普通 Device Program Run 保留自己的实时行为；物理 Pause、Reset 或 Stop 不替它停止任务。

`capture_entity_ids` 固定当次 World 的对象集合。`physics_entity_ids` 只包含 Installation 的物理绑定对象。后来创建的 Entity 不加入这份旧录制。缺少属性的先前值仍为未知。

可靠 ACK 只确认已完成文件同步的连续来源事实。网络发送完成、实时帧接收和动作已执行是不同确认。缓存或存储容量不足、写入失败、确认超时及来源异常都会停止或中断 Session，并保留明确的不完整状态。不会自动重放动作。

## 分页和 SDK

以下读取都要求同一个 Lab 的有效 Member 身份，或具有 `lab:full` 的 Agent key：

| 方法和路径后缀                                         | 结果                                         |
| ------------------------------------------------------ | -------------------------------------------- |
| `GET /recordings`                                      | Recording 元数据页。                         |
| `GET /recordings/{recording_id}`                       | 一个 Recording 的元数据和完整性。            |
| `GET /recordings/{recording_id}/manifest`              | 固定快照、当前采集基线、对象集合和版本清单。 |
| `GET /recordings/{recording_id}/segments`              | 片段元数据页。                               |
| `GET /recordings/{recording_id}/segments/{segment_id}` | 一个片段的实际字节。                         |
| `GET /recordings/{recording_id}/events`                | 已确认事件页。                               |

这些后缀都位于 `/api/v1/lab/labs/{lab_id}` 下。列表 `limit` 默认为 20，允许 1 到 100。事件页还受 256 KiB 预算约束。保留 `next_cursor`，将它作为 `cursor` 传入同一列表的下一次请求。片段和事件游标绑定当前 Recording。改变 Lab、Recording 或筛选时，从第一页重新读取。

生成 SDK 提供相同的列表和读取方法。[readRecordingSegment](../../packages/sdk/src/recording.ts) 读取并核对一个已封存片段，最多 1 MiB。调用者持有 AbortSignal，并决定何时替换当前页。不要将整个 Recording 的片段合并到内存中。

## 独立删除

1. 使用相同 Installation 再 Start、运行数秒并 Stop，得到 Recording B。
2. 读取 A 和 B。确认它们有不同 Recording、Session 身份，并引用同一固定 GLB 版本。
3. 保存 B 的一个已封存片段身份和 SHA-256。
4. 显式运行 `await deleteRecording('<lab-uuid>', '<recording-a-uuid>')`。
5. 重新查询 Recording 列表，确认 A 已移除。
6. 再运行 `inspectRecording` 读取 B，确认其原片段和 SHA-256 仍可读取。

删除是持久操作。该函数使用当前 Member 的 CSRF token。活动 Recording 返回 409；先 Stop，再显式删除。无效身份返回 401，缺少权限或 CSRF 返回 403，跨 Lab 或不存在的身份返回 404。取得有效身份后，重新执行你的明确请求。

Recording 持有自己的精确资源引用。删除 A 只释放 A 的引用。B、当前资产或其他消费者仍引用的文件保留。普通设备历史清理也不删除这些 Recording 事实。

## 制造一次隔离的写入失败

从仓库根目录运行这个真实进程合同案例：

```bash
node --test --test-concurrency=1 --experimental-strip-types --test-name-pattern='recording write failure' tests/e2e/recording-reliability.test.ts
```

先运行过 `pnpm install --frozen-lockfile`，并使用仓库指定的 Node 版本。此案例不需要 Python、GPU 或正在运行的教程服务。它创建自己的临时数据目录、loopback 服务和经鉴权的 Machine 来源。

案例先发送并保存外部已确认的 t0 字节。然后通过测试进程的 IPC，在下一次 `source.packet` 文件写入前触发一次失败。它再次发送一个选定运动帧，并从正式 API 检查结果。

预期 Node 测试通过，并输出非敏感的 `recording-write-failure` 回执。下一帧没有耐久 ACK。Session 中断，Recording 为 incomplete，原因标明写入失败。原来已经确认的完整 t0 字节仍可通过片段接口读取。案例清理自己的进程、socket 和临时数据目录，并核对 ownership ledger。

IPC 故障只在该隔离测试进程中生效。教程数据保持原样。

来源崩溃或服务进程被强杀后，重新打开相同数据目录会保留可校验的有效片段，并中断旧 Session。未确认的尾部可以未知。耐久范围覆盖实际来源和服务进程终止、同步及重开检查；没有测试操作系统崩溃或断电保证。重新开始需要显式创建新 Session。

## 结束

Stop 活动 Session，关闭 Viewer，再用 Ctrl+C 停止开发服务。监管器释放自己的 Python 来源、两条 socket 和定时器。保留 `.scratch/session-tutorial-data` 和 Python 环境，或在确认没有消费者后独立移除它们。

查看[Lab 运行记录](lab-records.md)了解普通历史的查询与保留策略。Recording 查询表达当次已保存的事实；Replay、外部渲染、远程 Newton 和物理任务仍是后续工作。

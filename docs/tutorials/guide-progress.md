# 保存个人引导进度

本章为当前用户保存 Lab 首次使用引导的学习状态。继续使用前章的 Lab 接口、身份和 SDK。没有 Lab 也可以开始本章；企业已有 Lab 不会使新成员变成已完成。

## 运行真实 SDK 示例

在仓库根目录安装依赖并启动 Node 服务：

```sh
pnpm install
pnpm dev
```

已有 Node 数据目录在启动时应用新增迁移。服务默认监听 `127.0.0.1:3000`。在普通账户的 API key 页面创建有效的 `lab:full` 凭据，并设置环境变量：

```sh
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_API_KEY='<自己的有效 lab:full 凭据>'
node examples/lab/guide-progress.mjs
```

示例通过生成的 `getLabGuideProgress` 和 `saveLabGuideProgress` 读取当前用户，保存暂停状态，再发出一次旧版本写入。输出中的 `conflict` 为 `lab.guide_progress_conflict`；随后公开读取返回已保存记录。它只写个人学习状态，不创建 Lab、登记对象、保存布局或操作设备。

如果当前引导已经完成，示例输出 `completed_position_review`，不写入记录。位置回顾保留首次完成状态。

<<< ../../examples/lab/guide-progress.mjs

## 状态、版本与身份

正式入口是 `GET` 和 `PUT /api/v1/lab/guides/{guide_id}/{guide_version}/progress`。当前引导为 `lab-onboarding`，版本为 `1.0`。没有记录时，GET 返回 `not_started`、revision `0`，其步骤、尝试、上下文和更新时间均为 `null`。GET 不创建进度记录。

| 状态                    | 写入内容                                                |
| ----------------------- | ------------------------------------------------------- |
| `not_started`           | step、guide_attempt_id、context 均为 `null`             |
| `in_progress`、`paused` | 稳定步骤及 UUID guide_attempt_id；步骤不能为 `complete` |
| `completed`             | step 为 `complete`，保留 UUID guide_attempt_id          |

步骤使用 `create_lab`、`register_light`、`select_entity`、`edit_placement`、`save_layout`、`return_run`、`start_program`、`light_action`、`verify_observation`、`asset_library` 和 `complete`。对象名称、翻译文字和提示库步号不是步骤或对象身份。

owner 来自当前 Member 会话或 Agent 凭据。PUT 不接受 owner、更新时间或已提交业务收据。一个用户的多个有效凭据访问同一记录；另一个成员拥有独立记录，即使两人访问同一个 Lab。

## 关联真实上下文

没有 Lab 时使用 `context: null`，或只保存没有目标 Lab 的创建尝试指针。创建、登记后，可在下一次进度 PUT 中关联公开接口返回的 UUID：

```json
{
  "expected_revision": 1,
  "status": "paused",
  "step": "edit_placement",
  "guide_attempt_id": "<本次引导 UUID>",
  "context": {
    "lab_id": "<实际 Lab UUID>",
    "entity_id": "<实际 Entity UUID>",
    "node_id": "<实际 Scene Node UUID>",
    "business_attempt": {
      "operation": "register_entity",
      "target_lab_id": "<同一个 Lab UUID>",
      "request_key": "<原业务尝试键>"
    }
  }
}
```

新引用必须属于该 Lab；Node 必须匹配给出的 Entity。共享对象可作为上下文，不要求由本人创建。对象改名后仍按 UUID 查找。已经验证过的原引用在归档或 Node 移除后可以保留并暂停；读取不会换成同名对象。普通 World 和对象接口用于判断目标当前是否可用。

`business_attempt` 只是客户端意图指针。`create_lab` 不带目标 Lab；`register_entity` 指向 context 中的 Lab。尚未提交的键也可以保存。它不证明业务已经提交，不授权重试创建或设备动作，也不保存布局草稿。业务收据恢复有独立责任，不能用进度代替。

## 冲突、拒绝与恢复

PUT 必须提交当前 `expected_revision`。成功提交只增加一次 revision。两个并发写入使用同一 revision 时，一个成功，另一个返回 409。旧请求重复提交仍为冲突；它不是业务幂等重放。

409 后先 GET 当前记录，保留本地输入，再由用户明确选择是否基于新 revision 重试。认证、CSRF、引用、版本或存储拒绝不会改写旧进度。审计失败和进度写入在同一事务回滚；服务恢复后可继续公开读取和写入。

Member 的会话写入继续检查 Origin 与 CSRF。Agent 需要有效 `lab:full`。失效或撤销凭据、退出登录和停用成员后拒绝访问；无效 Bearer 不会回退到同请求中的 Cookie。重新登录后读取同一用户的记录，不根据共享 Lab 的存在猜测个人状态。

旧版本可读取原步骤和上下文，兼容结果为 `unsupported`。当前版本没有开始而存在旧记录时返回 `restart_required` 和 `previous_progress`。选择新版本必须明确发起当前版本 PUT；旧记录不会转换或自动重播。示例遇到该结果时默认只读取，确认后可设置 `LAB_GUIDE_START_CURRENT=true`。

## 边界与来源

进度保存不改变 World、布局版本、Run、Command、Task 或其结果。学习状态不证明设备成功；设备结果仍以正式接口和同来源有效 Observation 为准。

请求上限 8 KiB，context 上限 4 KiB。完整读取最多 6 SQL、12 KiB 响应；保存最多 8 SQL、6 KiB 响应。revision 使用安全 JSON 整数，溢出拒绝。既有 World、SSE、历史和包体预算不变。

合同来自 [进度 DTO](../../packages/server/src/lab/progress/dto.ts)，事务来自 [进度服务](../../packages/server/src/lab/progress/use-cases.ts)，预算来自 [领域定义](../../packages/server/src/lab/progress/domain.ts)。[公开 HTTP 验证](../../tests/server/lab-guide-progress.test.ts)覆盖两个成员、Agent、冲突、拒绝、旧版本和回滚。新增 [0001 迁移](../../packages/server/migrations/0001_guide_progress.sql)保留原始 0000 字节和历史；有效旧备份先验证原始清单，再在隔离恢复目录升级。

# 归档对象并替换外观

当前服务使用 Node 24 与 TypeScript，默认验证 desktop web。命令在仓库根目录运行；Linux/Windows 不需要 Docker。实现入口见[Node 设备](../guides/server-devices.md)、[同步](../guides/server-sync.md)和[追溯](../guides/server-traceability.md)。

目标：移除并放回设备的 Scene Node（场景节点），替换 GLB 外观，在任务结束且程序停止后归档设备。

## 起始版本

使用包含本章 Node 实现的当前 checkout 与共享 schema。先完成[运行历史](run-history.md)，取得可查询记录和保留策略。

命令从仓库根目录运行。用 `pnpm dev` 启动服务。使用可丢弃的 Lab 数据；这些操作会修改持久数据。

Member 需要有效会话，写入需要 CSRF。Agent 需要有效的 `lab:full` 密钥。两类调用者遵守相同生命周期规则。

源码：[生命周期 HTTP](../../packages/server/src/lab/world/lifecycle.ts)、[Inspector 控件](../../packages/views/src/lab/entity-lifecycle-panel.tsx)和[迁移](../../packages/server/migrations/0000_foundation.sql)。

## 移除并放回节点

使用前章的设备。从**对象信息**记录它的 Entity（实验室对象）身份。

1. 在 Lab 选择设备。
2. 选择**编辑布局**。
3. 在节点身份旁选择**移除节点**。
4. 保存布局。

   节点消失，Entity、Binding、Run、Task 和保留期内历史仍存在。

5. 在对象目录勾选**仅未放置对象**。
6. 选择设备。
7. 选择**新增同一对象表示**。
8. 保存布局。

   API 创建新的 Scene Node，Entity 身份不变。

## 在程序运行期间替换外观

先在资产库导入有效 GLB。先保存或放弃布局草稿。

1. 选择设备。
2. 启动程序。
3. 在**对象生命周期**选择**更换外观**。
4. 在**外观表示**选择导入资产。
5. 选择**保存**。

   API 更新 Entity 及其全部当前 Scene Node，保留节点身份和 Placement。存在节点时，布局版本推进。

6. 核对 Entity、Binding 和 Run 身份。
7. 在**运行历史**打开**任务**。

   身份、程序、配置和任务历史保持不变。未结束 Task 期间也可以替换外观。

任意 GLB 没有转子映射。浏览器不推断转子节点或轴。设备读数仍显示报告值和单位。内置离心机外观保留明确的转子映射。

布局保存返回 `409 lab.layout_conflict` 时，保留草稿。重新读取已保存布局，再应用编辑。外观替换推进布局版本，保护并发草稿。

## 拒绝归档并恢复

停止程序前，先完成或取消在途 Task。取消必须等减速结束。已保留的 `pending` Task 同样阻止生命周期变更。

1. 在程序运行期间选择**归档对象**。
2. 在确认窗口选择**归档**。

   API 返回 `409 lab.entity_in_use`，身份、配置和记录保持不变。

3. 选择**取消**关闭确认窗口。
4. 完成或取消当前 Task。
5. 等待最终结果。
6. 选择**停止程序**。
7. 选择**归档对象**。
8. 在确认窗口选择**归档**。

   Inspector 显示**已归档**，目录打开**已归档对象**。Entity 和保留期内记录仍可查询。

9. 选择已归档 Entity。

   启动程序按钮禁用。直接发送新动作返回 `409 lab.entity_archived`。

视口隐藏已归档对象。归档保留节点数据、关系和资产引用，不延长历史保留期。API 不提供 Entity 彻底删除操作。

## 显式选择定义

使用另一台未归档模拟设备。先结束 Task，再停止程序。

1. 选择**更换定义与程序**。
2. 在**定义版本**选择**环境温度传感器 · 1.0**。
3. 选择**保存**。

   Entity 保留身份。API 记录所选定义版本与快照。支持运行的模拟定义获得新的 Binding。

4. 显式启动程序。

   新 Run 使用所选关联。旧 Run 保留原定义、程序和来源。旧 Task 仍指向原 Run。

定义 id 不变时，UI 保留配置。选择另一种定义时，UI 使用默认配置并保留标签。HTTP 调用者提供完整的新配置。

本目录只有模拟 `light`、`sensor` 和 `centrifuge` 定义获得已实现的 Binding。静态或描述型选择没有当前 Binding。旧 Binding 保留为原 Run 的来源。真实对象保持独立身份，本版没有已实现的真实设备 Binding。这些对象没有启动程序控件。

API 只接受目录内定义。用户不能编辑任意 schema 或执行代码。无效版本返回 `400 lab.invalid_reference`。变更定义前，先解除不兼容的 `simulates` 或容纳关系。

## 核对资产引用

已归档 Entity 仍保护其外观资产。

1. 打开资产库。
2. 尝试删除被引用资产。

   API 返回 `409 lab.asset_in_use`，资产仍可用。

3. 在每个引用 Entity 选择**更换外观**。
4. 选择**内置外观**。
5. 选择**保存**。
6. 移除其余仅由节点持有的引用。
7. 在资产库删除资产。

   全部真实引用解除后，删除才成功。Node 文件调度器随后回收文件。

## 使用相同 HTTP 合同

示例会归档所选设备。使用可丢弃、已停止且没有未结束 Task 的设备。从 Inspector 和资产库响应获取 UUID。

1. 设置 API 地址。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. 设置 Lab 身份。

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. 设置 Entity 身份。

   ```bash
   export LAB_ENTITY_ID='<entity-uuid>'
   ```

4. 设置导入表示身份。

   ```bash
   export LAB_REPRESENTATION_ID='<representation-uuid>'
   ```

5. 设置其 Asset 身份。

   ```bash
   export LAB_ASSET_ID='<asset-uuid>'
   ```

6. 读取有效 API 密钥。

   ```bash
   read -rs LAB_API_KEY
   ```

7. 导出密钥。

   ```bash
   export LAB_API_KEY
   ```

8. 运行示例。

   ```bash
   node examples/lab/manage-entity.mjs
   ```

   示例核对运行中拒绝、外观身份、显式 `sensor@1.0` 关联、旧 Run 含义、归档和引用保护。

完整请求与断言：

<<< ../../examples/lab/manage-entity.mjs

| 操作 | 请求                                                                              | 结果                                                              |
| ---- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 归档 | `POST /api/v1/lab/labs/{lab_id}/entities/{entity_id}/archive`                     | 返回带 `archived_at` 的 Entity；运行中 Run 或未结束 Task 返回 409 |
| 外观 | `PUT .../appearance`，提供 `representation_id`                                    | Entity 和当前节点使用所选表示；null 选择内置外观                  |
| 定义 | `PUT .../definition`，提供 `definition_id`、`definition_version`、`configuration` | 显式关联；运行中 Run、未结束 Task 或归档 Entity 返回 409          |
| 查询 | `GET .../entities/{entity_id}` 和现有 Run/Task/历史路径                           | 保留身份与原来源含义                                              |

定义变更或归档后，同 key 的 Command 重试仍遵守原合同。保留中的 Command 返回原记录。过期 Command 返回 410。变更参数返回 409。这些检查不会创建新工作。

## 下一阶段

[旧 Foundation 旅程](complete-foundation.md)保留历史版本及 100 Entity、20 台设备、两个浏览器的负载参考，不是本章的启动版本。完整 Node 客户端旅程将在后续客户端迁移中验证。真实设备接入仍属后续范围。

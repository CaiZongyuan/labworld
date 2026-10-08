# 完整数字实验室旅程

目标：让 Member 与 Agent 建立同一个 Lab。导入外观、摆放对象、运行设备、查询结果并归档 Entity。

## 起始版本

使用包含本章及迁移 `0018` 到 `0028` 的 Foundation V1 工作副本。此前集成基线为 `c6c3063`。全部章节保持这个工作副本。以下能力均已实现，使用持久服务器数据和后端虚拟程序。

命令在仓库根目录的 Bash 终端运行。准备 curl、Node、pnpm、Rust 和 Docker，见[快速开始](../getting-started/quickstart.md)。使用可丢弃的开发数据。以下操作创建持久资产、Entity 和记录，不是隔离预览。

Member 需要有效会话；会话写入需要 CSRF。Agent 需要有效的 `lab:full` API 密钥。两种调用者均有完整 Lab 权限，并遵守同一业务规则。

1. 安装锁定的依赖。

   ```bash
   pnpm install --frozen-lockfile
   ```

2. 启动开发栈。

   ```bash
   pnpm dev
   ```

3. 打开 <http://127.0.0.1:5173/lab>。
4. 以 Member 身份登录。
5. 创建名为 `Complete Foundation Lab` 的空 Lab。

   对象目录为空。Lab 数据已在服务器持久保存。

6. 打开 **设置 → API 密钥**。
7. 创建带 `lab:full` 范围的密钥。

   在开发终端中保持 `pnpm dev` 运行。停止它会排空并关闭 Node 与 Web，保留所选数据目录。

8. 在仓库根目录打开第二个 Bash 终端。
9. 设置开发栈输出的 API 地址。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

10. 读取密钥，不显示其内容。

    ```bash
    read -rs LAB_API_KEY
    ```

11. 导出密钥。

    ```bash
    export LAB_API_KEY
    ```

12. 查询 Lab 列表。

    ```bash
    curl --fail --silent --show-error \
      --header "Authorization: Bearer $LAB_API_KEY" \
      "$LAB_API_BASE/api/v1/lab/labs?limit=100"
    ```

    在 `data` 中找到 `Complete Foundation Lab`。`id` 就是 Lab UUID。若 `has_more=true`，使用 `next_cursor` 继续查询。

13. 将该 UUID 设置为 `LAB_ID`。

    ```bash
    export LAB_ID='<lab-uuid>'
    ```

剩余命令使用第二个终端和同一个 `LAB_ID`。将 UUID 占位值替换为响应中的实际值。

## 建立并操作同一世界

这些脚本就是此前章节的完整请求。脚本断言验证公开 HTTP 结果。

1. 让 Agent 导入仓库 Draco 文件。

   ```bash
   node examples/lab/import-asset.mjs tests/fixtures/lab/cube-draco.glb
   ```

   记录返回的 `id` 和 `representation_id`。下载字节的 SHA-256 与上传内容相同。

2. 在 Member 浏览器打开 **资产库**。
3. 导入 `tests/fixtures/lab/cube-basis.glb`。
4. 发布资产。

   资产库包含两份导入和内置分类。本练习使用仓库文件；自己的文件应填写准确的来源和许可。

5. 打开同一个 Lab。
6. 用 **自定义模型 · 1.0** 和 Basis 资产外观登记 `Member model`。
7. 用 **实验室空间 · 1.0** 登记一个静态 Environment。
8. 让 Agent 登记独立的描述型 Robot。

   ```bash
   node examples/lab/register-world.mjs
   ```

   `Robot A` 与 `Robot B` 的 Entity 身份不同。声明的动作返回 `422 lab.capability_not_implemented`。

9. 加入工作台、Labware 和显式关系。

   ```bash
   node examples/lab/edit-layout.mjs
   ```

   脚本复用 `LAB_ID`，验证人工来源、冲突、独立副本、多节点及移除/放回。

10. 运行两台独立照明。

    ```bash
    node examples/lab/control-lights.mjs
    ```

    脚本验证观测、同键重试、参数改变后拒绝，以及 Stop 后保留的读数。

11. 运行两个独立温度来源。

    ```bash
    node examples/lab/observe-temperature.mjs
    ```

    每个读数带 `degC`、时间、来源和新鲜度。一个停止的来源过期，另一个继续采样。显式启动会创建新 Run。

12. 运行两台离心机的 Task。

    ```bash
    node examples/lab/run-centrifuges.mjs
    ```

    第一个 Task 经准备、达标后六秒计时和减速得到 completed。另一个经 Stop 和减速得到 cancelled。两台设备回到 idle。记录第一个 `entity_id`。

13. 通过订阅读取世界快照。

    ```bash
    node examples/lab/observe-world.mjs --once
    ```

    输出包含持久世界版本。服务就绪状态独立于该版本。

14. 设置已完成离心任务的 Entity UUID。

    ```bash
    export LAB_ENTITY_ID='<first-centrifuge-entity-uuid>'
    ```

15. 查询保留范围内的记录。

    ```bash
    node examples/lab/query-history.mjs
    ```

    已完成 Task 含结果。观测、Command 和事件各自保留时间。`gap` 标明更早历史不可用。

## 恢复草稿和设备

使用选中的离心机，并在另一个独立浏览器登录同一部署。Task 已结束，程序仍运行。

1. 在第二浏览器打开同一个 Lab。
2. 在第一浏览器选择离心机。
3. 选择 **编辑布局**。
4. 将 **X (m)** 设为 `2.25`。
5. 断开第一浏览器的网络。

   页面显示 **连接中断**。最后世界和 `2.25` 草稿仍可见。

6. 恢复网络。

   页面恢复 **实时同步**。草稿仍为 `2.25`。

7. 保存布局。

   两个浏览器和 API 显示保存后的 Placement。登记关系的含义和来源保持原样。

8. 移除设备的 Scene Node。
9. 保存布局。

   Entity、Run、Task 和结果仍可查询。

10. 选择 **仅未放置对象**。
11. 选择设备。
12. 新增同一对象表示。
13. 保存布局。

    新节点表示原来的 Entity。设备和记录身份保持原样。

当前页面在断线恢复和切换 Lab 后保留草稿。离开或刷新页面不会保留未保存草稿。刷新前应保存。遇到 `409 lab.layout_conflict` 时，选择 **重新载入并保留草稿**，再 **重试保存**。见[布局恢复](edit-layout.md)。

## 归档并保留结果

运行中的 Run 或未结束 Task 会阻止归档和定义修改。离心 Stop 后须等待减速完成，Task 才结束。

1. 在已完成任务的离心机上选择 **停止程序**。
2. 设置导入的 Draco 表示 UUID。

   ```bash
   export LAB_REPRESENTATION_ID='<draco-representation-uuid>'
   ```

3. 设置其 Asset UUID。

   ```bash
   export LAB_ASSET_ID='<draco-asset-uuid>'
   ```

4. 执行生命周期请求。

   ```bash
   node examples/lab/manage-entity.mjs
   ```

   脚本验证运行中拒绝、外观替换、显式定义选择、归档和引用保护。Entity 保留已完成 Task 和结果。旧 Run 保留原定义和来源。

5. 在任一浏览器打开 **已归档对象**。
6. 选择已归档 Entity。
7. 通过原公开路径查询 Task 或历史。

   新程序启动返回 `409 lab.entity_archived`。视口隐藏已归档节点，节点数据和资产引用仍在。任意 GLB 不会自动获得转子映射。

## 复现参考负载

这些检查在空闲端口创建可丢弃服务，不使用开发数据。命令结束后移除自己的资源。现有限流保持启用。

两条浏览器命令各自创建 PostgreSQL、Redis、对象存储和邮件服务。独立栈可防止此前请求消耗参考负载的同一 IP 限流窗口。

1. 运行完整旅程。

   ```bash
   node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-foundation.spec.ts
   ```

2. 运行参考负载。

   ```bash
   E2E_LAB_REFERENCE_LOAD=1 node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-reference-load.spec.ts
   ```

3. 运行确定性 Lab HTTP 预算。

   ```bash
   node scripts/test-backend.mjs --test perf_lab --test lab_sync --test lab_history
   ```

参考场景包含 100 Entity 和 100 个已放置、未归档节点。20 个温度程序各以每秒一条报告为目标。两个 Chromium 浏览器打开同一 Lab。77 个模型节点共享两份独立上传资产：Draco 几何和 Basis 纹理文件。

报告记录各设备实际报告数、模型与嵌入纹理字节数、浏览器、硬件、存储、快照、SSE 载荷和渲染采样。应用证据保存在 `.scratch/foundation-v1/application/`。文档浏览器输出使用独立目录。

| 合同                                   | 上限                                  |
| -------------------------------------- | ------------------------------------- |
| 世界快照 SQL statement，含 Member 认证 | 10 次；1 和 100 Entity 相同           |
| SSE 事件                               | 1 MiB                                 |
| 待发送 SSE 事件                        | 8 条；溢出发送 resync 并关闭          |
| Lab、资产及历史分页                    | 最多 100 项                           |
| 历史响应                               | 256 KiB                               |
| 历史时间范围                           | 最多 31 天                            |
| 每 Lab 的 Entity 和 Scene Node         | 各最多 1000                           |
| 布局请求体                             | 512 KiB；最多 1000 条关系             |
| 首屏 / 异步 JavaScript gzip            | 400 / 500 KiB；由 `just perf-ci` 检查 |

世界快照包含完整且有界的 Lab，不提供 Entity cursor。列表和历史使用各自文档规定的 cursor。`scripts/perf/baselines.json` 登记确定性预算。慢客户端 Router 检查独立于浏览器计时验证积压合同。

FPS、HTTP 延迟和内存采样只描述本次浏览器与硬件，不是跨机器门槛或内存泄漏证据。本次模型文件很小，不能据此预测大型扫描模型或大纹理的表现。

## 继续接入真实设备

Foundation V1 已交付持久世界、内置虚拟程序、Member/Agent 共用 API、恢复、历史和生命周期。已接受预览提供视觉基准。正式流程没有时间倍率或场景工具条。

真实协议、机器人运动、用户代码、自主实验规划和科学仿真仍属后续范围。真实设备应登记为独立 Entity，模拟与真实观测及记录始终分开。后续适配器须保留来源身份、属性时间与质量、命令幂等，以及 Run 中断后的显式恢复。见[产品范围](../architecture/lab-word.md)和 [ADR 0007](../adr/0007-separate-simulated-and-physical-entity-identities.md)。

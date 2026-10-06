# 编辑布局与登记位置

当前 Node 服务支持本章静态布局与登记关系，不需要先启动照明。源码和验证入口见[Node 世界指南](../guides/server-world.md)；运行态相关旅程仍在迁移。

目标：摆放烧杯、显式登记到工作台，并在第二浏览器保存冲突后保留草稿。复制对象、多节点表示和移除表示分别验证独立身份与恢复。

## 起始版本与本章变更

使用[完整旅程](complete-foundation.md)指定的共同版本。先完成[持久 Lab 与对象](persistent-world.md)及[后端照明](backend-lights.md)。命令在仓库根目录运行。浏览器和脚本都会写入开发数据库。

源码入口是[布局 HTTP](../../crates/app/src/modules/lab/layout.rs)、[对象关系](../../crates/app/src/modules/lab/relationships.rs)、[关系迁移](../../migrations/0022_lab_relationships.sql)、[布局 Inspector](../../packages/views/src/lab/layout-editor.tsx)、[关系表单](../../packages/views/src/lab/relationship-panel.tsx)、[真实三维变换](../../packages/views/src/lab/world-viewport.tsx)和[生成 SDK](../../packages/sdk/src/generated/sdk.gen.ts)。[Lab ownership](../../crates/app/src/modules/lab/module.json)登记新增表、合同、验证和教程。

## 在浏览器摆放并登记

```bash
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/lab>，登录普通 Member，创建 `Layout lab`。分别用 `bench · 1.0` 和 `labware · 1.0`、内置外观登记 `North bench` 与 `Beaker A`。

1. 选择烧杯，切换 **编辑布局**。选择移动、旋转或缩放工具，在画布拖动对应轴；也可在 Inspector 的三维坐标、旋转和缩放输入数值。位置单位为 m，旋转单位为 rad，缩放为倍率。输入支持 Tab、方向键，工具与保存按钮支持键盘焦点和 Enter。
2. 先将烧杯位置设为 `X=0, Y=0.9, Z=0.2` 并 **保存布局**。登记关系仍为空，图形坐标不会证明真实物料已经移动。
3. 在 **登记关系** 选择 **位于**，关系对象选择 `North bench`，点击 **登记关系**，再 **保存布局**。关系显示 **人工登记**、操作者与登记时间。
4. 再修改 X 坐标并保存，人工登记仍指向同一工作台，来源记录保持原样。选择工作台时也可显式登记 **包含** 烧杯。一个对象只能有一个空间容纳对象，位于与包含共同参与环校验。
5. 为同一定义分别登记模拟与真实 Robot，在模拟对象的关系中选择 **模拟对应** 和真实对象，再保存。两个 Entity 身份独立；真实对象仍未接入执行 Binding。

工作台、位置和 Labware 可作为空间容纳对象。自引用、跨 Lab 引用、非法包含环和错误的模拟对应会返回 400，全部改动回滚，页面保留草稿供修改。模拟对应要求模拟对象指向同一定义的真实对象；关系参数变化时取消旧关系并显式登记新关系。

## 区分对象与节点

**复制为独立实例** 即时创建新的 Entity 与节点，保留源定义快照、配置和对象外观；不复制关系、观测或程序运行。先保存当前草稿，再复制。新设备拥有自己的 Binding，程序需要显式启动。

**新增同一对象表示** 在编辑模式加入新节点草稿，Entity id 保持原样；选择具体 **编辑节点** 后只变换该表示。保存后，同一 Entity 可有多个独立 Placement。运行查看中的已有新增表示入口也沿用同一业务规则，即时持久化。

**移除节点** 只把表示从当前草稿移除，保存后对象身份与登记关系仍在。勾选目录的 **仅未放置对象** 找回对象，再新增表示并保存；导入模型的资产元数据随对象保留，原模型可重新加载。

## 两个浏览器制造冲突并恢复

1. 在第二个独立浏览器或隐身窗口登录另一个 Member，打开同一 Lab。两页进入编辑布局，在第一页改烧杯 X，在第二页改工作台 X。
2. 第二页先保存。第一页保存返回 `409 lab.layout_conflict`，显示 **布局已改变，草稿已保留**，烧杯输入保持原值。
3. 点击 **重新载入并保留草稿**，读取最新可比较版本，将本地改动合并到最新布局。未改动节点和其他编辑者新增的节点保留；双方修改同一节点时，显式重试采用本地节点草稿。
4. 点击 **重试保存**，另一浏览器刷新后可看到两个改动。再次发生冲突时继续保留草稿，再重新载入。也可明确选择 **放弃草稿并重新载入** 采用服务器布局。

切换 Lab 或运行查看会保留本页各 Lab 的草稿。未保存草稿只在当前页面内保留，离开或刷新前应保存；跨浏览器恢复的是服务器保存结果。

启动照明后，在编辑模式改坐标，再切换电源。订阅更新设备快照，坐标草稿仍在；保存成功后 Run 与观测保留。布局保存不提交运行态，设备观测不递增 `layout_version`。

## 用 Agent 执行同一业务操作

从设置取得有效的 `lab:full` API 密钥。设置 `LAB_ID` 可继续使用前章 Lab。未设置时，脚本创建一个 Lab。脚本加入工作台、烧杯和模拟/真实 Robot，并验证冲突、非法环后数据不变、独立复制、多表示和移除/放回。

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/edit-layout.mjs
```

预期输出包含 Lab、原烧杯、独立副本 UUID、布局版本和带 `source=manual`、`registered_by`、`registered_at` 的关系。可在浏览器打开该 Lab 查看保存结果；脚本不会打印凭据。

完整请求：

<<< ../../examples/lab/edit-layout.mjs

`PUT /api/v1/lab/labs/{lab_id}/layout` 接受 `expected_version`、完整节点数组和可选的完整关系数组。节点含 `id/entity_id/representation_id/placement`；关系含 `id/source_id/target_id/kind`。省略关系字段保留原关系，`[]` 显式移除所有关系。服务器写入人工来源，客户端不能伪造操作者或登记时间。已有关系 id 的含义保持不变。

`POST .../entities/{entity_id}/copies` 接受 `expected_version/name/placement`，返回新 Entity。会话写入需要 CSRF，Agent 使用有效 Bearer；普通 Member 和 Agent 共用完整 Lab 业务约束。布局载荷上限为 512 KiB，节点及关系各最多 1000；位置/旋转绝对值最多 10000，缩放范围 0.001–1000。

## 验证与下一阶段

```bash
node scripts/test-backend.mjs --test lab_world --test lab_devices
pnpm test:frontend apps/web/src/lab-world.test.tsx
node scripts/e2e.mjs tests/e2e/lab-layout.spec.ts
```

HTTP 使用真实 Router 和隔离 PostgreSQL；页面仅用 MSW 替代 HTTP；浏览器使用真实应用、独立上下文与 WebGL 指针。接下来按[可靠同步与恢复](reliable-sync.md)让两个浏览器和 Agent 观察同一世界，并验证断线恢复与撤权。

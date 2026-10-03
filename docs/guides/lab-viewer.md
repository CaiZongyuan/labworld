# 使用 Lab 与资产库

目标：在正式应用中查看设备模型、导入本地 GLB，并从资产库再次打开。Lab 复用现有身份与应用壳，三维代码按页面加载。

## 正式应用

从仓库根目录启动：

```bash
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/lab>，登录开发账号或从 `/register` 注册。登录和注册后默认进入 Lab。`just dev` 启动平台服务并执行迁移，沿用本地开发数据；它不是隔离测试环境。

1. Lab 主入口创建和打开持久实验室，使用对象目录、场景与 Inspector。完整登记步骤见[持久 Lab 与对象教程](../tutorials/persistent-world.md)。
2. 从资产库选择预置工业显微镜并在 Lab 中打开，进入 `/lab/asset` 单模型预览。旋转、缩放、平移；聚焦保持当前方向，重置恢复初始方向。点击模型选择，点击空白清除选择。
3. 选择或拖入资源完整内嵌的 glTF 2.0 `.glb`，模型自动居中与取景，原始尺度保留。
4. 在资产库导入时填写名称、来源、许可和版本，发布后搜索名称或文件名，打开模型到 Lab，或确认删除未引用资产。
5. 导入损坏文件应显示失败反馈并保留前一个可用模型，随后仍能成功导入有效文件。

资产库与 GLB 字节持久保存在服务器，刷新或换浏览器后可以重新打开；预置示例保持可用。内置定义可查看规格、能力与状态结构，后端虚拟设备运行由后续阶段实现。完整 Member/Agent 导入、失败恢复与文件生命周期见[持久数字资产教程](../tutorials/persistent-assets.md)。旧知识库和文档 URL 保留原有含义。FPS、draw calls、triangles、对象计数和可读的 JS heap 实时观察；GPU 时间当前未采样，对象数量也不表示显存字节数。

源码见[业务组装](../../apps/web/src/app-examples.tsx)、[Lab 贡献](../../packages/views/src/lab/app-example.tsx)和[查看页](../../packages/views/src/lab/lab-view.tsx)。[素材记录](../../assets/README.md)保留原件、运行文件和许可。

```bash
pnpm exec vitest run apps/web/src/lab.test.tsx
pnpm typecheck
node scripts/perf-bundle.mjs
```

页面测试负责目录、导航、导入反馈和移除。真实 WebGL、相机、点选与资源生命周期在浏览器验证。后台启动服务时将日志写在应用监听目录之外，避免控制台输出引发刷新循环。

## 历史 v1 预览

需要 Node、pnpm、桌面 Chrome，以及本地的 `.scratch/lab-viewer/v1/`。完整版本由本地 `preview/lab-viewer-v1` 分支保存，提交为 `9439a1de78c5433795d22a03e3e6086540832794`。它不在主分支的源码目录内；只有主分支时不能执行下述启动命令。此预览分支当前保存在本地，线上可用性需在实际发布后核对。

已有版本目录时，从仓库根目录执行：

```bash
pnpm --dir .scratch/lab-viewer/v1 install --frozen-lockfile
pnpm --dir .scratch/lab-viewer/v1 dev
```

默认打开 <http://127.0.0.1:5190/prototype/lab-viewer>，端口占用时以 Vite 输出为准。该入口不需要 API 或数据库，不写入正式应用数据。

如果本地分支存在但版本目录缺失，可在独立工作树取得预览：

```bash
git worktree add ../lab-word-preview preview/lab-viewer-v1
pnpm --dir ../lab-word-preview/.scratch/lab-viewer/v1 install --frozen-lockfile
pnpm --dir ../lab-word-preview/.scratch/lab-viewer/v1 dev
```

## 观察一次完整操作

1. 首次打开应看到显微镜及环境光照，不是空白画布。
2. 旋转、缩放、平移，再聚焦或重置视角；点击设备查看静态资产信息，点击空白清除选择。
3. 用文件选择或拖拽导入资源内嵌的 glTF 2.0 `.glb`，新模型自动居中与取景。
4. 导入无效文件或引用缺失资源的 GLB，应出现明确失败反馈并保留前一个可用模型；随后仍能成功导入有效 GLB。
5. 查看 FPS、draw calls、triangles 与资源计数。JS heap 和 GPU 时间不同于对象数量；不可获取的指标显示不可用。

本地文件仅用于当前浏览器会话，不上传到服务端；刷新不保证恢复导入文件。v1 每次查看一个模型，尚无场景摆放编辑。

## 资产与证据

预置设备为 Poly Haven 的 [Industrial Microscope](https://polyhaven.com/a/industrial_microscope)，作者 Lukas Walzer，CC0；环境为 [Studio Small 03](https://polyhaven.com/a/studio_small_03)，作者 Greg Zaal，CC0。来源、原始文件和运行 GLB/HDR 随预览版本保存。

此前 Chromium/SwiftShader 已验证实际渲染、导入、选择、相机和错误恢复。软件渲染的 FPS 不是实际 GPU 性能验收；预览包体也不是生产预算结果。[体验记录](../ui/lab-viewer-experience.md)保留具体范围与证据。

账户与模板导航为模拟，v1 画面已接受。用户进一步要求主业务导航使用 Lab 与资产库，既有知识库路由保留兼容。正式应用的路由、导入生命周期与[公开验证](../testing/t01-feedback-loop.md)仍需完成验收，范围见[产品架构](../architecture/lab-word.md)。

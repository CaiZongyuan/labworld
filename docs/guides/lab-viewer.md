# 运行 Lab Viewer 预览

目标：观察真实设备模型，导入自己的 GLB 并验证相机、选择与失败恢复。该指南针对已接受的 v1 隔离预览；正式应用的 Lab 集成验收另行记录。

## 前提与版本

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

# 导出原 Newton 场景并采集真实状态

本章使用仓库中的 `tools/newton-source/cli.py`，读取原 IsaacLabTutorial 的 SO-101 场景和已有策略。工具创建自己的输出目录，原项目、Python 环境和 checkpoint 保持只读。它不登记 Lab Source、不连接 Server，也不训练策略。

需要已有的 Linux/WSL Isaac Lab 环境及原 checkpoint。实际验证使用 Python 3.12、Isaac Lab 3.0.0、Newton 1.6.0rc1、Warp 1.17.0、MuJoCo/MJWarp 3.12.0、RSL-RL 5.4.1和 CUDA GPU。USD 导出还需要 Blender；本次使用 Windows Blender 5.4.0 Alpha。普通 Node/Web 启动不需要这些依赖。

## 取得当前源状态

在仓库根执行。将以下路径换成已有输入。`capture`只执行三次原策略推理和实际求解，然后停止自己创建的程序。

```bash
SOURCE_PYTHON=/path/to/IsaacLabTutorial/.venv/bin/python
SOURCE_PROJECT=/path/to/IsaacLabTutorial
SOURCE_CHECKPOINT=/path/to/model_799.pt
SOURCE_BLENDER=/path/to/blender

"$SOURCE_PYTHON" -B tools/newton-source/cli.py capture \
  --project "$SOURCE_PROJECT" --checkpoint "$SOURCE_CHECKPOINT" \
  --steps 3 --output .scratch/source-capture
```

成功时返回 `snapshot`和`baseline`路径。检查 `samples.jsonl`：首次 `post-reset`是有效初态，后三次 `post-step`的源时间分别为33,333,333、66,666,667和100,000,000纳秒。它们是源仿真时钟，不是墙钟。

`native-witness.jsonl`通过 Isaac Lab 的 articulation和rigid-object观测接口独立读取同刻变换。`native-model.json`保存稳定路径和关节类型。原场景有六个旋转关节、一固定关节和两个自由关节，共20个原始坐标。可用于 Motion 的六个旋转坐标以弧度表达；自由刚体运动由 body pose表达，完整原始值按 joint key保留。

模型就绪事件不等于有效初态。采样器使用正式 RecorderTerm 的 reset/step hooks，并在读取时完成需要的 FK。它在首次策略步之前保存 authored baseline，后续实际运动不会改写该基准。

要在已有 player 的启动入口组合采样器，先把 `tools/newton-source` 加入 Python 模块路径。在创建环境之前设置 `cfg.recorders = source_adapter.recorders(output_directory, metadata_path, source_run_id)`。player 必须提供输出目录并负责清理。此工厂配置正式 RecorderTerms；仅导入模块不会安装采样器。独立 `capture` 命令执行这项配置，并管理自己的输出账本。

## 导出 Web 表示

```bash
"$SOURCE_PYTHON" -B tools/newton-source/cli.py export \
  --scene .scratch/source-capture/source-baseline.usdc \
  --snapshot .scratch/source-capture/current-snapshot.json \
  --source-id 7e99f905-7839-4bf2-80f6-001102031989 \
  --blender "$SOURCE_BLENDER" --output .scratch/source-export

python3 -B tools/newton-source/cli.py validate \
  --manifest .scratch/source-export/scene.json
```

`source-id`是独立世界的持久来源标识。这里的示例值不是凭据。导出不会向 Server授权或创建身份。

原场景输出 Robot、Vial、Rack和Mat四个对象。Robot有七个component；Vial、Rack、Mat各有一个。十个 GLB以component局部原点组织，当前世界位置单独存于 `initial_state`。静态Mat也会导出，不依赖它具有物理body。

带 `source_run_id` 的实际初态必须包含全部受支持的关节坐标。省略 `--snapshot` 时，导出只描述 authored 位姿，source run/time 保持 null，关节状态保持未知；不会用零关节值充当当前观测。

清单保存完整原路径、层级、purpose与visibility。原输入的65个mesh分为32个可见外观、32个guide和1个隐藏mesh。后两类保留分类，GLB不将它们画成普通外观。材质采用 USD Preview Surface或常量PBR近似，灯光由 Web呈现。复杂MDL程序不声称无损转换。

`body_to_visual`补偿现有 Viewer的居中和底边对齐。不要同时把源世界位姿烘进GLB，再给Scene Node应用同一位姿。`scene_hash`包括基准结构、静态摆放、物理声明及资源校验值；当前状态和源时间不参与结构hash。

## 场景摘要合同

清单必须声明 `scene_hash_algorithm: "labworld-scene-f64hex-v1"`。SHA-256 输入依次为 ASCII 算法标识、一个 NUL 字节，以及下表编码结果的紧凑 ASCII JSON。输出为 `sha256:` 加小写摘要 hex。内容保留除 `scene_hash`、`source_id`、`initial_state` 和 `provenance` 外的全部顶层字段，包括算法字段。丢弃字段或填默认值之前，先校验完整内容。

| 输入    | 带类型的编码                                                     |
| ------- | ---------------------------------------------------------------- |
| null    | `["null"]`                                                       |
| boolean | `["bool","true"]` 或 `["bool","false"]`                          |
| string  | `["str", UTF8hex(value)]`                                        |
| number  | `["num", float64BigEndianHex(value)]`                            |
| array   | `["array", [tag(element), ...]]`，保留顺序                       |
| object  | `["object", [[UTF8hex(key), tag(value)], ...]]`，按 key hex 排序 |

hex 使用小写且无前缀；number hex 固定为 16 位。正负零统一为正零。数值必须是有限 binary64；绝对值超过 2⁵³−1 的整数值一律拒绝，包括值为整数的浮点数。字符串和 key 必须是 Unicode 标量，拒绝未配对 surrogate，不改写 Unicode。最终 JSON 只含字符串和数组，因此十进制拼写和 JSON key 枚举顺序不会改变摘要。普通清单、Blender 任务 JSON 与资源字节 SHA-256 分别处理；校验拒绝其他算法标识。跨语言示例见 [golden vectors](../../tests/fixtures/source/scene-hash-v1.json) 和 [独立 Node reader](../../tests/support/source-scene-hash-oracle.mjs)。

## 提供资产引用

通过 `--metadata source-metadata.json`声明稳定对象key及精确资产引用。没有引用时，业务类别和能力保持未知。

```json
{
  "root_path": "/World/envs/env_0",
  "objects": [
    {
      "source_path": "/World/envs/env_0/Robot",
      "object_key": "Robot",
      "asset_ref": { "asset_id": "example/so101", "version": "1.0.0" },
      "asset_description": "assets/so101.json"
    }
  ]
}
```

描述文件相对metadata文件定位。其 `asset_id/version`必须与引用相符。工具复制描述及显式 `resources`清单中的文件，并保存校验值。完整业务schema由资产导入接口验证；本工具不从网格猜测设备能力或生成实际观测。仅提供引用时，可以省略 `asset_description`，但下游必须能解析精确版本。

## 验证与恢复

正式GLB解码和独立USD几何核验入口：

```bash
LAB_WORLD_SOURCE_PYTHON="$SOURCE_PYTHON" node scripts/verify-newton-source-geometry.mjs \
  .scratch/source-capture/source-baseline.usdc \
  .scratch/source-export/scene.json .scratch/source-export/geometry-report.json
```

检查报告的32个可见source path及逐顶点匹配。完整资源校验成功不代表抓放任务成功、GUI暂停正确或浏览器已同步。

用错误源路径执行一次 `export`。工具应返回具体失败路径，且不会产生有效 `scene.json`。恢复原输入后，使用新的输出目录重试。已有目录不会被覆盖，失败输出及其账本保留供诊断。

`--reset-after 2`可检查原环境的明确reset：旧episode末态在 `pre-reset`保存，新 `post-reset`使用新episode标识并清除旧结果。全局源时间继续，不能跨reset插值。没有明确成功报告时，结果保持unknown。

每次运行在输出目录写 `owned-resources.json`。缓存默认也在输出目录内；`--cache-directory`可引用明确拥有的已有缓存，并记录本次消费者。Ctrl+C、超时和失败会停止本次创建的进程，保留输出和缓存；不清理其他项目或共享缓存。工具中的 RecorderTerm只观察，外部程序由其启动方管理。

若启动工具本身被强行终止，先执行 `python3 -B tools/newton-source/cli.py cleanup --output <本次输出目录>`。此入口只处理账本中身份仍匹配的自有进程，并保留证据和缓存；不接受其他owner的目录。Linux恢复还核对进程启动标识，避免PID复用。Windows进程在WSL模式下按本次Blender任务路径核对。

Windows 清理要求 `PATH` 中有 `powershell.exe`。工具先核对已记录的 Blender PID 和任务路径，停止后再次查询该身份。shell 返回成功不能代替实际进程核对。停止或查询失败时返回 `resource_cleanup_incomplete`，账本保留 `reconciled: false`、owner、保留用途及进程凭据。保留该目录，解决报告中的问题后重试 `cleanup`。只有核对成功后才能删除自有证据或缓存。

实现入口：[CLI](../../tools/newton-source/cli.py)、[源采样hook](../../tools/newton-source/source_adapter.py)、[场景导出](../../tools/newton-source/scene.py)。后续来源登记和共享观察使用同一清单及实际状态，分别验收。

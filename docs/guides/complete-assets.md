# 导入完整资产版本

目标：把设备资料和模型表示发布为固定 Asset Version，再登记两个独立设备实例。建模与场景编写在 Blender、Isaac Sim/Isaac Lab 或 Newton 中完成。本指南只管理资料与资源，不产生设备观测或开启控制。

需要已经运行的 Lab World Server、登录账号和带 `lab:full` 的 API 密钥。按[快速开始](../getting-started/quickstart.md)启动应用。以下命令在仓库根目录执行，会向当前服务写入资产。

## 发布第一个版本

1. 在 **API 密钥** 页面创建带 `lab:full` 的密钥。
2. 在 Bash 隐藏输入处输入密钥，然后执行示例：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/import-asset-version.mjs examples/lab/centrifuge.asset.json
```

脚本打印固定版本 ID、资产 ID、版本和内容摘要。再次执行相同描述会返回原版本，即使资源获得新的文件 ID。脚本只清理自己创建的上传回执；已发布版本继续持有资源。

3. 打开资产库，找到 **示例离心机 C**，点击 **查看资产信息**。

资料包含型号、规格、配置字段、状态字段及单位、能力说明和表示资源。例子的几何是仓库立方体，型号资料也仅供教程使用。它不是离心机模型或仿真。当前转速和温度保持未知。

<<< ../../examples/lab/centrifuge.asset.json

示例描述的 `resources[].file` 只供上传脚本读取本地文件。脚本转换为正式接口要求的 `file_id`、`sha256`、`size` 和 `format`。Server 不读取作者的本机路径。

## 登记两个实例

保留上面的环境变量，运行：

```bash
node examples/lab/register-asset-instances.mjs
```

脚本新建教学 Lab，登记离心机 A、B，再通过 `GET world` 核对不同 ID、4 和 20 的独立配置，以及 `binding=null`、`observation=null`。它打印 Lab 和实例 ID，不打印密钥。每次执行创建一份新的教学 Lab。

<<< ../../examples/lab/register-asset-instances.mjs

把资产 ID 和精确版本用于 `POST /api/v1/lab/labs/{lab_id}/entities`：

```json
{
  "name": "离心机 A",
  "definition_id": "tutorial/centrifuge-c",
  "definition_version": "1.0.0",
  "reality": "simulated",
  "configuration": { "initial_temperature": 4 }
}
```

为离心机 B 再调用一次，使用不同名称和温度，例如 20。两个 Entity 有不同 ID，分别持有配置与观测。省略 `representation_id` 时采用版本的 Web 表示；资源可复用，但实例身份不合并。

完整定义不会自动绑定内置离心机程序。额定 15000 rpm 和初始温度不是实际测量。没有来源报告时观测为空，能力说明也不授予执行权限。

## 发布新版本或恢复失败

修改描述、模型或状态结构时，显式改版本再发布。旧 Entity 和 Recording 保留原版本，升级不自动覆盖它们。

保留 `1.0.0`，只修改示例的型号后重新运行脚本。Server 返回 `409 lab.asset_version_conflict`，资产库中的旧资料保持不变。恢复原描述后重试，或发布明确的新版本。

资源缺失、摘要不匹配、无效 GLB、错误表示用途或不支持的字段规则返回具体失败。完整版本尚未发布，旧版本仍可读。取消使用 `DELETE /api/v1/lab/asset-resource-uploads/{upload_id}`，只释放该回执的引用，其他版本和录制引用继续保护字节。

## 接口和验证范围

| 接口                                                           | 用途                                          |
| -------------------------------------------------------------- | --------------------------------------------- |
| `POST /api/v1/lab/asset-resource-uploads`                      | 取得单个资源的上传能力                        |
| `POST /api/v1/lab/asset-resource-uploads/{id}/complete`        | 验证字节并暂存资源                            |
| `POST /api/v1/lab/asset-versions`                              | 原子发布描述和全部资源引用                    |
| `GET /api/v1/lab/asset-versions`                               | 分页查询；可用 `asset_id`、`version` 精确筛选 |
| `GET /api/v1/lab/asset-versions/{id}`                          | 读取固定定义、表示和资源                      |
| `GET /api/v1/lab/asset-versions/{id}/resources/{key}/download` | 取得短期下载能力                              |

Member 和 full-access Agent 管理组织共享的资源回执与版本。来源 Machine 不具有这些权限。资产库也可导入已经引用服务端资源的 JSON 描述文件；它提供导入与只读查询，不提供业务资料编辑器。

描述上限为 192 KiB，每版本最多 128 个资源和 32 个表示，每表示最多 128 个组件。配置和状态使用有明确 `type` 的嵌套 JSON Schema，支持 `properties`、`required`、布尔 `additionalProperties`、`items`、`enum`、`const`、数值/长度/数量上下限，以及 `title`、`description`、`default`、`unit` 注解。不支持的关键字明确拒绝，包括外部和递归引用。实例配置通过所采用的定义校验；默认值不写成测量。

GLB 经过现有完整解码校验。JSON 必须可解析。PDF 和 USD 验证格式头，URDF 仅保存为未验证的表示。资源的 `verification` 字段保留这个范围；保存物理描述不代表 Server 能加载或运行它。表示资源仍受现有文件与 GLB 展开预算限制。

[公开 HTTP 测试](../../tests/server/asset-versions.test.ts)验证固定版本、两实例、冲突、重试、失败取消及录制资料保留。[真实浏览器测试](../../tests/e2e/lab-complete-assets.spec.ts)验证导入、资料、下载和冲突恢复。
